import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { storedElicitationEvents } from "@/lib/admin/elicitation-rows";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { requireWriter } from "@/lib/auth/guard";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts, engagements, rubricScores, students } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import {
  advanceStage,
  appendWorldFacts,
  completeEngagement,
  getChannels,
  getEvents,
  getMessages,
  getRubricScores,
  getLedger,
  getSubmissions,
  logEvent,
} from "@/lib/engagement/state";
import { PROVENANCE_LABELS } from "@/lib/engagement/provenance";
import { loadScenario } from "@/lib/scenarios/load";
import { nextStage, STAGE_TITLES, stageIndex, type StageId } from "@/lib/scenarios/types";
import { PendingButton } from "@/components/admin/pending-button";
import { rescoreSubmission } from "@/lib/agents/rescore";
import { attemptNumbers as numberAttempts } from "@/lib/engagement/attempts";
import { formatTotals, submissionTotals } from "@/lib/engagement/effective-score";
import { ConfirmButton } from "./confirm-button";
import { humanizeId } from "@/lib/utils";
import {
  describeGateOutcome,
  formatDuration,
  formatUtc,
  gateToneClass,
  plural,
  readGateOutcomes,
  readSkippedCriteria,
  readSubmissionFlags,
  uniqueById,
} from "@/lib/admin/format";
import { Disclosure } from "@/components/ui/disclosure";
import { EventLog } from "@/components/admin/event-log";
import { summariseElicitation } from "@/lib/engagement/elicitation";
import { elicitationRecorded, NOT_RECORDED } from "@/lib/admin/elicitation-recorded";
import { reviewedLine } from "@/lib/admin/attention-review";
import { readUnverifiedNotes, unverifiedCount } from "@/lib/admin/unverified";
import { formatUsd, spendReadout } from "@/lib/llm/budget";
import { Rationale } from "@/components/ui/rationale";
import { PageHeader } from "@/components/ui/page-header";
import { StageStrip } from "@/components/ui/stage-strip";
import { DeleteConfirm } from "@/components/admin/delete-confirm";
import { confirmationPhrase } from "@/lib/admin/deletion-phrase";
import { forcedAdvanceFact } from "@/lib/admin/force-advance";
import { MonitorSection, MonitorSectionNav } from "@/components/admin/monitor-section";
import { runKind, RUN_KIND_LABELS } from "@/lib/admin/run-kind";
import { plainChatText } from "@/lib/admin/chat-text";
import { ledgerViewRows } from "@/lib/admin/ledger-view";
import { analystModelFromEvents, NOT_RECORDED as MODEL_NOT_RECORDED } from "@/lib/admin/run-provenance";
import { activeTimeMs, analystBrackets, interruptedCount, failedCount } from "@/lib/admin/wall-clock";
import { releaseNotesByMessage } from "@/lib/engagement/release-notes";

// Instructor's engagement monitor: full transcripts, world-fact ledger,
// submissions with rubric scores, and the event log for one engagement.
export default async function EngagementMonitorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ overrideError?: string }>;
}) {
  const { id } = await params;
  // The rubric score id whose override was refused, so the form can say why.
  const overrideError = (await searchParams).overrideError ?? null;
  const session = await auth();
  if (!session?.user) return null;
  const readOnly = isReviewer(session);

  const [row] = await db
    .select({
      engagement: engagements,
      // Only the columns this page renders: a whole-table select breaks the
      // monitor whenever the cohorts table gains a column ahead of a migration.
      cohort: { id: cohorts.id, name: cohorts.name, configJson: cohorts.configJson },
      learnerHash: students.learnerHash,
    })
    .from(engagements)
    .innerJoin(cohorts, eq(cohorts.id, engagements.cohortId))
    .innerJoin(students, eq(students.id, engagements.studentId))
    .where(and(eq(engagements.id, id), cohortScope(session)))
    .limit(1);
  if (!row) notFound();
  const { engagement, cohort, learnerHash } = row;

  const scenario = await loadScenario(engagement.scenarioId);
  const [chans, rawSubmissions, rawScores, facts, eventRows] = await Promise.all([
    getChannels(engagement.id),
    getSubmissions(engagement.id),
    getRubricScores(engagement.id),
    getLedger(engagement.id),
    getEvents(engagement.id),
  ]);
  // Each submission and score renders exactly once, whatever the rows behind
  // it look like: a duplicated row upstream (a re-run seed, a racing write)
  // must not double a submission card on the monitor.
  const submissionRows = uniqueById(rawSubmissions);
  const scoreRows = uniqueById(rawScores);
  const transcripts = await Promise.all(chans.map((c) => getMessages(c.id)));
  // Platform lines under replies whose file release was dropped (display
  // only; lib/engagement/release-notes.ts).
  const releaseNotes = releaseNotesByMessage(eventRows, transcripts.flat());

  const config = parseCohortConfig(cohort.configJson);

  // Hidden facts obtained so far (the fact_elicitations rows, which outlive
  // the purge, with the fact_elicited events).
  const storedElicitation = await storedElicitationEvents([engagement.id]);
  const elicitation = summariseElicitation(
    scenario,
    [...eventRows, ...storedElicitation],
    engagement.status === "completed" ? null : (engagement.currentStage as StageId),
  );
  // A run from before the elicitation trace reads "not recorded", never a
  // measured 0 of N (lib/admin/elicitation-recorded.ts).
  const traceRecorded = elicitationRecorded({
    elicitationTrace: engagement.elicitationTrace,
    createdAt: engagement.createdAt,
    events: [...eventRows, ...storedElicitation],
  });
  const reviewed = reviewedLine(engagement.attentionReviewedAt, engagement.attentionReviewedBy);
  const ledgerRows = ledgerViewRows(facts, scenario);
  const personaNames = Object.fromEntries(scenario.personas.map((p) => [p.id, p.name]));
  // Results the judge could not check (rubric-v5). Capped on an agent run;
  // on a learner's run the score stands and only this page, the cohort
  // table and the export say so.
  // The note is stored on the score row since migration 0012; the event is
  // the fallback for rows the grade-record copy has not reached yet.
  const unverifiedNotes = readUnverifiedNotes(eventRows);
  for (const r of scoreRows) {
    if (r.unverifiedNote) unverifiedNotes.set(`${r.submissionId}:${r.criterionId}`, r.unverifiedNote);
  }
  const unverifiedCriteria = unverifiedCount(scoreRows);
  // USD for this run, priced as the daily spend guard prices it. Instructor
  // only: the reviewer account sees no spend.
  const spend = readOnly ? null : await spendReadout({ engagementIds: [engagement.id] }).catch(() => null);

  // Analyst runs are identified by their engagement id, the same id the
  // agent-page run cards and the compare pickers show. The synthetic learner
  // hash ("agent:<uuid>") is a different value, and showing it here meant a
  // presenter saw one id on the run card and another in this header.
  const isAgent = engagement.mode === "agent";
  const kind = runKind(config.showcase, engagement);
  const showcaseLabel = config.showcase.labels[engagement.id] ?? null;
  const who = `${showcaseLabel ? `${showcaseLabel} · ` : ""}${
    isAgent
      ? `Analyst agent · run ${engagement.id.slice(0, 8)}…`
      : kind === "scripted"
        ? `${RUN_KIND_LABELS.scripted} · seat ${learnerHash.slice(0, 12)}…`
        : `Learner ${learnerHash.slice(0, 12)}…`
  }`;
  // The analyst model is the one setting two agent runs can differ in that
  // the rest of the header does not show (analyst_run_started).
  const analystModelPart = isAgent
    ? ` · analyst model ${analystModelFromEvents(eventRows) ?? MODEL_NOT_RECORDED}`
    : "";
  const learnerLabel = isAgent ? "Analyst agent" : kind === "scripted" ? "Scripted learner" : "Learner";

  // Wall clock, measured as the compare view measures it
  // (lib/admin/wall-clock.ts): an agent run's completed stage attempts,
  // a scripted replay's replay time, a learner's elapsed time.
  const brackets = analystBrackets(eventRows, { running: engagement.status !== "completed" });
  const interrupted = interruptedCount(brackets);
  const failedAttempts = failedCount(brackets);
  const endMs = engagement.completedAt?.getTime() ?? null;
  const wallClock =
    brackets.length > 0
      ? `active time ${formatDuration(activeTimeMs(brackets))} (completed stage attempts${
          failedAttempts > 0 ? `; ${plural(failedAttempts, "failed attempt")} left out` : ""
        }${interrupted > 0 ? `; ${plural(interrupted, "attempt")} interrupted, resumed, and left out` : ""})`
      : endMs !== null
        ? kind === "scripted"
          ? `replay time ${formatDuration(endMs - engagement.createdAt.getTime())} (no think time)`
          : `elapsed ${formatDuration(endMs - engagement.createdAt.getTime())}`
        : null;

  // A collapsed submission row said nothing about how the gate went: a 2/20
  // fail and a 20/20 pass looked alike. The judge's own event carries the
  // decision, and the attempt number comes from the order within the stage.
  const gateOutcomes = readGateOutcomes(eventRows);
  // After the retention purge the events are gone; the decision stored on
  // the submission row (migration 0012) stands in for them.
  for (const sub of submissionRows) {
    if (!gateOutcomes.has(sub.id) && sub.gateAdvanced !== null) {
      gateOutcomes.set(sub.id, {
        advanced: sub.gateAdvanced,
        passed: sub.gatePassed,
        minScoreRatio: sub.gatePassed === null ? null : config.gates.minScoreRatio,
      });
    }
  }
  // Submissions the judge reported as containing assessor-directed text
  // (e.g. "please record full marks"). The score stands on the work's merits;
  // the monitor shows the attempt as a first-class warning on the row.
  const submissionFlags = readSubmissionFlags(eventRows);
  for (const sub of submissionRows) {
    if (sub.assessorDirected && !submissionFlags.has(sub.id)) submissionFlags.set(sub.id, sub.assessorQuote ?? null);
  }
  // Criteria the judge left out of its answer (criterion_skipped events):
  // stored as 0, flagged here so the zero is not read as a judgement.
  const skippedCriteria = readSkippedCriteria(eventRows);
  // Only scored submissions are attempts; a pending or failed row (judge
  // unavailable) gets no number and offers a Rescore instead.
  const attemptNumbers = numberAttempts(submissionRows);

  // Named in the inline confirm step so the instructor sees which learner and
  // which stage the override applies to before it runs.
  const currentStageId = engagement.currentStage as StageId;
  const forcedTarget = nextStage(currentStageId);
  const forceConfirmMessage = `Force advance ${who} from "${
    STAGE_TITLES[currentStageId] ?? currentStageId
  }" to ${
    forcedTarget
      ? `"${STAGE_TITLES[forcedTarget] ?? forcedTarget}"`
      : "completion (this ends the engagement)"
  }? The personas are told that the client agreed to move on; that it was your decision is recorded only in the event log. It cannot be undone.`;

  return (
    <div>
      <Link
        href={`/admin/cohorts/${cohort.id}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> Back to {cohort.name}
      </Link>
      <PageHeader
        className="mt-2"
        title={scenario.title}
        description={`${who}${analystModelPart} · stage: ${STAGE_TITLES[currentStageId] ?? currentStageId} · ${engagement.status} · started ${formatUtc(engagement.createdAt)}${wallClock ? ` · ${wallClock}` : ""} · all times UTC${spend ? ` · spend ${formatUsd(spend.totalUsd)}` : ""}${reviewed ? ` · flags ${reviewed.charAt(0).toLowerCase()}${reviewed.slice(1)}` : ""}`}
        action={
          engagement.status === "active" && !readOnly ? (
            <form
              id="force-advance"
              action={async () => {
                "use server";
                await requireWriter();
                // Instructor override for stalled engagements (judge outage,
                // learner stuck at a hard gate). Logged as an event so
                // analyses can separate overridden stage advances. The stage
                // is re-read here rather than taken from the rendered page,
                // so a submission racing a stale view advances exactly one
                // stage from wherever the engagement actually is.
                const [fresh] = await db
                  .select({ currentStage: engagements.currentStage, status: engagements.status })
                  .from(engagements)
                  .where(eq(engagements.id, engagement.id))
                  .limit(1);
                if (!fresh || fresh.status !== "active") return;
                const stage = fresh.currentStage as StageId;
                const to = nextStage(stage);
                // The ledger fact is in-world, since every persona reads it;
                // the instructor detail stays in the stage_forced event.
                await appendWorldFacts(
                  engagement.id,
                  stage,
                  "system",
                  [forcedAdvanceFact(stage, to)],
                  "system",
                );
                if (to) {
                  await advanceStage(engagement.id, to, scenario);
                } else {
                  await completeEngagement(engagement.id);
                }
                await logEvent(engagement.id, engagement.cohortId, "stage_forced", {
                  from: stage,
                  to,
                  by: "instructor",
                });
                revalidatePath(`/admin/engagements/${engagement.id}`);
              }}
            >
              <ConfirmButton message={forceConfirmMessage} confirmLabel="Force advance">
                Force advance stage
              </ConfirmButton>
            </form>
          ) : null
        }
      />

      <StageStrip
        className="mt-4"
        stages={scenario.stages}
        status={(_, i) =>
          engagement.status === "completed" || i < stageIndex(currentStageId)
            ? "done"
            : i === stageIndex(currentStageId)
              ? "current"
              : "later"
        }
      />

      {kind === "scripted" ? (
        <p className="mt-4 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          This run was replayed by an author script from recorded messages and artifacts, not worked live by a
          learner. Its times are replay times.
          {showcaseLabel === "H1" && config.showcase.h1Patch
            ? ` The replay applied ${config.showcase.h1Patch.file}.`
            : ""}
        </p>
      ) : null}

      {unverifiedCriteria > 0 ? (
        <div role="status" className="mt-4 rounded-md border border-flag/40 bg-flag/5 p-3 text-sm text-flag">
          <span className="font-medium">Unverified results: {plural(unverifiedCriteria, "criterion", "criteria")}.</span>{" "}
          {isAgent
            ? "Capped at 40%, because the analyst agent cannot compute."
            : "Scores kept; check the work before relying on them."}
          {isAgent ? null : (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-1">
                {`The ${kind === "scripted" ? "run" : "learner"} reported results that the platform cannot check.`} The
                learner sees each score as the judge&apos;s, which you may review, and is not told which results were
                flagged.
              </p>
            </details>
          )}
        </div>
      ) : null}

      <MonitorSectionNav
        sections={[
          { id: "channels", title: "Channels" },
          { id: "hidden-facts", title: "Hidden facts" },
          { id: "ledger", title: "Ledger" },
          { id: "submissions", title: "Submissions" },
          { id: "events", title: "Event log" },
        ]}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <MonitorSection id="channels" title="Channels" count={chans.length}>
          <div className="mt-3 space-y-3">
            {chans.map((c, i) => {
              const persona = scenario.personas.find((p) => p.id === c.personaId);
              const msgs = transcripts[i];
              return (
                <Disclosure
                  key={c.id}
                  title={`${persona?.channelName ?? c.personaId} (${plural(msgs.length, "message")}${c.unlockedAt ? "" : ", locked"})`}
                >
                  {msgs.length === 0 ? (
                    <p>No messages.</p>
                  ) : (
                    <ul className="max-h-96 space-y-2 overflow-y-auto">
                      {msgs.map((m) => (
                        <li key={m.id} className="text-sm">
                          <span className="font-medium text-foreground">
                            {m.sender === "learner" ? learnerLabel : persona?.name ?? m.sender}:
                          </span>{" "}
                          <span className="whitespace-pre-wrap">
                            {m.sender === "learner" && isAgent ? plainChatText(m.content) : m.content}
                          </span>
                          {releaseNotes.get(m.id) ? (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              Platform: {releaseNotes.get(m.id)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Disclosure>
              );
            })}
          </div>
          </MonitorSection>

          <MonitorSection id="hidden-facts" title="Hidden facts obtained" className="mt-8">
          <p className="mt-1 text-xs text-muted-foreground">
            {traceRecorded ? (
              <>
                {elicitation.obtained} of {elicitation.total} reported by the persona, {elicitation.verified} verified
                in the delivered reply ({elicitation.reachable} reachable at this stage). The count is the number of{" "}
                {isAgent ? "agent messages" : "learner messages"}
                {" "}sent when the fact was first given; &quot;early&quot; marks a fact the consistency auditor flagged
                as given before its condition was met.
              </>
            ) : (
              <>
                Not recorded: this run predates the elicitation trace, so the table cannot say which
                facts were given. Read the transcripts above instead.
              </>
            )}
          </p>
          <table className="mt-3 w-full rounded-lg border text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="px-3 py-1.5 font-medium">Fact</th>
                <th scope="col" className="px-3 py-1.5 font-medium">Held by</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Obtained at message</th>
              </tr>
            </thead>
            <tbody>
              {elicitation.facts.map((f) => (
                <tr key={f.id} className="border-b last:border-0">
                  <td className="px-3 py-1.5">{humanizeId(f.id)}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{personaNames[f.persona] ?? f.persona}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {!traceRecorded ? (
                      <span className="text-muted-foreground">{NOT_RECORDED}</span>
                    ) : (
                      (f.obtainedAtLearnerMessage ?? <span className="text-muted-foreground">not obtained</span>)
                    )}
                    {traceRecorded && f.obtainedAtLearnerMessage !== null && f.early ? (
                      <span className="ml-1 font-sans text-flag"> (early)</span>
                    ) : null}
                    {f.obtainedAtLearnerMessage !== null && f.verifiedAtLearnerMessage === null ? (
                      <span className="block font-sans text-muted-foreground">not found in the reply</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </MonitorSection>

          <MonitorSection id="ledger" title="World-fact ledger" count={ledgerRows.length} defaultOpen={ledgerRows.length <= LONG_SECTION} className="mt-8">
          <p className="mt-1 text-xs text-muted-foreground">
            Every persona reads this ledger before each reply. The consistency auditor checks
            each persona&apos;s first two replies, every gate reaction, every reply that reveals a
            hidden fact, and a sample of the rest against it; its verdicts are in the event
            log. Each fact is tagged with where it came from: seed (scenario set-up), release
            profile (the platform&apos;s profile of a released file), system (a platform event),
            persona (written by a stakeholder from its own reply), elicited (a hidden fact the
            reply stated and the key check confirmed) and detected (a sentence the platform wrote
            on a keyword match in a reply). The judge treats persona and detected facts as claims
            and the others as established. A persona fact that states the same hidden fact as an
            elicited row is shown once, with both tags; the ledger stores both rows.
          </p>
          <ol className="mt-3 space-y-1.5 rounded-lg border p-4 text-sm text-muted-foreground">
            {ledgerRows.map((f, i) => (
              <li key={i}>
                •{" "}
                {/* Provenance is a neutral tag; red is kept for audit flags. */}
                {f.tags.map((t) => (
                  <span key={t} className="mr-1 rounded border px-1 py-px text-xs text-muted-foreground">
                    {PROVENANCE_LABELS[t]}
                  </span>
                ))}
                {f.fact}
                {f.personaWording ? (
                  <details className="ml-3 text-xs">
                    <summary className="cursor-pointer">Persona wording</summary>
                    <span className="block">{f.personaWording}</span>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
          </MonitorSection>
        </section>

        <section>
          <MonitorSection id="submissions" title="Submissions & rubric scores" count={submissionRows.length}>
          <div className="mt-3 space-y-3">
            {submissionRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No submissions yet.</p>
            ) : (
              submissionRows.map((s) => {
                const scores = scoreRows.filter((r) => r.submissionId === s.id);
                // Effective totals: the instructor's override where there is
                // one, otherwise the judge (lib/engagement/effective-score.ts).
                const totals = submissionTotals(scores);
                const max = totals.max;
                const unscored = s.status !== "scored";
                const badge = unscored
                  ? {
                      label: s.status === "failed" ? "Judge unavailable, not an attempt" : "Pending, not an attempt",
                      tone: "neutral" as const,
                    }
                  : describeGateOutcome({
                      scored: scores.length > 0,
                      outcome: gateOutcomes.get(s.id) ?? null,
                      fallbackMinScoreRatio: config.gates.minScoreRatio,
                      ratio: max > 0 ? totals.effective / max : 0,
                    });
                const flagQuote = submissionFlags.get(s.id) ?? null;
                const skipped = skippedCriteria.get(s.id) ?? new Set<string>();
                return (
                  <div key={s.id} className="space-y-1.5">
                  <Disclosure
                    title={
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span>
                          {STAGE_TITLES[s.stage as StageId] ?? s.stage} · {humanizeId(s.kind)}
                        </span>
                        {attemptNumbers.has(s.id) ? (
                          <span className="text-xs text-muted-foreground">
                            attempt {attemptNumbers.get(s.id)}
                          </span>
                        ) : null}
                        <span className="font-mono text-xs">
                          {max > 0 ? formatTotals(totals) : s.status}
                        </span>
                        <span className={`${gateToneClass(badge.tone)} text-xs`}>
                          {badge.label}
                        </span>
                        {totals.adjusted ? (
                          <span className="text-xs text-muted-foreground">
                            gate decided on the judge&apos;s score; the override does not change progression
                          </span>
                        ) : null}
                        {skipped.size > 0 ? (
                          <span className={`${gateToneClass("fail")} text-xs`}>
                            Judge skipped {plural(skipped.size, "criterion", "criteria")}
                          </span>
                        ) : null}
                        {scores.some((r) => r.unverifiedClaim) ? (
                          <span className={`${gateToneClass("fail")} text-xs`}>Unverified result</span>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {formatUtc(s.createdAt)}
                        </span>
                      </span>
                    }
                  >
                    <div className="space-y-3">
                      {unscored && !readOnly ? (
                        <form
                          action={async () => {
                            "use server";
                            await requireWriter();
                            // Scores a submission the judge never scored. On
                            // the engagement's current stage the gate policy
                            // applies as usual (lib/agents/rescore.ts).
                            await rescoreSubmission(s.id, config);
                            revalidatePath(`/admin/engagements/${engagement.id}`);
                          }}
                          className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-xs text-muted-foreground"
                        >
                          <span className="flex-1">
                            The judge did not score this submission, so it does not count as an
                            attempt. Rescore it now with the current judge.
                          </span>
                          <PendingButton size="sm">Rescore</PendingButton>
                        </form>
                      ) : null}
                      <ul className="space-y-2">
                        {scores.map((r) => (
                          <li key={r.id} className="rounded-md bg-muted/40 p-2.5">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="font-medium text-foreground">
                                {humanizeId(r.criterionId)}
                                {skipped.has(r.criterionId) ? (
                                  <span className="ml-2 rounded border border-flag/40 px-1 py-px text-[10px] font-normal text-flag">
                                    skipped by the judge
                                  </span>
                                ) : null}
                              </span>
                              <span className="shrink-0 font-mono text-xs">
                                {r.overrideScore !== null ? (
                                  <>
                                    <s className="text-muted-foreground">{r.score}</s>{" "}
                                    {r.overrideScore}/{r.maxScore}
                                  </>
                                ) : (
                                  <>
                                    {r.score}/{r.maxScore}
                                  </>
                                )}
                              </span>
                            </div>
                            <Rationale text={r.rationale} improve={r.improve} className="text-foreground" />
                            {statedNotElicited(r).length > 0 ? (
                              <p className="mt-1 text-xs text-foreground">
                                <span className="font-medium">Stated but not elicited:</span>{" "}
                                {statedNotElicited(r).map(humanizeId).join(", ")}. The submission states
                                these facts, but the trace does not show the learner obtaining them.
                              </p>
                            ) : null}
                            {r.unverifiedClaim ? (
                              <p className="mt-1 text-xs text-flag">
                                Unverified result
                                {unverifiedNotes.get(`${s.id}:${r.criterionId}`)
                                  ? `: ${unverifiedNotes.get(`${s.id}:${r.criterionId}`)}`
                                  : ""}
                                {r.rawScore !== null && r.rawScore !== r.score
                                  ? `. Judge's score before the cap: ${r.rawScore}/${r.maxScore}.`
                                  : ". Judge's score kept."}
                              </p>
                            ) : null}
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {r.judgeModel}
                              {r.servedModel && r.servedModel !== r.judgeModel
                                ? ` (served ${r.servedModel})`
                                : ""}{" "}
                              · {r.promptVersion}
                              {r.overriddenAt
                                ? ` · overridden ${formatUtc(r.overriddenAt)}${r.overrideNote ? `: ${r.overrideNote}` : ""}`
                                : ""}
                            </p>
                            {readOnly ? null : (
                            <details id={`score-${r.id}`} className="mt-1.5" open={overrideError === String(r.id)}>
                              <summary className="cursor-pointer text-[11px] text-primary">Override</summary>
                              <p className="mt-1 text-[10px] text-muted-foreground">
                                The judge&apos;s score is kept beside yours. An override changes the
                                grade, not progression: the gate decision stands. To move the
                                learner on, use{" "}
                                <a href="#force-advance" className="text-primary underline underline-offset-2">
                                  Force advance stage
                                </a>
                                .
                              </p>
                              <form
                                action={async (formData) => {
                                  "use server";
                                  await requireWriter();
                                  // The judge's score stays untouched; the
                                  // override sits beside it for agreement
                                  // analysis. Empty score clears an override.
                                  const raw = (formData.get("score") as string)?.trim();
                                  const note = ((formData.get("note") as string) ?? "").trim();
                                  const parsedScore = raw === "" ? null : Number(raw);
                                  if (
                                    parsedScore !== null &&
                                    (!Number.isInteger(parsedScore) ||
                                      parsedScore < 0 ||
                                      parsedScore > r.maxScore)
                                  ) {
                                    // Nothing is saved; the page says why
                                    // beside the field.
                                    redirect(`/admin/engagements/${engagement.id}?overrideError=${r.id}#score-${r.id}`);
                                  }
                                  await db
                                    .update(rubricScores)
                                    .set({
                                      overrideScore: parsedScore,
                                      overrideNote: parsedScore === null ? null : note || null,
                                      overriddenAt: parsedScore === null ? null : new Date(),
                                    })
                                    .where(eq(rubricScores.id, r.id));
                                  await logEvent(engagement.id, engagement.cohortId, "score_overridden", {
                                    rubricScoreId: r.id,
                                    criterionId: r.criterionId,
                                    judgeScore: r.score,
                                    overrideScore: parsedScore,
                                  });
                                  revalidatePath(`/admin/engagements/${engagement.id}`);
                                }}
                                className="mt-2 flex flex-wrap items-center gap-2"
                              >
                                <span className="w-full text-[10px] text-muted-foreground">
                                  Enter a whole number from 0 to {r.maxScore}, or leave it blank to
                                  clear an existing override.
                                </span>
                                {overrideError === String(r.id) ? (
                                  <span role="alert" className="w-full text-[11px] text-flag">
                                    Not saved: the override must be a whole number from 0 to {r.maxScore}.
                                  </span>
                                ) : null}
                                <input
                                  name="score"
                                  type="number"
                                  min={0}
                                  max={r.maxScore}
                                  step={1}
                                  defaultValue={r.overrideScore ?? ""}
                                  placeholder={`0–${r.maxScore}`}
                                  aria-label={`Override score for ${r.criterionId}`}
                                  className="h-7 w-20 rounded-md border bg-background px-2 text-xs"
                                />
                                <input
                                  name="note"
                                  type="text"
                                  defaultValue={r.overrideNote ?? ""}
                                  placeholder="Reason (optional)"
                                  aria-label="Override note"
                                  className="h-7 min-w-40 flex-1 rounded-md border bg-background px-2 text-xs"
                                />
                                <PendingButton size="sm">Save</PendingButton>
                              </form>
                            </details>
                            )}
                          </li>
                        ))}
                      </ul>
                      <details>
                        <summary className="cursor-pointer text-xs text-primary">
                          Submitted text
                        </summary>
                        <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
                          {s.contentText}
                        </p>
                      </details>
                      {config.research.reflections && s.reflectionText ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-primary">
                            Learner reflection (unscored)
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap rounded-md border p-3 text-xs">
                            {s.reflectionText}
                          </p>
                        </details>
                      ) : null}
                    </div>
                  </Disclosure>
                  {submissionFlags.has(s.id) ? (
                    <div
                      role="status"
                      className="rounded-md border border-flag/40 bg-flag/5 p-2.5 text-xs text-flag"
                    >
                      <span className="font-medium">
                        This submission contained text addressed to the assessor
                      </span>
                      {flagQuote ? (
                        <>
                          : <span className="whitespace-pre-wrap">“{flagQuote.trim().replace(/[.!?]+$/, "")}”</span>
                        </>
                      ) : null}
                      . The judge scored it on its merits.
                    </div>
                  ) : null}
                  </div>
                );
              })
            )}
          </div>
          </MonitorSection>
        </section>
      </div>

      {/* Full width: the table has six columns and a detail line. */}
      <section className="mt-8">
        <MonitorSection id="events" title="Event log" count={eventRows.length} defaultOpen={eventRows.length <= LONG_SECTION}>
          <EventLog
            events={eventRows.map((e) => ({
              id: e.id,
              type: e.type,
              timestampIso: e.timestampIso,
              detailJson: e.detailJson,
            }))}
            personaNames={personaNames}
          />
        </MonitorSection>
      </section>

      {readOnly ? null : showcaseLabel ? (
        <section className="mt-8 rounded-lg border p-4">
          <h2 className="text-sm font-medium">Delete this engagement</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            This is showcase run {showcaseLabel}, which cannot be deleted on its own. To remove the
            showcase, delete the whole cohort from its settings page.
          </p>
        </section>
      ) : (
        <section className="mt-8 rounded-lg border p-4">
          <h2 className="text-sm font-medium">Delete this engagement</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            For a learner&apos;s deletion request. To delete the learner with all of their
            engagements, use Delete in the cohort&apos;s learner list.
          </p>
          <div className="mt-2">
            <DeleteConfirm
              kind="engagement"
              id={engagement.id}
              phrase={confirmationPhrase("engagement", engagement)}
              buttonLabel="Delete engagement"
              redirectTo={`/admin/cohorts/${cohort.id}`}
            />
          </div>
        </section>
      )}
    </div>
  );
}

// A ledger or event log longer than this starts collapsed, so the page
// opens at a readable length; the section links above still reach it.
const LONG_SECTION = 40;

// Agent I's per-criterion list of withheld facts the submission states
// although the trace does not show them obtained (rubric-v7). Null on rows
// scored before the check.
function statedNotElicited(row: { statedNotElicited?: unknown }): string[] {
  return Array.isArray(row.statedNotElicited)
    ? row.statedNotElicited.filter((x): x is string => typeof x === "string")
    : [];
}
