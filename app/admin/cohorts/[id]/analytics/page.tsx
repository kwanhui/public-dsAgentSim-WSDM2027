import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import {
  checkinMeans,
  consistencySummary,
  criterionMeans,
  learnerMessageCounts,
  modeCounts,
  scriptedReplayCount,
  stageFunnel,
} from "@/lib/analytics/queries";
import { STAGE_IDS, STAGE_TITLES, type StageId } from "@/lib/scenarios/types";
import { humanizeId } from "@/lib/utils";
import { listScenarios } from "@/lib/scenarios/load";
import { plural } from "@/lib/admin/format";
import { Button } from "@/components/ui/button";
import { DumbbellList, HBarList } from "@/components/admin/charts";

export default async function CohortAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ agents?: string; sandbox?: string }>;
}) {
  const { id } = await params;
  const { agents, sandbox } = await searchParams;
  const session = await auth();
  if (!session?.user) return null;

  const [cohort] = await db
    .select({ id: cohorts.id, configJson: cohorts.configJson })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) notFound();
  const config = parseCohortConfig(cohort.configJson);
  // Check-ins sit behind a cohort flag that is off by default; while the
  // cohort has them off, neither the section nor the export is offered.
  const checkinsOn = config.research.checkins;

  // Human engagements only by default: analyst-agent runs are demo
  // provenance, and sandbox seats are visitors from the public /try link;
  // pooling either with learner work moves the funnel and the rubric means.
  // A showcase cohort open to the reviewer holds no learner work, so there
  // the agent runs are counted by default and the figures match the paper's.
  const agentsByDefault = config.showcase.reviewerVisible;
  const includeAgentRuns = agents === "1" || (agents !== "0" && agentsByDefault);
  const includeSandbox = sandbox === "1";
  const scope = { includeAgentRuns, includeSandbox };
  const hrefWith = (next: { agents: boolean; sandbox: boolean }) => {
    const agentsParam = next.agents === agentsByDefault ? null : next.agents ? "agents=1" : "agents=0";
    const q = [agentsParam, next.sandbox ? "sandbox=1" : null].filter(Boolean).join("&");
    return `/admin/cohorts/${id}/analytics${q ? `?${q}` : ""}`;
  };

  const [funnel, means, activity, consistency, checkinRows, byMode, replays] = await Promise.all([
    stageFunnel(id, scope),
    criterionMeans(id, scope),
    learnerMessageCounts(id, scope),
    consistencySummary(id, scope),
    checkinsOn ? checkinMeans(id, scope) : Promise.resolve([]),
    modeCounts(id),
    scriptedReplayCount(id, config.showcase),
  ]);

  const scenarioIds = [...new Set(funnel.map((f) => f.scenarioId))].sort();
  // Titles, the names learners see, rather than scenario ids.
  const scenarioTitles = new Map((await listScenarios()).map((sc) => [sc.id, sc.title]));
  const exportMode = includeAgentRuns ? "all" : "human";
  const exportQuery = `mode=${exportMode}${includeSandbox ? "" : "&sandbox=exclude"}`;
  // Author replays join through an invite like a learner but are not
  // learners (lib/admin/run-kind.ts); the label names what is counted.
  const invitedLearners = byMode.human - replays;
  const scopeLabel = [
    invitedLearners > 0 || replays === 0 ? "invited learners" : null,
    replays > 0 ? "author replays" : null,
    includeAgentRuns ? "agent runs" : null,
    includeSandbox ? "sandbox seats" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const totalMessages = activity.reduce((s, a) => s + a.learnerMessages, 0);
  // Headline count comes from the same source as the scope sub-line, so the
  // two cannot disagree when an engagement has no messages yet.
  const scopedEngagements =
    byMode.human + (includeAgentRuns ? byMode.agent : 0) + (includeSandbox ? byMode.sandbox : 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          <p>
            {/* With agent runs on screen the totals include agent messages,
                so "learner messages" would overcount what learners wrote. */}
            {plural(totalMessages, includeAgentRuns ? "message" : "learner message")} across{" "}
            {plural(scopedEngagements, "engagement")}
            {activity.length < scopedEngagements
              ? ` (${scopedEngagements - activity.length} without messages yet)`
              : ""}
            . Exports carry pseudonymous learner hashes
            only, plus a mode column separating learner runs from analyst-agent runs.
          </p>
          <p className="mt-1 text-xs">
            Counting {plural(scopedEngagements, "engagement")}: {scopeLabel}.
            {!includeAgentRuns && byMode.agent > 0 ? ` ${byMode.agent} analyst-agent ${byMode.agent === 1 ? "run is" : "runs are"} left out.` : ""}
            {!includeSandbox && byMode.sandbox > 0 ? ` ${byMode.sandbox} sandbox ${byMode.sandbox === 1 ? "seat is" : "seats are"} left out.` : ""}
            {byMode.agent > 0 ? (
              <>
                {" "}
                <Link
                  href={hrefWith({ agents: !includeAgentRuns, sandbox: includeSandbox })}
                  className="text-primary underline underline-offset-4"
                >
                  {includeAgentRuns ? "Leave out agent runs" : "Include agent runs"}
                </Link>
              </>
            ) : null}
            {byMode.sandbox > 0 ? (
              <>
                {" "}
                <Link
                  href={hrefWith({ agents: includeAgentRuns, sandbox: !includeSandbox })}
                  className="text-primary underline underline-offset-4"
                >
                  {includeSandbox ? "Leave out sandbox seats" : "Include sandbox seats"}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {/* The exports carry the filter that is on screen, so a CSV pulled from
            a page reading "invited learners" holds those engagements and no
            others. Each button says which scope it will download. */}
        <div className="flex flex-wrap gap-2">
          <a href={`/api/admin/cohorts/${id}/export?what=scores&${exportQuery}`} download>
            <Button variant="primary" size="md">
              Export scores CSV ({scopeLabel})
            </Button>
          </a>
          <a href={`/api/admin/cohorts/${id}/export?what=events&${exportQuery}`} download>
            <Button variant="outline" size="md">
              Export events CSV ({scopeLabel})
            </Button>
          </a>
          <a href={`/api/admin/cohorts/${id}/export?what=engagements&${exportQuery}`} download>
            <Button variant="outline" size="md">
              Export engagements CSV ({scopeLabel})
            </Button>
          </a>
          {checkinsOn ? (
            <a href={`/api/admin/cohorts/${id}/export?what=checkins&${exportQuery}`} download>
              <Button variant="outline" size="md">
                Export check-ins CSV ({scopeLabel})
              </Button>
            </a>
          ) : null}
        </div>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Stage funnel
        </h2>
        {funnel.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No engagements yet.</p>
        ) : (
          scenarioIds.map((sid) => {
            const rows = funnel.filter((f) => f.scenarioId === sid);
            return (
              <div key={sid} className="mt-4">
                <h3 className="text-sm font-medium">{scenarioTitles.get(sid) ?? sid}</h3>
                <div className="mt-3">
                  <HBarList
                    items={STAGE_IDS.map((stage, i) => ({
                      label: STAGE_TITLES[stage],
                      value: rows.reduce(
                        (sum, r) =>
                          r.status === "completed" ||
                          STAGE_IDS.indexOf(r.currentStage as StageId) >= i
                            ? sum + r.count
                            : sum,
                        0,
                      ),
                      detail: `${STAGE_TITLES[stage]}: engagements that reached this stage`,
                    }))}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Engagements that reached each stage.
                  </p>
                </div>
                <div className="overflow-x-auto">
                <table className="mt-4 w-full max-w-2xl text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Stage</th>
                      <th className="pb-2 pr-4 font-medium">Active</th>
                      <th className="pb-2 font-medium">Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STAGE_IDS.map((stage) => {
                      const active = rows
                        .filter((r) => r.currentStage === stage && r.status === "active")
                        .reduce((s, r) => s + r.count, 0);
                      const completed =
                        stage === STAGE_IDS[STAGE_IDS.length - 1]
                          ? rows.filter((r) => r.status === "completed").reduce((s, r) => s + r.count, 0)
                          : 0;
                      return (
                        <tr key={stage} className="border-b last:border-0">
                          <td className="py-1.5 pr-4">{STAGE_TITLES[stage]}</td>
                          <td className="py-1.5 pr-4">{active}</td>
                          <td className="py-1.5">{completed}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Persona role-consistency (auditor verdicts, unvalidated)
        </h2>
        {consistency.audited === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No audited persona replies yet ({consistency.personaTurns + consistency.reactions} so far;
            the audit samples a fraction of chat replies set in Configuration and checks every gate
            reaction).
          </p>
        ) : (
          <p className="mt-2 text-sm">
            {consistency.audited} of {consistency.personaTurns + consistency.reactions} persona replies
            audited ({consistency.personaTurns} chat replies and {consistency.reactions} gate
            reactions):{" "}
            <span className="font-medium">
              {consistency.consistent + consistency.flagged > 0
                ? `${consistency.consistent} of ${consistency.consistent + consistency.flagged} consistent (${Math.round((consistency.consistent / (consistency.consistent + consistency.flagged)) * 100)}%)`
                : "no verdicts"}
            </span>
            {consistency.flagged > 0 ? (
              <span className="text-flag"> · {consistency.flagged} flagged</span>
            ) : null}
            {consistency.auditErrors > 0 ? (
              <span className="text-muted-foreground"> · {consistency.auditErrors} audit errors</span>
            ) : null}
          </p>
        )}
      </section>

      {checkinsOn ? (
      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Confidence check-ins (mean, 1 to 7)
        </h2>
        {checkinRows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No check-ins submitted yet.</p>
        ) : (
          <>
          <div className="mt-3">
            <DumbbellList
              min={1}
              max={7}
              startLabel="At start"
              endLabel="At completion"
              items={STAGE_IDS.flatMap((stage) => {
                const start = checkinRows.find((c) => c.stage === stage && c.kind === "start");
                const complete = checkinRows.find((c) => c.stage === stage && c.kind === "complete");
                if (!start && !complete) return [];
                return [
                  {
                    label: STAGE_TITLES[stage],
                    start: start ? Number(start.mean.toFixed(2)) : null,
                    end: complete ? Number(complete.mean.toFixed(2)) : null,
                  },
                ];
              })}
            />
          </div>
          <div className="overflow-x-auto">
          <table className="mt-4 w-full max-w-2xl text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Stage</th>
                <th className="pb-2 pr-4 font-medium">At start</th>
                <th className="pb-2 font-medium">At completion</th>
              </tr>
            </thead>
            <tbody>
              {STAGE_IDS.map((stage) => {
                const start = checkinRows.find((c) => c.stage === stage && c.kind === "start");
                const complete = checkinRows.find((c) => c.stage === stage && c.kind === "complete");
                if (!start && !complete) return null;
                return (
                  <tr key={stage} className="border-b last:border-0">
                    <td className="py-1.5 pr-4">{STAGE_TITLES[stage]}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs">
                      {start ? `${start.mean.toFixed(2)} (n=${start.n})` : "none"}
                    </td>
                    <td className="py-1.5 font-mono text-xs">
                      {complete ? `${complete.mean.toFixed(2)} (n=${complete.n})` : "none"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          </>
        )}
      </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Rubric criterion means
        </h2>
        {means.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No scored submissions yet.</p>
        ) : (
          scenarioIds
            .filter((sid) => means.some((m) => m.scenarioId === sid))
            .map((sid) => (
              <div key={sid} className="mt-4">
                <h3 className="text-sm font-medium">{scenarioTitles.get(sid) ?? sid}</h3>
                <div className="overflow-x-auto">
                <table className="mt-2 w-full max-w-3xl text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Stage</th>
                      <th className="pb-2 pr-4 font-medium">Criterion</th>
                      <th className="pb-2 font-medium">Mean</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STAGE_IDS.flatMap((stage) =>
                      means
                        .filter((m) => m.scenarioId === sid && m.stage === stage)
                        .map((m) => (
                          <tr key={`${m.stage}-${m.criterionId}`} className="border-b last:border-0">
                            <td className="py-1.5 pr-4">{STAGE_TITLES[m.stage as StageId] ?? m.stage}</td>
                            <td className="py-1.5 pr-4">{humanizeId(m.criterionId)}</td>
                            <td className="py-1.5">
                              <span className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-24 overflow-hidden rounded bg-muted"
                                  aria-hidden="true"
                                >
                                  <span
                                    className="block h-full rounded-r"
                                    style={{
                                      width: `${(m.meanScore / m.maxScore) * 100}%`,
                                      backgroundColor: "var(--chart-main)",
                                    }}
                                  />
                                </span>
                                <span className="font-mono text-xs tabular-nums">
                                  {m.meanScore.toFixed(2)}/{m.maxScore} (n={m.n})
                                </span>
                              </span>
                            </td>
                          </tr>
                        )),
                    )}
                  </tbody>
                </table>
                </div>
              </div>
            ))
        )}
      </section>
    </div>
  );
}
