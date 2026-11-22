"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Rationale } from "@/components/ui/rationale";
import { MIN_ARTIFACT_CHARS, parseWordTarget, wordCountLine } from "@/lib/engagement/artifact-text";
import { attemptNumbers as numberAttempts, attemptsUsed } from "@/lib/engagement/attempts";
import {
  exchangeCapCopy,
  formatScoreRatio,
  gateExpectationCopy,
  gateOutcomeCopy,
  gateShortfallCopy,
  noReactionCopy,
  type GateDecision,
} from "@/lib/engagement/gate-policy";
import { cn, humanizeId, reflowProse } from "@/lib/utils";
import { phaseLabel, stageLead } from "@/lib/scenarios/phases";
import type { BundleScore, BundleStage, BundleSubmission, WorkspaceBundle } from "./types";
import { clearDraft, draftSavedLine, loadDraft, saveDraft } from "./draft-stash";
import { formatLearnerTime } from "./learner-time";
import { localBudgetRefusal } from "@/lib/llm/budget-format";
import { belowTargetNote, underTargetQuestion, noReleaseQuestion } from "./length-check";
import {
  adjustedLine,
  criterionScore,
  FORMATIVE_CARRY_LINE,
  improveFor,
  MOCK_LINE,
  otherDeviceLine,
  pointsLine,
  reviewNote,
} from "./learner-copy";

// How long typing pauses before the draft is written to the browser.
const DRAFT_SAVE_DELAY_MS = 800;

interface SubmitResponse {
  submissionId: string;
  passed: boolean | null;
  reason: GateDecision["reason"];
  advanced: boolean;
  engagementCompleted: boolean;
  newStage: string | null;
  attempt: number;
  clientReacted: boolean;
  scoreRatio: number | null;
  scores: BundleScore[];
}

// The banner above the editor, from either the submission just made or the
// last one that did not advance (which survives a reload; see the draft
// restore below).
interface OutcomeBanner {
  headline: string;
  tone: "pass" | "neutral" | "shortfall";
  detail: string | null;
  clientReacted: boolean;
  restored: boolean;
  scores: BundleScore[];
  // The stage the scores belong to, for the criterion text beside them.
  stage: string;
  // Whether the instructor has reviewed the submission behind the banner.
  reviewed: boolean;
}

export function StagePanel({
  bundle,
  onStateChange,
  onOpenClientChannel,
}: {
  bundle: WorkspaceBundle;
  onStateChange: () => Promise<void>;
  onOpenClientChannel?: () => void;
}) {
  const { scenario, engagement, submissions, ui, gates, research } = bundle;
  const stage = scenario.stages.find((s) => s.id === engagement.currentStage);
  // An earlier engagement opened from the list is read-only like a
  // completed one: no editor, no draft.
  const completed = engagement.status === "completed" || engagement.past === true;
  const joinRoute = bundle.learner.joinRoute;
  const mock = bundle.learner.provider === "mock";
  const formative = gates.minScoreRatio === null;
  const audience = joinRoute === "sandbox" ? "sandbox" : "course";

  // Attempts already made at the stage the learner is standing on. A stage
  // only holds submissions while it has not advanced, so the last one here is
  // the draft that fell short and is waiting to be revised.
  const stageAttempts = submissions.filter((s) => s.stage === engagement.currentStage);
  const lastAttempt = completed ? null : (stageAttempts.at(-1) ?? null);

  // An autosaved draft is newer than the last attempt: it is cleared on every
  // successful submission, so one that exists was typed after that attempt.
  const [initialDraft] = useState(() =>
    typeof window === "undefined" || completed ? null : loadDraft(engagement.id, engagement.currentStage),
  );
  const [text, setText] = useState(initialDraft?.text ?? lastAttempt?.text ?? "");
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(initialDraft?.savedAt ?? null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function editText(next: string) {
    setText(next);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const stageId = engagement.currentStage;
    draftTimer.current = setTimeout(() => {
      const saved = saveDraft(engagement.id, stageId, next);
      setDraftSavedAt(saved?.savedAt ?? null);
    }, DRAFT_SAVE_DELAY_MS);
  }
  const [reflection, setReflection] = useState(lastAttempt?.reflection ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set while the learner is asked to confirm a submission under the word
  // target; the question names the attempt it will use.
  const [confirmShort, setConfirmShort] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<string | null>(null);

  // Warnings the learner has already answered with "Submit anyway" for the
  // submission in hand; cleared when it is sent or they go back to writing.
  const [acknowledged, setAcknowledged] = useState<string[]>([]);

  function requestSubmit(ack: string[] = acknowledged) {
    const questions: { kind: string; text: string | null }[] = [
      {
        kind: "no-release",
        text: noReleaseQuestion({
          releasedFiles: bundle.releasedFiles.length,
          pendingFiles: bundle.pendingFiles?.length ?? 0,
        }),
      },
      {
        kind: "short",
        text: underTargetQuestion({
          text,
          target: stage ? parseWordTarget(stage.gate.instructions) : null,
          attemptsUsed: attemptsUsed(submissions, engagement.currentStage),
          minScoreRatio: gates.minScoreRatio,
          maxRetries: gates.maxRetries,
        }),
      },
    ];
    const next = questions.find((q) => q.text && !ack.includes(q.kind));
    if (next) {
      setConfirmShort(next.text);
      setConfirmKind(next.kind);
      return;
    }
    setConfirmShort(null);
    setConfirmKind(null);
    setAcknowledged([]);
    void submit();
  }

  async function submit() {
    if (submitting || text.trim().length < MIN_ARTIFACT_CHARS) return;
    const stageId = engagement.currentStage;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/engagement/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        reflection: research?.reflections ? reflection.trim() || undefined : undefined,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as SubmitResponse;
      setOutcome(data);
      // The submission holds the text now; a stage that did not advance
      // restores it from the attempt, so the draft copy is no longer needed.
      clearDraft(engagement.id, stageId);
      setDraftSavedAt(null);
      // A stage that did not advance is going to be rewritten, so the draft
      // stays in the box to be revised. An advanced stage starts clean.
      if (data.advanced) {
        setText("");
        setReflection("");
      }
      await onStateChange();
    } else {
      // A refusal with its own explanation (the daily usage limit) is shown
      // as sent; anything else is a scoring failure.
      const body = (await res.json().catch(() => null)) as
        | { error?: string; message?: string; resetsAtIso?: string }
        | null;
      setError(
        localBudgetRefusal("submit", body, undefined, audience) ??
          "Submission failed to score. Nothing was lost; try again in a moment.",
      );
    }
    setSubmitting(false);
  }

  const attemptNumbers = numberAttempts(submissions);
  // Only scored submissions use up an attempt (lib/engagement/attempts.ts).
  const scoredAttempts = attemptsUsed(submissions, engagement.currentStage);
  const pastSubmissions = [...submissions].reverse();
  const target = stage ? parseWordTarget(stage.gate.instructions) : null;
  // The visible line is the authored lead for the stage (lib/scenarios/
  // phases.ts); the scenario's guidance stays whole under "More guidance".
  const guidance = stage ? reflowProse(stage.guidance) : "";
  const lead = stage ? stageLead(stage.id, guidance) : "";
  const exchangeCaps = stage ? exchangeCapCopy(stage.gate.rubric, scenario.personas) : [];
  const expectation = gateExpectationCopy({
    minScoreRatio: gates.minScoreRatio,
    maxRetries: gates.maxRetries,
    attemptsUsed: scoredAttempts,
  });
  const banner = buildBanner({
    outcome,
    lastAttempt,
    attempt: scoredAttempts,
    minScoreRatio: gates.minScoreRatio,
    showRubricScores: ui.showRubricScores,
    nextStageTitle:
      scenario.stages.find((s) => s.id === outcome?.newStage)?.title ?? outcome?.newStage ?? "",
    submittedStage:
      submissions.find((s) => s.id === outcome?.submissionId)?.stage ?? engagement.currentStage,
  });

  return (
    <div className="max-w-2xl space-y-8">
      {banner ? (
        <section
          className={cn(
            "rounded-lg border p-4",
            banner.tone === "pass"
              ? "border-primary/40 bg-primary/5"
              : banner.tone === "neutral"
                ? "border-muted-foreground/40 bg-muted/40"
                : "border-foreground/30 bg-muted/40",
          )}
        >
          <h3 className="font-medium">{banner.headline}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {banner.detail ? `${banner.detail} ` : null}
            {banner.clientReacted ? (
              <>
                The client sponsor has also replied{" "}
                {onOpenClientChannel ? (
                  <button
                    type="button"
                    onClick={onOpenClientChannel}
                    className="text-primary underline underline-offset-4"
                  >
                    in their channel
                  </button>
                ) : (
                  "in their channel"
                )}
                .
              </>
            ) : outcome ? (
              noReactionCopy({
                reason: outcome.reason,
                engagementCompleted: outcome.engagementCompleted,
              })
            ) : null}
            {banner.restored ? " Your draft is back in the box below, ready to revise." : null}
          </p>
          {banner.scores.length > 0 ? (
            <>
              <p className="mt-2 text-sm text-foreground">{reviewNote(banner.reviewed, joinRoute)}</p>
              <ScoreList
                scores={banner.scores}
                criteria={criteriaFor(scenario.stages, banner.stage)}
                mock={mock}
                formative={formative}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {/* A completed engagement is announced once, by the banner at the top
          of the workspace; the panel goes straight to the submissions. */}
      {completed ? null : stage ? (
        <>
          <section>
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Current stage
            </p>
            <h2 className="mt-1 text-lg font-semibold">{phaseLabel(stage.id, stage.title)}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{lead}</p>
            {guidance && guidance !== lead ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-primary">More guidance</summary>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {guidance}
                </p>
              </details>
            ) : null}
          </section>

          <section className="rounded-lg border p-4">
            {/* The panel heading already names the stage, so the title sits
                quietly beside the gate name rather than on its own line. */}
            <h3 className="font-medium">
              Stage gate: {humanizeId(stage.gate.kind)}
              <span className="font-normal text-muted-foreground"> · {stage.title}</span>
            </h3>
            <p className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
              {expectation.join(" ")}
              {exchangeCaps.length > 0 ? ` ${exchangeCaps.join(" ")}` : null}
            </p>
            {/* Open until the first attempt at this stage, collapsed after. */}
            <details className="mt-3" open={stageAttempts.length === 0}>
              <summary className="cursor-pointer text-sm text-primary">What to submit</summary>
              <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
                {reflowProse(stage.gate.instructions)}
              </p>
            </details>

            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-primary">
                How this will be assessed
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">
                {stage.gate.rubric.reduce((sum, c) => sum + c.maxScore, 0)} points in total,
                split across {stage.gate.rubric.length} criteria.
              </p>
              <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                {stage.gate.rubric.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium text-foreground">
                      {humanizeId(c.id)}, {c.maxScore} {c.maxScore === 1 ? "point" : "points"}
                    </span>
                    {c.criterion ? `: ${c.criterion}` : null}
                  </li>
                ))}
              </ul>
            </details>

            <textarea
              value={text}
              onChange={(e) => editText(e.target.value)}
              aria-label={`Stage artifact: ${humanizeId(stage.gate.kind)}`}
              rows={12}
              maxLength={20000}
              disabled={submitting}
              placeholder="Paste or write your artifact here…"
              className="mt-4 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            <p className="mt-1.5 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {wordCountLine(text, target)}
                {/* Below the submit floor the counter already says "too short
                    to submit"; "below the target" beside it only repeats it. */}
                {text.trim().length >= MIN_ARTIFACT_CHARS && belowTargetNote(text, target)
                  ? ` · ${belowTargetNote(text, target)}`
                  : null}
              </span>
              <span role="status">{draftSavedAt ? draftSavedLine(draftSavedAt) : null}</span>
            </p>
            {draftSavedAt ? (
              <p className="mt-0.5 text-right text-xs text-muted-foreground">
                {otherDeviceLine(joinRoute)}
              </p>
            ) : null}

            {research?.reflections ? (
              <label className="mt-3 block text-sm">
                <span className="text-muted-foreground">
                  Reflection (optional, not scored): what was hardest at this stage, and what
                  would you do differently?
                </span>
                <textarea
                  value={reflection}
                  onChange={(e) => setReflection(e.target.value)}
                  rows={3}
                  maxLength={5000}
                  disabled={submitting}
                  className="mt-1.5 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </label>
            ) : null}
            {confirmShort ? (
              <div
                role="alertdialog"
                aria-label={confirmKind === "no-release" ? "Submit before the data is released?" : "Submit below the target length?"}
                className="mt-3 rounded-md border border-foreground/30 bg-muted/40 p-3 text-sm"
              >
                <p>{confirmShort}</p>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirmShort(null);
                      setConfirmKind(null);
                      setAcknowledged([]);
                    }}
                  >
                    {confirmKind === "no-release" ? "Not yet" : "Keep writing"}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      const ack = confirmKind ? [...acknowledged, confirmKind] : acknowledged;
                      setAcknowledged(ack);
                      requestSubmit(ack);
                    }}
                  >
                    Submit anyway
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex items-center justify-end">
                <Button
                  variant="primary"
                  loading={submitting}
                  disabled={text.trim().length < MIN_ARTIFACT_CHARS}
                  onClick={() => requestSubmit()}
                >
                  {submitting ? "Scoring…" : "Submit for review"}
                </Button>
              </div>
            )}
            {error ? (
              <p role="alert" className="mt-2 text-xs text-flag">
                {error}
              </p>
            ) : null}
          </section>
        </>
      ) : null}

      {pastSubmissions.length > 0 ? (
        <section>
          <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Past submissions
          </h3>
          <ul className="mt-3 space-y-2">
            {pastSubmissions.map((s) => {
              const stageTitle = scenario.stages.find((st) => st.id === s.stage)?.title ?? s.stage;
              const total = s.scores.reduce((sum, r) => sum + r.score, 0);
              const max = s.scores.reduce((sum, r) => sum + r.maxScore, 0);
              return (
                <li key={s.id}>
                  <Disclosure
                    title={
                      <span className="flex w-full items-baseline justify-between gap-3 text-sm">
                        <span>
                          <span className="font-medium">{stageTitle}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {humanizeId(s.kind)} ·{" "}
                            {attemptNumbers.has(s.id)
                              ? `attempt ${attemptNumbers.get(s.id)}`
                              : "not scored, does not count as an attempt"}{" "}
                            ·{" "}
                            {formatSubmittedAt(s.createdAt)}
                          </span>
                        </span>
                        {ui.showRubricScores && max > 0 ? (
                          <span className="shrink-0 text-right text-xs text-muted-foreground">
                            {pointsLine(total, max)}
                            {s.reviewed ? <span className="block">reviewed</span> : null}
                          </span>
                        ) : null}
                      </span>
                    }
                  >
                    {s.scores.length > 0 ? (
                      <>
                        <p className="px-1 text-sm text-foreground">{reviewNote(s.reviewed, joinRoute)}</p>
                        <ScoreList
                          scores={s.scores}
                          criteria={criteriaFor(scenario.stages, s.stage)}
                          mock={mock}
                          formative={formative}
                        />
                      </>
                    ) : (
                      <p className="px-1 pb-2 text-sm text-muted-foreground">
                        {ui.showRubricScores ? "Not scored yet." : "Scores are held by your instructor."}
                      </p>
                    )}
                    <h4 className="mt-4 text-xs font-medium uppercase tracking-wider">
                      What you submitted
                    </h4>
                    <p className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-line rounded-md bg-muted/40 p-3 text-sm">
                      {s.text}
                    </p>
                    {s.reflection ? (
                      <>
                        <h4 className="mt-4 text-xs font-medium uppercase tracking-wider">
                          Your reflection
                        </h4>
                        <p className="mt-1.5 whitespace-pre-line rounded-md bg-muted/40 p-3 text-sm">
                          {s.reflection}
                        </p>
                      </>
                    ) : null}
                  </Disclosure>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// A submission just made wins; otherwise the last attempt at this stage keeps
// its verdict on screen, so a reload does not leave the restored draft sitting
// there with no explanation of why it came back.
function buildBanner(input: {
  outcome: SubmitResponse | null;
  lastAttempt: BundleSubmission | null;
  attempt: number;
  minScoreRatio: number | null;
  showRubricScores: boolean;
  nextStageTitle: string;
  submittedStage: string;
}): OutcomeBanner | null {
  const { outcome, lastAttempt, minScoreRatio, showRubricScores } = input;

  if (outcome) {
    const copy = gateOutcomeCopy({
      reason: outcome.reason,
      attempt: outcome.attempt,
      nextStageTitle: input.nextStageTitle,
      engagementCompleted: outcome.engagementCompleted,
    });
    return {
      headline: copy.headline,
      tone: copy.tone,
      detail: scoreDetail(outcome.scoreRatio, outcome.reason, minScoreRatio, outcome.scores),
      clientReacted: outcome.clientReacted,
      restored: false,
      scores: outcome.scores,
      stage: input.submittedStage,
      reviewed: false,
    };
  }

  if (!lastAttempt) return null;
  const total = lastAttempt.scores.reduce((sum, r) => sum + r.score, 0);
  const max = lastAttempt.scores.reduce((sum, r) => sum + r.maxScore, 0);
  const copy = gateOutcomeCopy({
    reason: "below-threshold",
    attempt: input.attempt,
    nextStageTitle: "",
    engagementCompleted: false,
  });
  return {
    headline: copy.headline,
    tone: copy.tone,
    detail:
      showRubricScores && max > 0
        ? scoreDetail(total / max, "below-threshold", minScoreRatio, lastAttempt.scores)
        : null,
    clientReacted: false,
    restored: true,
    scores: lastAttempt.scores,
    stage: lastAttempt.stage,
    reviewed: lastAttempt.reviewed === true,
  };
}

// "Overall: 16 of 20 points." in the one score format the learner sees, and
// below a pass mark, the mark it fell short of.
function scoreDetail(
  scoreRatio: number | null,
  reason: GateDecision["reason"],
  minScoreRatio: number | null,
  scores: BundleScore[],
): string | null {
  if (scoreRatio === null) return null;
  const max = scores.reduce((sum, r) => sum + r.maxScore, 0);
  const total = scores.reduce((sum, r) => sum + r.score, 0);
  const overall = max > 0 ? `Overall: ${pointsLine(total, max)}.` : null;
  if ((reason === "below-threshold" || reason === "retries-exhausted") && minScoreRatio !== null && max > 0) {
    return `${overall} The pass mark is ${pointsLine(Math.ceil(minScoreRatio * max), max)} (${formatScoreRatio(minScoreRatio)}).`;
  }
  if (reason === "below-threshold" || reason === "retries-exhausted") {
    const shortfall = gateShortfallCopy({ scoreRatio, minScoreRatio });
    if (shortfall) return shortfall;
  }
  return overall ?? `Overall: ${formatScoreRatio(scoreRatio)}.`;
}

// "30 Sep, 01:37 SGT": always dated, with the learner's zone.
function formatSubmittedAt(iso: string): string {
  return formatLearnerTime(iso, { withDate: true });
}

// Learner wording of each criterion for a stage, keyed by criterion id
// (lib/engagement/rubric-visibility.ts).
function criteriaFor(stages: BundleStage[], stageId: string): Map<string, string> {
  const stage = stages.find((s) => s.id === stageId);
  return new Map(
    (stage?.gate.rubric ?? [])
      .filter((c): c is { id: string; criterion: string; maxScore: number } => c.criterion !== null)
      .map((c) => [c.id, c.criterion]),
  );
}

// One card per criterion: the standing score, the learner wording of the
// criterion, an instructor adjustment with its note, the judge's reasoning
// and one suggestion. On the offline mock the reasoning and the suggestion
// are placeholders, so one plain line replaces them.
function ScoreList({
  scores,
  criteria,
  mock,
  formative,
}: {
  scores: BundleScore[];
  criteria: Map<string, string>;
  mock: boolean;
  formative: boolean;
}) {
  const anyImprove = !mock && scores.some((r) => improveFor(r) !== null);
  return (
    <>
      {mock ? <p className="mt-2 text-sm text-foreground">{MOCK_LINE}</p> : null}
      <ul className="mt-3 space-y-2">
        {scores.map((r) => (
          <li key={r.criterionId} className="rounded-md bg-muted/40 p-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{humanizeId(r.criterionId)}</span>
              <span className="shrink-0 font-mono text-xs">{criterionScore(r.score, r.maxScore)}</span>
            </div>
            {criteria.get(r.criterionId) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Criterion: {criteria.get(r.criterionId)}
              </p>
            ) : null}
            {r.adjusted && r.judgeScore !== undefined ? (
              <p className="mt-1 text-foreground">
                <span className="font-medium">{adjustedLine(r.judgeScore, r.maxScore)}</span>
                {r.overrideNote ? `: ${r.overrideNote}` : "."}
              </p>
            ) : null}
            {mock ? null : (
              <>
                {r.adjusted ? (
                  <p className="mt-1 text-xs text-muted-foreground">The judge&apos;s reasoning:</p>
                ) : null}
                <Rationale text={r.rationale} improve={improveFor(r)} />
              </>
            )}
          </li>
        ))}
      </ul>
      {formative && anyImprove ? (
        <p className="mt-2 text-sm text-foreground">{FORMATIVE_CARRY_LINE}</p>
      ) : null}
    </>
  );
}
