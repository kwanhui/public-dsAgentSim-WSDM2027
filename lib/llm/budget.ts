// Global daily spend guard. The deployment's spend today (UTC) is computed
// from the tokens the app already meters: persona and client-reaction turns
// on messages rows, and analyst steps, consistency audits and judge calls on
// events rows. Each is priced by the model that role runs on (lib/llm/prices).
//
// LLM_DAILY_BUDGET_USD sets the limit. Unset or empty means no limit, which
// is the local default; the recommended production value for the public demo
// is 5. A value that is set but not a number stops startup
// (lib/env-guard.ts). Once today's spend reaches it, the routes that call a
// model (chat, gate submission, analyst runs, sandbox join) refuse with HTTP
// 429 until 00:00 UTC, and each refusal is logged on the engagement as a
// budget_refused event.
//
// A sandbox cohort (sandbox.openJoin) also has its own daily limit,
// sandbox.dailyBudgetUsd (default USD 2), counted over that cohort's
// engagements only, so anonymous visitors cannot use up the budget that the
// course and showcase cohorts share (checkCohortBudget).
//
// The spend is cached for SPEND_CACHE_MS so a busy minute costs one pair of
// aggregate queries rather than one per call. The guard can therefore let
// through up to a minute of calls past the limit; the per-call output caps
// (lib/llm/limits.ts) bound how far that goes.

import { NextResponse } from "next/server";
import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { engagements, events, messages, rubricScores } from "@/lib/db/schema";
import { guardPriceFor, isMockModel, readoutPriceFor, tokenCostUsd } from "@/lib/llm/prices";
import { dailyBudgetUsd } from "@/lib/llm/budget-config";
import { budgetRefusalMessage, nextUtcMidnight, type BudgetAudience, type BudgetRefusalKind } from "@/lib/llm/budget-format";

/** The refusal a learner sees, in UTC; the workspace rewrites it in the
 * learner's local time from resetsAtIso. */
export const BUDGET_MESSAGE = budgetRefusalMessage("chat", null);

export const BUDGET_REFUSED_EVENT = "budget_refused";

export const SPEND_CACHE_MS = 60_000;

export interface TokenPair {
  prompt: number;
  completion: number;
}

/** Tokens metered since the start of the UTC day, split by the model side
 * that spent them. Persona side: personas, client reactions, analyst steps.
 * Judge side: rubric judge and consistency auditor. */
export interface TokenTotals {
  persona: TokenPair;
  judge: TokenPair;
  /** The analyst agent's own calls, a part of persona. The guard prices them
   * with the persona side; the instructor readout prices them at the
   * analyst's recorded model, which can differ (A2 ran on Haiku 4.5). */
  analyst?: TokenPair;
}

export { dailyBudgetUsd };

export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function spendUsd(
  totals: TokenTotals,
  models: { persona: string; judge: string },
): number {
  return (
    tokenCostUsd(guardPriceFor(models.persona), totals.persona.prompt, totals.persona.completion) +
    tokenCostUsd(guardPriceFor(models.judge), totals.judge.prompt, totals.judge.completion)
  );
}

// Event types whose promptTokens/completionTokens were spent on the judge
// model. Every other event carrying those fields (analyst steps) spent them
// on the persona model. judgePromptTokens/judgeCompletionTokens are always
// judge-side.
const JUDGE_SIDE_EVENTS = new Set(["persona_consistency"]);

// Event types whose tokens the analyst agent spent (on the persona side for
// the guard, on the analyst's own model for the readout).
const ANALYST_SIDE_EVENTS = new Set(["analyst_step", "analyst_step_failed", "analyst_stage_failed"]);

interface EventTokenRow {
  type: string;
  prompt: number | string | null;
  completion: number | string | null;
  judgePrompt: number | string | null;
  judgeCompletion: number | string | null;
}

export function totalsFromRows(
  messageRow: { prompt: number | string | null; completion: number | string | null },
  eventRows: EventTokenRow[],
): TokenTotals {
  const n = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
  const totals: TokenTotals = {
    persona: { prompt: n(messageRow.prompt), completion: n(messageRow.completion) },
    judge: { prompt: 0, completion: 0 },
    analyst: { prompt: 0, completion: 0 },
  };
  for (const row of eventRows) {
    const side = JUDGE_SIDE_EVENTS.has(row.type) ? totals.judge : totals.persona;
    side.prompt += n(row.prompt);
    side.completion += n(row.completion);
    if (ANALYST_SIDE_EVENTS.has(row.type) && totals.analyst) {
      totals.analyst.prompt += n(row.prompt);
      totals.analyst.completion += n(row.completion);
    }
    totals.judge.prompt += n(row.judgePrompt);
    totals.judge.completion += n(row.judgeCompletion);
  }
  return totals;
}

// jsonb number fields, summed only where the field really is a number.
const jsonNum = (key: string) =>
  sql<string>`coalesce(sum(case when jsonb_typeof(${events.detailJson} -> ${key}) = 'number' then (${events.detailJson} ->> ${key})::numeric else 0 end), 0)`;

export async function fetchTokenTotalsSince(since: Date): Promise<TokenTotals> {
  const sinceIso = since.toISOString();
  const [messageRow] = await db
    .select({
      prompt: sql<string>`coalesce(sum(${messages.promptTokens}), 0)`,
      completion: sql<string>`coalesce(sum(${messages.completionTokens}), 0)`,
    })
    .from(messages)
    .where(gte(messages.timestampIso, sinceIso));
  const eventRows = await db
    .select({
      type: events.type,
      prompt: jsonNum("promptTokens"),
      completion: jsonNum("completionTokens"),
      judgePrompt: jsonNum("judgePromptTokens"),
      judgeCompletion: jsonNum("judgeCompletionTokens"),
    })
    .from(events)
    .where(gte(events.timestampIso, sinceIso))
    .groupBy(events.type);
  return totalsFromRows(messageRow ?? { prompt: 0, completion: 0 }, eventRows);
}

// ---------------------------------------------------------------------------
// Spend per engagement and per cohort, for the instructor's readout. Same
// token fields, same side split (totalsFromRows) and same prices (spendUsd)
// as the daily guard, grouped by engagement instead of summed for the day,
// so the readout and the guard cannot disagree about what a call cost.
// ---------------------------------------------------------------------------

export interface SpendScope {
  cohortId?: string;
  engagementIds?: string[];
  since?: Date;
}

/** Token totals per engagement id, for the engagements in scope. */
export async function fetchTokenTotalsByEngagement(scope: SpendScope): Promise<Map<string, TokenTotals>> {
  if (scope.engagementIds && scope.engagementIds.length === 0) return new Map();
  const sinceIso = scope.since?.toISOString();
  const engagementFilter = (column: typeof messages.engagementId | typeof events.engagementId): SQL[] => [
    ...(scope.engagementIds ? [inArray(column, scope.engagementIds)] : []),
    ...(scope.cohortId ? [eq(engagements.cohortId, scope.cohortId)] : []),
  ];
  const messageRows = await db
    .select({
      engagementId: messages.engagementId,
      prompt: sql<string>`coalesce(sum(${messages.promptTokens}), 0)`,
      completion: sql<string>`coalesce(sum(${messages.completionTokens}), 0)`,
    })
    .from(messages)
    .innerJoin(engagements, eq(engagements.id, messages.engagementId))
    .where(
      and(
        ...engagementFilter(messages.engagementId),
        ...(sinceIso ? [gte(messages.timestampIso, sinceIso)] : []),
      ),
    )
    .groupBy(messages.engagementId);
  const eventRows = await db
    .select({
      engagementId: events.engagementId,
      type: events.type,
      prompt: jsonNum("promptTokens"),
      completion: jsonNum("completionTokens"),
      judgePrompt: jsonNum("judgePromptTokens"),
      judgeCompletion: jsonNum("judgeCompletionTokens"),
    })
    .from(events)
    .innerJoin(engagements, eq(engagements.id, events.engagementId))
    .where(
      and(...engagementFilter(events.engagementId), ...(sinceIso ? [gte(events.timestampIso, sinceIso)] : [])),
    )
    .groupBy(events.engagementId, events.type);

  const ids = new Set([...messageRows.map((r) => r.engagementId), ...eventRows.map((r) => r.engagementId)]);
  const out = new Map<string, TokenTotals>();
  for (const id of ids) {
    const m = messageRows.find((r) => r.engagementId === id) ?? { prompt: 0, completion: 0 };
    out.set(
      id,
      totalsFromRows(
        m,
        eventRows.filter((r) => r.engagementId === id),
      ),
    );
  }
  return out;
}

export interface SpendReadout {
  /** USD per engagement id; an engagement with no metered call is absent. */
  byEngagement: Map<string, number>;
  totalUsd: number;
  /** The deployment's current model ids, used for any engagement that
   * recorded no served model. Each engagement is otherwise priced per side
   * at the model its events record: personas, the analyst agent, and the
   * judge and auditor. */
  models: { persona: string; judge: string };
  /** True when every engagement in scope ran on the offline mock, so the
   * readout can say the zero is not a measurement of a paid run. */
  allMock: boolean;
}

// Event types that record the model a call ran on, by side. The served id
// (what the provider reported) wins over the configured one. The analyst
// agent is its own side: an agent run can use a different model from the
// personas it questions.
const PERSONA_MODEL_EVENTS = ["persona_turn", "client_reaction", "persona_failed"];
const ANALYST_MODEL_EVENTS = ["analyst_step", "analyst_step_failed"];
const JUDGE_MODEL_EVENTS = ["submission_scored", "persona_consistency"];

type RecordedSides = { persona?: string; judge?: string; analyst?: string };

/** The model each engagement's calls ran on, per side, from the events that
 * record it (the most frequent value wins). Pure. */
export function recordedModels(
  rows: { engagementId: string; type: string; served: string | null; configured: string | null; n: number }[],
): Map<string, RecordedSides> {
  const tally = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const model = r.served || r.configured;
    if (!model) continue;
    const side = PERSONA_MODEL_EVENTS.includes(r.type)
      ? "persona"
      : ANALYST_MODEL_EVENTS.includes(r.type)
        ? "analyst"
        : JUDGE_MODEL_EVENTS.includes(r.type)
          ? "judge"
          : null;
    if (!side) continue;
    const key = `${r.engagementId}|${side}`;
    const counts = tally.get(key) ?? new Map<string, number>();
    counts.set(model, (counts.get(model) ?? 0) + Number(r.n));
    tally.set(key, counts);
  }
  const out = new Map<string, RecordedSides>();
  for (const [key, counts] of tally) {
    const [engagementId, side] = key.split("|") as [string, keyof RecordedSides];
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.set(engagementId, { ...(out.get(engagementId) ?? {}), [side]: top });
  }
  return out;
}

async function fetchRecordedModels(ids: string[]): Promise<Map<string, RecordedSides>> {
  if (ids.length === 0) return new Map();
  const served = sql<string | null>`${events.detailJson} ->> 'servedModel'`;
  const configured = sql<string | null>`coalesce(${events.detailJson} ->> 'model', ${events.detailJson} ->> 'judgeModel')`;
  const rows = await db
    .select({
      engagementId: events.engagementId,
      type: events.type,
      served,
      configured,
      n: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(
      and(
        inArray(events.engagementId, ids),
        inArray(events.type, [...PERSONA_MODEL_EVENTS, ...ANALYST_MODEL_EVENTS, ...JUDGE_MODEL_EVENTS]),
      ),
    )
    .groupBy(events.engagementId, events.type, served, configured);
  // Score rows name the judge model even for runs whose events predate the
  // model stamp.
  const judgeRows = await db
    .select({
      engagementId: rubricScores.engagementId,
      model: sql<string>`coalesce(${rubricScores.servedModel}, ${rubricScores.judgeModel})`,
      n: sql<number>`count(*)::int`,
    })
    .from(rubricScores)
    .where(inArray(rubricScores.engagementId, ids))
    .groupBy(rubricScores.engagementId, sql`coalesce(${rubricScores.servedModel}, ${rubricScores.judgeModel})`);
  return recordedModels([
    ...rows,
    ...judgeRows.map((r) => ({ engagementId: r.engagementId, type: "submission_scored", served: r.model, configured: null, n: r.n })),
  ]);
}

/** For a run whose persona model was never recorded (runs from before the
 * stamp), the persona model its provider ran by default, read from the judge
 * model it recorded. Null when that says nothing (no judge, or the mock). */
export function inferredPersonaModel(judge: string | undefined): string | null {
  if (!judge || isMockModel(judge)) return null;
  if (judge.startsWith("claude-")) return "claude-sonnet-5";
  if (judge.startsWith("gpt-")) return "gpt-4o-mini";
  return null;
}

/** USD for one engagement's tokens at the models that served them: the
 * persona calls at the persona model, the analyst agent's calls at the
 * analyst model (the persona model when none is recorded), and the judge
 * and auditor calls at the judge model. */
export function readoutUsd(totals: TokenTotals, models: { persona: string; judge: string; analyst?: string }): number {
  const analyst = totals.analyst ?? { prompt: 0, completion: 0 };
  return (
    tokenCostUsd(
      readoutPriceFor(models.persona),
      totals.persona.prompt - analyst.prompt,
      totals.persona.completion - analyst.completion,
    ) +
    tokenCostUsd(readoutPriceFor(models.analyst ?? models.persona), analyst.prompt, analyst.completion) +
    tokenCostUsd(readoutPriceFor(models.judge), totals.judge.prompt, totals.judge.completion)
  );
}

/** USD spent per engagement and in total for a scope, at list prices for
 * the model that served each engagement where the events record it, and at
 * the deployment's current models otherwise. The offline mock is USD 0. */
export async function spendReadout(scope: SpendScope, deps: Pick<BudgetDeps, "models"> = {}): Promise<SpendReadout> {
  const totals = await fetchTokenTotalsByEngagement(scope);
  const models = deps.models ? deps.models() : await defaultModels();
  const recorded = deps.models ? new Map() : await fetchRecordedModels([...totals.keys()]).catch(() => new Map());
  const byEngagement = new Map<string, number>();
  let totalUsd = 0;
  let allMock = true;
  for (const [id, t] of totals) {
    const r = (recorded.get(id) ?? {}) as RecordedSides;
    const persona = r.persona ?? inferredPersonaModel(r.judge) ?? r.analyst ?? models.persona;
    const priced = {
      persona,
      judge: r.judge ?? models.judge,
      analyst: r.analyst ?? persona,
    };
    if (!isMockModel(priced.persona) || !isMockModel(priced.judge)) allMock = false;
    const usd = readoutUsd(t, priced);
    byEngagement.set(id, usd);
    totalUsd += usd;
  }
  if (totals.size === 0) allMock = isMockModel(models.persona);
  return { byEngagement, totalUsd, models, allMock };
}

export { formatUsd } from "@/lib/llm/budget-format";

/** Today's spend as a share of the daily budget, rounded to two decimals, or
 * null when no budget is set. Reported by /api/health. */
export async function todaySpendRatio(deps: BudgetDeps = {}): Promise<number | null> {
  const limit = dailyBudgetUsd(deps.env ?? process.env);
  if (limit === null) return null;
  const spend = await todaysSpendUsd(deps);
  if (limit === 0) return spend > 0 ? 1 : 0;
  return Math.round((spend / limit) * 100) / 100;
}

let cache: { dayStartMs: number; spend: number; computedAtMs: number } | null = null;

/** Clears the cached spend. For tests, and after a limit change. */
export function resetSpendCache(): void {
  cache = null;
  cohortCache.clear();
}

export interface BudgetDeps {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchTotals?: (since: Date) => Promise<TokenTotals>;
  models?: () => { persona: string; judge: string };
}

async function defaultModels(): Promise<{ persona: string; judge: string }> {
  // Imported lazily: the LLM client pulls in the provider SDKs, which the
  // guard needs only for their model names.
  const { personaModelName, rubricModelName } = await import("@/lib/llm/client");
  return { persona: personaModelName(), judge: rubricModelName() };
}

/** Today's spend in USD, cached for SPEND_CACHE_MS within the same UTC day. */
export async function todaysSpendUsd(deps: BudgetDeps = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const dayStart = utcDayStart(now);
  if (
    cache &&
    cache.dayStartMs === dayStart.getTime() &&
    now.getTime() - cache.computedAtMs < SPEND_CACHE_MS
  ) {
    return cache.spend;
  }
  const totals = await (deps.fetchTotals ?? fetchTokenTotalsSince)(dayStart);
  const models = deps.models ? deps.models() : await defaultModels();
  const spend = spendUsd(totals, models);
  cache = { dayStartMs: dayStart.getTime(), spend, computedAtMs: now.getTime() };
  return spend;
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; message: string; spendUsd: number; limitUsd: number; scope?: "global" | "sandbox" };

export async function checkDailyBudget(deps: BudgetDeps = {}): Promise<BudgetCheck> {
  const limit = dailyBudgetUsd(deps.env ?? process.env);
  if (limit === null) return { ok: true };
  const spend = await todaysSpendUsd(deps);
  if (spend >= limit) return { ok: false, message: BUDGET_MESSAGE, spendUsd: spend, limitUsd: limit };
  return { ok: true };
}

/** The 429 the model-calling routes send once the day's budget is spent.
 * resetsAtIso lets the workspace name the reset in the learner's own time. */
export function budgetExceededResponse(
  kind: BudgetRefusalKind = "chat",
  now: Date = new Date(),
  audience: BudgetAudience = "course",
): NextResponse {
  return NextResponse.json(
    {
      error: "daily-budget-exhausted",
      message: budgetRefusalMessage(kind, null, audience),
      resetsAtIso: nextUtcMidnight(now).toISOString(),
    },
    { status: 429 },
  );
}

// ---------------------------------------------------------------------------
// Per-cohort limit for sandbox cohorts.
// ---------------------------------------------------------------------------

export interface CohortBudgetInput {
  id: string;
  config: { sandbox: { openJoin: boolean; dailyBudgetUsd?: number | null } };
}

/** The sandbox limit that applies to a cohort, or null for a course cohort
 * (or a sandbox with the limit switched off by setting it to null). */
export function sandboxLimitUsd(cohort: CohortBudgetInput): number | null {
  if (!cohort.config.sandbox.openJoin) return null;
  const v = cohort.config.sandbox.dailyBudgetUsd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

const cohortCache = new Map<string, { dayStartMs: number; spend: number; computedAtMs: number }>();

/** Today's spend in one cohort, priced as the guard prices it, cached like
 * todaysSpendUsd. */
export async function cohortSpendTodayUsd(
  cohortId: string,
  deps: BudgetDeps & { fetchCohortTotals?: (cohortId: string, since: Date) => Promise<TokenTotals[]> } = {},
): Promise<number> {
  const now = deps.now ?? new Date();
  const dayStart = utcDayStart(now);
  const hit = cohortCache.get(cohortId);
  if (hit && hit.dayStartMs === dayStart.getTime() && now.getTime() - hit.computedAtMs < SPEND_CACHE_MS) {
    return hit.spend;
  }
  const totals = deps.fetchCohortTotals
    ? await deps.fetchCohortTotals(cohortId, dayStart)
    : [...(await fetchTokenTotalsByEngagement({ cohortId, since: dayStart })).values()];
  const models = deps.models ? deps.models() : await defaultModels();
  const spend = totals.reduce((sum, t) => sum + spendUsd(t, models), 0);
  cohortCache.set(cohortId, { dayStartMs: dayStart.getTime(), spend, computedAtMs: now.getTime() });
  return spend;
}

/**
 * The budget check for a learner or agent call in a cohort: a sandbox
 * cohort's own limit first, then the deployment's daily limit, which caps
 * the whole bill. A course cohort is checked against the global limit only.
 */
export async function checkCohortBudget(
  cohort: CohortBudgetInput,
  deps: BudgetDeps & { fetchCohortTotals?: (cohortId: string, since: Date) => Promise<TokenTotals[]> } = {},
): Promise<BudgetCheck> {
  const limit = sandboxLimitUsd(cohort);
  if (limit !== null) {
    const spend = await cohortSpendTodayUsd(cohort.id, deps);
    if (spend >= limit) {
      return { ok: false, message: BUDGET_MESSAGE, spendUsd: spend, limitUsd: limit, scope: "sandbox" };
    }
  }
  const global = await checkDailyBudget(deps);
  return global.ok ? global : { ...global, scope: "global" };
}

/** The detail of a budget_refused event: which limit, and the figures. No
 * learner content. */
export function budgetRefusedDetail(
  check: Extract<BudgetCheck, { ok: false }>,
  route: BudgetRefusalKind,
  stage: string,
): Record<string, unknown> {
  return {
    route,
    stage,
    scope: check.scope ?? "global",
    spendUsd: Math.round(check.spendUsd * 10000) / 10000,
    limitUsd: check.limitUsd,
  };
}
