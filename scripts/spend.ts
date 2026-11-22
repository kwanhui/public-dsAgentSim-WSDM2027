/**
 * Total LLM spend recorded in a database, in USD, at the list prices in
 * lib/llm/prices.ts.
 *
 *   tsx scripts/spend.ts --source pglite:<dir>
 *   tsx scripts/spend.ts --source pglite:<dir> --cohort <slug-or-id> --by engagement
 *   tsx scripts/spend.ts --source postgres --by cohort
 *   tsx scripts/spend.ts --source pglite:<dir> --price claude-sonnet-5=3,15   # what-if
 *
 * It reads the same token fields the daily spend guard (lib/llm/budget.ts)
 * meters, on the current schema:
 *
 *   - messages.prompt_tokens / completion_tokens: persona replies and client
 *     reactions (persona model);
 *   - events.detail_json promptTokens / completionTokens on analyst_step,
 *     analyst_step_rejected and any other event that records usage, including
 *     *_failed events (persona model, except persona_consistency, which is the
 *     auditor and runs on the judge model);
 *   - events.detail_json judgePromptTokens / judgeCompletionTokens on
 *     submission_scored (and any other event that records them): judge model.
 *
 * The persona side is priced as --persona-model (default claude-sonnet-5) and
 * the judge side as --judge-model (default claude-opus-4-8). `--price
 * model=in,out` overrides one model's USD-per-million-token price for a
 * what-if comparison; without it, prices come from lib/llm/prices.ts only.
 *
 * Calls that record no usage (audits and reactions before every call was
 * metered) are not counted, so a corpus from before that change is a floor.
 * SELECT only. PGlite is single-process: use a directory no server has open.
 */
import { PRICES, priceFor, tokenCostUsd } from "../lib/llm/prices";
import { flag, flagAll, openSource, type Row, type Source } from "./paper-metrics/source";

export interface TokenPair {
  prompt: number;
  completion: number;
}

export interface SideTotals {
  persona: TokenPair;
  judge: TokenPair;
}

// Event types whose promptTokens/completionTokens were spent on the judge
// model. Mirrors JUDGE_SIDE_EVENTS in lib/llm/budget.ts, so this script and the
// guard price an event the same way. judgePromptTokens/judgeCompletionTokens
// are always judge-side.
export const JUDGE_SIDE_EVENTS = new Set(["persona_consistency"]);

export interface EventTokenRow {
  type: string;
  prompt: unknown;
  completion: unknown;
  judgePrompt: unknown;
  judgeCompletion: unknown;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

/** Same rule as totalsFromRows in lib/llm/budget.ts. Pure. */
export function sideTotals(messageRow: { prompt: unknown; completion: unknown }, eventRows: EventTokenRow[]): SideTotals {
  const totals: SideTotals = {
    persona: { prompt: n(messageRow.prompt), completion: n(messageRow.completion) },
    judge: { prompt: 0, completion: 0 },
  };
  for (const row of eventRows) {
    const side = JUDGE_SIDE_EVENTS.has(row.type) ? totals.judge : totals.persona;
    side.prompt += n(row.prompt);
    side.completion += n(row.completion);
    totals.judge.prompt += n(row.judgePrompt);
    totals.judge.completion += n(row.judgeCompletion);
  }
  return totals;
}

export type Prices = Record<string, { input: number; output: number }>;

export interface SpendOptions {
  cohort?: string;
  personaModel?: string;
  judgeModel?: string;
  prices?: Prices;
}

export interface EngagementSpend {
  engagementId: string;
  cohortId: string;
  cohortSlug: string;
  mode: string;
  totals: SideTotals;
  // Tokens and calls that recorded usage, by source: "messages" or an event type.
  bySource: Record<string, { calls: number; prompt: number; completion: number }>;
  usd: number;
}

export interface SpendReport {
  personaModel: string;
  judgeModel: string;
  prices: Prices;
  engagements: EngagementSpend[];
  totalUsd: number;
  totals: SideTotals;
}

// jsonb number fields, summed only where the field really is a number.
const jsonNum = (key: string) =>
  `coalesce(sum(case when jsonb_typeof(v.detail_json -> '${key}') = 'number' then (v.detail_json ->> '${key}')::numeric else 0 end), 0)`;

export function usdFor(totals: SideTotals, personaModel: string, judgeModel: string, prices: Prices): number {
  const p = prices[personaModel] ?? priceFor(personaModel);
  const j = prices[judgeModel] ?? priceFor(judgeModel);
  return (
    tokenCostUsd(p, totals.persona.prompt, totals.persona.completion) +
    tokenCostUsd(j, totals.judge.prompt, totals.judge.completion)
  );
}

export async function computeSpend(db: Source, opts: SpendOptions = {}): Promise<SpendReport> {
  const personaModel = opts.personaModel ?? "claude-sonnet-5";
  const judgeModel = opts.judgeModel ?? "claude-opus-4-8";
  const prices: Prices = { ...PRICES, ...(opts.prices ?? {}) };
  for (const m of [personaModel, judgeModel]) {
    if (!prices[m]) throw new Error(`No list price recorded for model ${m}; add it to lib/llm/prices.ts.`);
  }

  const params: unknown[] = [];
  let scope = "";
  if (opts.cohort) {
    params.push(opts.cohort);
    scope = `where (c.slug = $1 or c.id = $1)`;
  }

  const engagementRows = await db.query(
    `select e.id as engagement_id, e.cohort_id, c.slug as cohort_slug, e.mode
       from engagements e join cohorts c on c.id = e.cohort_id ${scope}
      order by e.created_at, e.id`,
    params,
  );
  const byId = new Map<string, EngagementSpend>();
  for (const r of engagementRows) {
    byId.set(String(r.engagement_id), {
      engagementId: String(r.engagement_id),
      cohortId: String(r.cohort_id),
      cohortSlug: String(r.cohort_slug),
      mode: String(r.mode),
      totals: { persona: { prompt: 0, completion: 0 }, judge: { prompt: 0, completion: 0 } },
      bySource: {},
      usd: 0,
    });
  }

  const messageRows = await db.query(
    `select m.engagement_id, count(*) filter (where m.prompt_tokens > 0 or m.completion_tokens > 0) as calls,
            coalesce(sum(m.prompt_tokens), 0) as prompt, coalesce(sum(m.completion_tokens), 0) as completion
       from messages m join engagements e on e.id = m.engagement_id join cohorts c on c.id = e.cohort_id ${scope}
      group by m.engagement_id`,
    params,
  );
  const eventRows = await db.query(
    `select v.engagement_id, v.type,
            count(*) filter (where jsonb_typeof(v.detail_json -> 'promptTokens') = 'number'
                              or jsonb_typeof(v.detail_json -> 'judgePromptTokens') = 'number') as calls,
            ${jsonNum("promptTokens")} as prompt, ${jsonNum("completionTokens")} as completion,
            ${jsonNum("judgePromptTokens")} as judge_prompt, ${jsonNum("judgeCompletionTokens")} as judge_completion
       from events v join engagements e on e.id = v.engagement_id join cohorts c on c.id = e.cohort_id ${scope}
      group by v.engagement_id, v.type`,
    params,
  );

  const perEventRows = new Map<string, EventTokenRow[]>();
  for (const r of eventRows as Row[]) {
    const id = String(r.engagement_id);
    const list = perEventRows.get(id) ?? [];
    list.push({
      type: String(r.type),
      prompt: r.prompt,
      completion: r.completion,
      judgePrompt: r.judge_prompt,
      judgeCompletion: r.judge_completion,
    });
    perEventRows.set(id, list);
    const spend = byId.get(id);
    if (spend && (n(r.prompt) || n(r.completion) || n(r.judge_prompt) || n(r.judge_completion))) {
      spend.bySource[String(r.type)] = {
        calls: n(r.calls),
        prompt: n(r.prompt) + n(r.judge_prompt),
        completion: n(r.completion) + n(r.judge_completion),
      };
    }
  }
  const messageById = new Map<string, Row>();
  for (const r of messageRows as Row[]) messageById.set(String(r.engagement_id), r);

  const grand: SideTotals = { persona: { prompt: 0, completion: 0 }, judge: { prompt: 0, completion: 0 } };
  let totalUsd = 0;
  for (const spend of byId.values()) {
    const msg = messageById.get(spend.engagementId) ?? { prompt: 0, completion: 0, calls: 0 };
    if (n(msg.prompt) || n(msg.completion)) {
      spend.bySource.messages = { calls: n(msg.calls), prompt: n(msg.prompt), completion: n(msg.completion) };
    }
    spend.totals = sideTotals(
      { prompt: msg.prompt, completion: msg.completion },
      perEventRows.get(spend.engagementId) ?? [],
    );
    spend.usd = usdFor(spend.totals, personaModel, judgeModel, prices);
    totalUsd += spend.usd;
    for (const side of ["persona", "judge"] as const) {
      grand[side].prompt += spend.totals[side].prompt;
      grand[side].completion += spend.totals[side].completion;
    }
  }
  return { personaModel, judgeModel, prices, engagements: [...byId.values()], totalUsd, totals: grand };
}

function parsePriceOverrides(values: string[]): Prices {
  const out: Prices = {};
  for (const v of values) {
    const m = /^([^=]+)=([\d.]+),([\d.]+)$/.exec(v);
    if (!m) throw new Error(`--price ${v} is not model=input,output (USD per million tokens)`);
    out[m[1]] = { input: Number(m[2]), output: Number(m[3]) };
  }
  return out;
}

const usd = (x: number) => x.toFixed(4);

export function formatReport(report: SpendReport, by: "engagement" | "cohort" | "total"): string {
  const lines: string[] = [];
  const p = report.prices[report.personaModel];
  const j = report.prices[report.judgeModel];
  lines.push(
    `Prices (USD per million tokens): ${report.personaModel} ${p.input}/${p.output} (persona side), ` +
      `${report.judgeModel} ${j.input}/${j.output} (judge side)`,
  );
  if (by === "engagement") {
    lines.push("", "engagement                            mode   cohort                                 persona tok (in/out)   judge tok (in/out)        USD");
    for (const e of report.engagements) {
      lines.push(
        `${e.engagementId}  ${e.mode.padEnd(5)}  ${e.cohortSlug.slice(0, 38).padEnd(38)}  ` +
          `${`${e.totals.persona.prompt}/${e.totals.persona.completion}`.padStart(20)}   ` +
          `${`${e.totals.judge.prompt}/${e.totals.judge.completion}`.padStart(18)}  ${usd(e.usd).padStart(9)}`,
      );
    }
  } else if (by === "cohort") {
    const groups = new Map<string, { slug: string; engagements: number; usd: number }>();
    for (const e of report.engagements) {
      const g = groups.get(e.cohortId) ?? { slug: e.cohortSlug, engagements: 0, usd: 0 };
      g.engagements += 1;
      g.usd += e.usd;
      groups.set(e.cohortId, g);
    }
    lines.push("", "cohort                                  engagements        USD");
    for (const g of groups.values()) {
      lines.push(`${g.slug.slice(0, 38).padEnd(38)}  ${String(g.engagements).padStart(11)}  ${usd(g.usd).padStart(9)}`);
    }
  }
  const t = report.totals;
  lines.push(
    "",
    `Total: USD ${usd(report.totalUsd)}  (persona side ${t.persona.prompt}/${t.persona.completion} tok, ` +
      `judge side ${t.judge.prompt}/${t.judge.completion} tok, ${report.engagements.length} engagement(s))`,
  );
  return lines.join("\n");
}

const USAGE = `Usage:
  tsx scripts/spend.ts --source pglite:<dir>|postgres [--cohort <slug-or-id>]
                       [--by total|cohort|engagement] [--json]
                       [--persona-model <id>] [--judge-model <id>]
                       [--price <model>=<in>,<out> ...]`;

async function main(argv: string[]): Promise<void> {
  const spec = flag(argv, "source");
  if (!spec) {
    console.error(USAGE);
    process.exit(1);
  }
  const by = (flag(argv, "by") ?? "engagement") as "engagement" | "cohort" | "total";
  if (!["engagement", "cohort", "total"].includes(by)) throw new Error(`--by must be total, cohort or engagement`);
  const db = await openSource(spec);
  try {
    const report = await computeSpend(db, {
      cohort: flag(argv, "cohort"),
      personaModel: flag(argv, "persona-model"),
      judgeModel: flag(argv, "judge-model"),
      prices: parsePriceOverrides(flagAll(argv, "price")),
    });
    console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report, by));
  } finally {
    await db.close();
  }
}

// Only run the CLI when this file is the entry point, so a test can import it.
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
