import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { requireWriter } from "@/lib/auth/guard";
import { BUDGET_REFUSED_EVENT, budgetRefusedDetail, checkCohortBudget } from "@/lib/llm/budget";
import { budgetRefusalMessage } from "@/lib/llm/budget-format";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts, engagements } from "@/lib/db/schema";
import { DEFAULT_COHORT_CONFIG, parseCohortConfig } from "@/lib/cohort/defaults";
import {
  runAnalystStage,
  startAnalystRun,
  describeError,
  ANALYST_FAILURE_EVENT,
  isAnalystFailureEvent,
  ANALYST_MAX_MESSAGES_PER_STAGE,
  analystStageEventDetail,
  personaModelName,
  runAnalystModelName,
} from "@/lib/agents/analyst";
import { runAnalystModelOverride } from "@/lib/agents/analyst-model";
import {
  STAGE_FINISHED_EVENT,
  STAGE_STARTED_EVENT,
  cohortRunInFlight,
  inFlightSince,
} from "@/lib/agents/agent-run-state";
import { getEngagement, getEvents, logEvent } from "@/lib/engagement/state";
import { loadScenario } from "@/lib/scenarios/load";
import { STAGE_IDS, STAGE_TITLES, stageIndex, type StageId } from "@/lib/scenarios/types";
import { formatUtc } from "@/lib/admin/format";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import {
  RunStageButton,
  StageActivity,
  StageRunNote,
  StageRunProvider,
  StartRunForm,
} from "./run-controls";

// Analyst-agent demo runs for one cohort: start an agent-mode engagement and
// drive it stage by stage. Demo capability only: human learner engagements
// are untouched, and agent runs are marked (engagements.mode = "agent").

// A stage run holds the request open for as long as the model takes, so the
// only server-side record that one is under way is the event log: a pair of
// events brackets each stage run (lib/agents/agent-run-state.ts). The
// bracket is one of two guard layers: it stops dispatches from other tabs,
// while the client-side lock in run-controls.tsx stops the same tab, whose
// action dispatches are queued behind the running stage and would reach this
// check only after the bracket had closed.

export default async function AnalystAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return null;
  const readOnly = isReviewer(session);

  const [cohort] = await db
    .select({ id: cohorts.id, name: cohorts.name, configJson: cohorts.configJson })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) notFound();

  const config = parseCohortConfig(cohort.configJson);
  const allowed =
    config.scenarios.allowed.length > 0
      ? config.scenarios.allowed
      : DEFAULT_COHORT_CONFIG.scenarios.allowed;

  const agentRuns = await db
    .select()
    .from(engagements)
    .where(and(eq(engagements.cohortId, id), eq(engagements.mode, "agent")))
    .orderBy(desc(engagements.createdAt));

  // The demo's "same input, two runs" claim only holds if the agent runs the
  // scenario the learners chose, so the picker opens on the scenario with the
  // most human engagements in this cohort (the most recent one could pick a
  // scenario that only one learner had tried).
  const [recentHuman] = await db
    .select({ scenarioId: engagements.scenarioId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(engagements)
    .where(and(eq(engagements.cohortId, id), eq(engagements.mode, "human")))
    .groupBy(engagements.scenarioId)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${engagements.createdAt})`))
    .limit(1);

  const titles = await scenarioTitles([...allowed, ...agentRuns.map((r) => r.scenarioId)]);
  const options = allowed
    .filter((sid) => titles.has(sid))
    .map((sid) => ({ id: sid, title: titles.get(sid) as string }));
  const defaultScenarioId =
    (recentHuman && options.find((o) => o.id === recentHuman.scenarioId)?.id) ??
    options[0]?.id ??
    allowed[0] ??
    "customer-churn";
  const defaultFromLearner = Boolean(recentHuman && recentHuman.scenarioId === defaultScenarioId);

  // A stage run that threw logs a failure event and stops there. If that is
  // the newest event on a run, the last attempt failed and nothing has
  // happened since, so the run carries a banner until the next attempt. The
  // start/finish bracket is skipped here: the finish is logged after the
  // failure and would otherwise hide the banner.
  const runStates = await Promise.all(
    agentRuns.map(async (run) => {
      const evts = await getEvents(run.id);
      const running = inFlightSince(evts);
      // A run started with its own analyst model (the agent-run route).
      const modelOverride = runAnalystModelOverride(evts);
      const last = [...evts]
        .reverse()
        .find((e) => e.type !== STAGE_STARTED_EVENT && e.type !== STAGE_FINISHED_EVENT);
      if (!last || !isAnalystFailureEvent(last.type)) return { running, modelOverride, failure: null };
      const detail = (last.detailJson ?? {}) as {
        errorClass?: string;
        message?: string;
        stage?: string;
        step?: number;
      };
      return {
        running,
        modelOverride,
        failure: {
          errorClass: detail.errorClass ?? "Error",
          message: detail.message ?? "",
          stage: detail.stage ?? run.currentStage,
          step: detail.step ?? 0,
          at: last.timestampIso,
        },
      };
    }),
  );
  const busy = runStates.some((s) => s.running !== null);

  // The start is refused, not just hidden, while any run in the cohort has a
  // stage in flight: this action can be dispatched from a tab whose rendered
  // controls predate the running stage.
  async function startRun(scenarioId: string): Promise<{ started: boolean; message?: string }> {
    "use server";
    await requireWriter();
    const budget = await checkCohortBudget({ id, config });
    if (!budget.ok) return { started: false, message: budgetRefusalMessage("agent", null) };
    const chosen = allowed.includes(scenarioId) ? scenarioId : defaultScenarioId;
    if (await cohortRunInFlight(id)) return { started: false };
    await startAnalystRun(id, chosen);
    revalidatePath(`/admin/cohorts/${id}/agent`);
    return { started: true };
  }

  return (
    <StageRunProvider serverBusy={busy}>
      <div>
        <PageHeader
          title="Analyst agent runs"
          description={`Runs a model-driven analyst through one of this cohort's scenarios, with the same channels, stage gates and rubric judge as a human learner. Up to ${ANALYST_MAX_MESSAGES_PER_STAGE} stakeholder messages per stage, then it must submit.`}
          action={
            readOnly ? undefined : (
              <StartRunForm
                action={startRun}
                options={options}
                defaultScenarioId={defaultScenarioId}
              />
            )
          }
        />

        <p className="mt-3 max-w-2xl text-xs text-muted-foreground">
          {defaultFromLearner
            ? `The picker opens on ${titles.get(defaultScenarioId) ?? defaultScenarioId}, the scenario most learners in this cohort chose, so the runs share the same input.`
            : "No learner has started an engagement in this cohort yet, so the picker opens on the first scenario the cohort allows."}
          <StageRunNote />
        </p>

        <section className="mt-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Agent runs
          </h2>
          {agentRuns.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No agent runs yet. Start one, then drive it a stage at a time and open the compare
              view beside a human engagement.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {agentRuns.map((run, i) => {
                const { failure, running, modelOverride } = runStates[i];
                // Runs are listed newest first; numbering follows start order,
                // so two otherwise identical idle runs can be told apart.
                const runNumber = agentRuns.length - i;
                const runStage = async () => {
                  "use server";
                  await requireWriter();
                  // Two clicks on this button used to start two stage runs on
                  // the same engagement. The event bracket is re-read here, so
                  // the second one returns instead of racing the first.
                  const runEvents = await getEvents(run.id);
                  if (inFlightSince(runEvents) !== null) {
                    revalidatePath(`/admin/cohorts/${id}/agent`);
                    return;
                  }
                  // Re-read the stage inside the action: `run` was captured at
                  // page render, so after several stages the closure's copy is
                  // stale and every bracket would log the render-time stage.
                  const liveStage = (await getEngagement(run.id))?.currentStage ?? run.currentStage;
                  const liveOverride = runAnalystModelOverride(runEvents);
                  // Over the daily budget the stage does not start; the
                  // refusal is logged as a failed attempt so the run card
                  // shows it in the usual failure banner.
                  const budget = await checkCohortBudget({ id, config });
                  if (!budget.ok) {
                    await logEvent(run.id, id, BUDGET_REFUSED_EVENT, budgetRefusedDetail(budget, "agent", liveStage));
                    // The analyst model, beside the persona model it talked
                    // to, so a cross-model run is labelled correctly.
                    await logEvent(run.id, id, ANALYST_FAILURE_EVENT, {
                      ...analystStageEventDetail(liveStage, liveOverride),
                      step: 0,
                      errorClass: "UsageLimit",
                      message: budgetRefusalMessage("agent", null),
                    });
                    revalidatePath(`/admin/cohorts/${id}/agent`);
                    return;
                  }
                  await logEvent(run.id, id, STAGE_STARTED_EVENT, analystStageEventDetail(liveStage, liveOverride));
                  try {
                    // runAnalystStage catches step failures itself and logs
                    // them; this guard covers the rest of the path (unknown
                    // engagement, scenario load, DB), so no route through
                    // this button can end in a silently unchanged page.
                    await runAnalystStage(run.id, config);
                  } catch (err) {
                    const described = describeError(err);
                    await logEvent(run.id, id, ANALYST_FAILURE_EVENT, {
                      ...analystStageEventDetail(liveStage, liveOverride),
                      step: 0,
                      errorClass: described.errorClass,
                      message: described.message,
                    });
                  } finally {
                    await logEvent(run.id, id, STAGE_FINISHED_EVENT, {
                      stage: liveStage,
                    });
                    revalidatePath(`/admin/cohorts/${id}/agent`);
                  }
                };
                return (
                  <li key={run.id} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          Run #{runNumber} · {titles.get(run.scenarioId) ?? run.scenarioId} ·{" "}
                          <span className="text-muted-foreground">
                            {STAGE_TITLES[run.currentStage as StageId] ?? run.currentStage}
                          </span>{" "}
                          · {run.status}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Started {formatUtc(run.createdAt)} · analyst {runAnalystModelName(modelOverride)} · personas{" "}
                          {personaModelName()} · id{" "}
                          {run.id.slice(0, 8)}…
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {run.status === "active" && !readOnly ? (
                          running ? (
                            <Button disabled>Stage running…</Button>
                          ) : (
                            <RunStageButton
                              runId={run.id}
                              action={runStage}
                              progressLabel={`Running stage ${stageIndex(run.currentStage as StageId) + 1} of ${STAGE_IDS.length}`}
                            >
                              {failure ? "Retry current stage" : "Run current stage"}
                            </RunStageButton>
                          )
                        ) : null}
                        <Link
                          href={`/admin/engagements/${run.id}`}
                          className="text-xs text-primary hover:underline"
                        >
                          Monitor
                        </Link>
                        <Link
                          href={`/admin/compare?a=${run.id}`}
                          className="text-xs text-primary hover:underline"
                        >
                          Compare
                        </Link>
                      </div>
                    </div>
                    <StageActivity runId={run.id} cohortId={id} />
                    {running ? (
                      <p role="status" className="mt-3 text-xs text-muted-foreground">
                        A stage has been running since {formatUtc(running, { seconds: true })}. The
                        page updates when it finishes; reload to check.
                      </p>
                    ) : null}
                    {failure ? (
                      <div
                        role="status"
                        className="mt-3 rounded-md border border-flag/40 bg-flag/5 p-3 text-xs text-flag"
                      >
                        <p className="font-medium">
                          Stage run failed and the run did not advance. Retry the stage.
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          {describeErrorClass(failure.errorClass)} at{" "}
                          {STAGE_TITLES[failure.stage as StageId] ?? failure.stage}
                          {failure.step > 0 ? `, step ${failure.step}` : ""} ·{" "}
                          {formatUtc(failure.at, { seconds: true })}
                        </p>
                        {failure.message ? (
                          <p className="mt-1 text-muted-foreground">{failure.message}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="mt-8 max-w-2xl text-xs text-muted-foreground">
          Each agent action is recorded with its model, prompt version and reasoning in the
          engagement&apos;s event log. The agent sees only what a human learner sees (no persona
          cards and no world-fact ledger) and may cite only numbers from the profiles of released
          data files.
        </p>
      </div>
    </StageRunProvider>
  );
}

// The failure banner names what went wrong in words; the class name stays in
// the event log.
function describeErrorClass(errorClass: string): string {
  if (/NoObjectGenerated/.test(errorClass)) return "The model's answer did not match the expected format";
  if (/APICall|Retry/.test(errorClass)) return "The model provider did not answer";
  if (/Timeout|Abort/.test(errorClass)) return "The model call timed out";
  return "The stage run stopped with an error";
}

// Titles for the scenario ids on this page. A cohort can allow an id whose
// file is gone, and an old run can name one too, so a failed load drops the
// entry rather than breaking the page.
async function scenarioTitles(ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const sid of new Set(ids)) {
    try {
      titles.set(sid, (await loadScenario(sid)).title);
    } catch {
      // Skip: the picker leaves it out and run rows fall back to the raw id.
    }
  }
  return titles;
}
