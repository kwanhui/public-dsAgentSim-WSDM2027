// Run cards and stage-by-stage rows of the compare view.

import Link from "next/link";
import { Disclosure } from "@/components/ui/disclosure";
import { Rationale } from "@/components/ui/rationale";
import { humanizeId } from "@/lib/utils";
import type { CohortConfig } from "@/lib/cohort/defaults";
import type { RubricScore } from "@/lib/engagement/state";
import { STAGE_IDS, STAGE_TITLES, type StageId } from "@/lib/scenarios/types";
import {
  describeGateOutcome,
  formatCount,
  formatDuration,
  formatUtc,
  gateThresholdLabel,
  gateToneClass,
  plural,
  signed,
} from "@/lib/admin/format";
import { NOT_RECORDED, analystModelLabel } from "@/lib/admin/run-provenance";
import { hiddenFactsLine } from "@/lib/admin/elicitation-recorded";
import { formatUsd } from "@/lib/llm/budget-format";
import { RUN_KIND_LABELS, WALL_CLOCK_LABELS } from "@/lib/admin/run-kind";
import type { Attempt, SideData, StageCell } from "./side-data";
import { reachedCount, withPercent } from "./summary";

export function RunCard({ side, data }: { side: string; data: SideData | null }) {
  if (!data) {
    return (
      <section
        aria-label={`${side} engagement`}
        className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
      >
        Choose an engagement for the {side.toLowerCase()} column.
      </section>
    );
  }
  const { engagement, learnerHash, isAgent } = data;
  return (
    <section aria-label={`${side} engagement`} className="min-w-0 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-medium">{data.scenario.title}</h2>
        {/* Plain text: badges are kept for status. */}
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {RUN_KIND_LABELS[data.kind]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {side} ·{" "}
        {data.config.showcase.labels[engagement.id] ? (
          <span className="font-medium text-foreground">{data.config.showcase.labels[engagement.id]} · </span>
        ) : null}
        {isAgent
          ? `agent run ${engagement.id.slice(0, 8)}…`
          : data.kind === "scripted"
            ? `replay seat ${learnerHash.slice(0, 12)}…`
            : `learner ${learnerHash.slice(0, 12)}…`}{" "}
        · {data.cohortName} · {engagement.status} ·{" "}
        {STAGE_TITLES[engagement.currentStage as StageId] ?? engagement.currentStage} ·{" "}
        <Link
          href={`/admin/engagements/${engagement.id}`}
          className="text-primary underline underline-offset-2"
        >
          full monitor
        </Link>
      </p>
      {data.cohortArchived ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Archived cohort, opened from a link; it is not in the pickers above.
        </p>
      ) : null}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Rubric, whole run</dt>
          <dd className="min-w-0 break-words font-mono">
            {withPercent(data.totals.score, data.totals.max)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Stages reached</dt>
          <dd className="min-w-0 break-words font-mono">
            {reachedCount(data)}/{STAGE_IDS.length}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Persona model</dt>
          <dd className="min-w-0 break-words font-mono">{data.personaModel ?? NOT_RECORDED}</dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Persona prompt</dt>
          <dd className="min-w-0 break-words font-mono">{data.personaPrompt ?? NOT_RECORDED}</dd>
        </div>
        {isAgent ? (
          <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
            <dt className="text-muted-foreground">Analyst model</dt>
            <dd className="min-w-0 break-words font-mono">{analystModelLabel(data)}</dd>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Judge model</dt>
          <dd className="min-w-0 break-words font-mono">{data.judgeModel ?? NOT_RECORDED}</dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Judge prompt</dt>
          <dd className="min-w-0 break-words font-mono">{data.judgePrompt ?? NOT_RECORDED}</dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Auditor prompt</dt>
          <dd className="min-w-0 break-words font-mono">{data.auditorPrompt ?? NOT_RECORDED}</dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Messages, whole run</dt>
          <dd className="min-w-0 break-words font-mono">
            {formatCount(data.totals.learnerMessages)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Tokens (all metered calls)</dt>
          <dd className="min-w-0 break-words font-mono">{formatCount(data.totals.meteredTokens)}</dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Hidden facts obtained</dt>
          <dd className="min-w-0 break-words font-mono">
            {hiddenFactsLine(data.elicitation, data.elicitationRecorded, { alwaysVerified: true })}
          </dd>
        </div>
        {data.usd !== null ? (
          <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
            <dt className="text-muted-foreground">Spend</dt>
            <dd className="min-w-0 break-words font-mono">{formatUsd(data.usd)}</dd>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">Started</dt>
          <dd className="min-w-0 break-words">{formatUtc(engagement.createdAt)}</dd>
        </div>
        <div className="flex min-w-0 flex-col sm:flex-row sm:gap-1.5">
          <dt className="text-muted-foreground">{WALL_CLOCK_LABELS[data.kind]}</dt>
          <dd className="min-w-0 break-words">
            {formatDuration(data.totals.durationMs)}
            {excludedNote(data.totals.failedAttempts, data.totals.interruptedAttempts)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

// " (1 failed attempt excluded)", " (1 failed and 1 interrupted attempt
// excluded)", or nothing.
function excludedNote(failed: number, interrupted: number): string {
  if (failed === 0 && interrupted === 0) return "";
  if (interrupted === 0) return ` (${plural(failed, "failed attempt")} excluded)`;
  if (failed === 0) return ` (${plural(interrupted, "interrupted attempt")} excluded)`;
  return ` (${plural(failed, "failed attempt")} and ${plural(interrupted, "interrupted attempt")} excluded)`;
}

export function StageRow({
  stage,
  left,
  right,
}: {
  stage: StageId;
  left: SideData | null;
  right: SideData | null;
}) {
  const leftCell = left?.stages[stage] ?? null;
  const rightCell = right?.stages[stage] ?? null;
  const leftScored = (leftCell?.max ?? 0) > 0;
  const rightScored = (rightCell?.max ?? 0) > 0;
  const scoreDelta =
    leftScored && rightScored ? (leftCell?.score ?? 0) - (rightCell?.score ?? 0) : null;
  const onlyReached =
    leftCell && rightCell && leftCell.reached !== rightCell.reached
      ? leftCell.reached
        ? "left"
        : "right"
      : null;
  const onlyScored =
    scoreDelta === null && leftScored !== rightScored ? (leftScored ? "left" : "right") : null;
  // The gate threshold is stated once per stage row; the badges below say
  // only what happened. Two runs under different policies name both.
  const thresholds = [
    ...new Set(
      [left, right]
        .filter((d): d is SideData => d !== null)
        .map((d) => gateThresholdLabel(stageThreshold(d, stage))),
    ),
  ];

  return (
    <section aria-label={STAGE_TITLES[stage]} className="rounded-lg border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/30 px-4 py-2">
        <h3 className="text-sm font-medium">
          <span className="text-muted-foreground">{STAGE_IDS.indexOf(stage) + 1}.</span>{" "}
          {STAGE_TITLES[stage]}
          {thresholds.length > 0 ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {thresholds.join("; ")}
            </span>
          ) : null}
        </h3>
        <p className="text-xs text-muted-foreground">
          {scoreDelta !== null ? (
            <>
              rubric delta (left − right):{" "}
              <span className="font-mono text-foreground">{signed(scoreDelta)}</span>
            </>
          ) : onlyScored ? (
            `only the ${onlyScored} run has a scored artifact here`
          ) : onlyReached ? (
            `reached by the ${onlyReached} run only`
          ) : (
            "no scored artifact on either side yet"
          )}
        </p>
      </div>
      <div className="grid gap-px bg-border lg:grid-cols-2">
        <StageCellView cell={leftCell} data={left} side="Left" />
        <StageCellView cell={rightCell} data={right} side="Right" />
      </div>
      <AttemptRows leftCell={leftCell} rightCell={rightCell} left={left} right={right} />
    </section>
  );
}

function StageCellView({
  cell,
  data,
  side,
}: {
  cell: StageCell | null;
  data: SideData | null;
  side: string;
}) {
  if (!cell || !data) {
    return (
      <div className="bg-background p-4 text-xs text-muted-foreground">
        No {side.toLowerCase()} engagement selected.
      </div>
    );
  }
  if (!cell.reached) {
    return (
      <div className="bg-background p-4 text-xs text-muted-foreground">
        <span className="font-medium">Not reached</span>
        <p className="mt-2">
          This run is at {STAGE_TITLES[data.engagement.currentStage as StageId]} and has not worked
          this stage.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 bg-background p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{side}</span>
        <StageStateBadge cell={cell} config={data.config} />
        <span className="text-muted-foreground">
          {cell.max > 0 ? `${cell.score}/${cell.max} rubric` : "no score yet"} ·{" "}
          {plural(cell.learnerMessages, "message")} sent ·{" "}
          {plural(cell.personaMessages, "reply", "replies")}
          {cell.gateReactions > 0 ? ` · ${plural(cell.gateReactions, "gate reaction")}` : ""} ·{" "}
          {cell.inProgress ? "in progress" : formatDuration(cell.durationMs)}
          {data.kind === "scripted" && !cell.inProgress ? " replay time" : ""}
          {excludedNote(cell.failedAttempts, 0)}
          {cell.interruptedAttempts > 0 ? " · interrupted, resumed (the interrupted attempt is not counted)" : ""}
          {cell.tokens > 0 ? ` · ${formatCount(cell.tokens)} tokens` : ""}
        </span>
      </div>
      {cell.attempts.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No gate artifact submitted yet.</p>
      ) : null}
    </div>
  );
}

function StageStateBadge({ cell, config }: { cell: StageCell; config: CohortConfig }) {
  const latest = [...cell.attempts].reverse().find((a) => a.scores.length > 0);
  if (cell.inProgress && !latest) {
    return <span className={gateToneClass("progress")}>In progress</span>;
  }
  if (!latest) {
    return <span className={gateToneClass("neutral")}>Advanced without a scored artifact</span>;
  }
  const badge = describeGateOutcome({
    scored: true,
    outcome: latest.outcome,
    fallbackMinScoreRatio: config.gates.minScoreRatio,
    ratio: latest.max > 0 ? latest.total / latest.max : 0,
    compact: true,
  });
  return <span className={gateToneClass(badge.tone)}>{badge.label}</span>;
}

// The threshold in force at this stage: the judge's recorded one where the
// run has it, otherwise the cohort's current setting.
function stageThreshold(data: SideData, stage: StageId): number | null {
  const recorded = [...data.stages[stage].attempts].reverse().find((a) => a.outcome !== null);
  return recorded?.outcome ? recorded.outcome.minScoreRatio : data.config.gates.minScoreRatio;
}

// Gate attempts, paired across the two runs: attempt 1 beside attempt 1, and
// inside an attempt one row per rubric criterion holding both runs' score and
// rationale. Two independent stacks drifted out of line as soon as one judge
// wrote a longer rationale than the other.
function AttemptRows({
  leftCell,
  rightCell,
  left,
  right,
}: {
  leftCell: StageCell | null;
  rightCell: StageCell | null;
  left: SideData | null;
  right: SideData | null;
}) {
  const leftAttempts = leftCell?.attempts ?? [];
  const rightAttempts = rightCell?.attempts ?? [];
  const count = Math.max(leftAttempts.length, rightAttempts.length);
  if (count === 0) return null;
  // Repeat the run identity in each attempt strip: a figure crop of one
  // attempt loses the run cards above, so "Left" alone stops meaning anything.
  const leftLabel = left ? `Left · ${RUN_KIND_LABELS[left.kind]}` : "Left";
  const rightLabel = right ? `Right · ${RUN_KIND_LABELS[right.kind]}` : "Right";

  return (
    <div className="space-y-2 border-t bg-muted/20 p-3">
      {Array.from({ length: count }, (_, i) => (
        <Disclosure
          key={i}
          className="bg-background"
          title={
            <span className="grid w-full gap-x-4 gap-y-0.5 text-xs lg:grid-cols-2">
              <AttemptTitleSide
                side={leftLabel}
                index={i}
                attempt={leftAttempts[i] ?? null}
                config={left?.config ?? null}
              />
              <AttemptTitleSide
                side={rightLabel}
                index={i}
                attempt={rightAttempts[i] ?? null}
                config={right?.config ?? null}
              />
            </span>
          }
        >
          <CriterionRows left={leftAttempts[i] ?? null} right={rightAttempts[i] ?? null} />
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <ArtifactSide side={leftLabel} attempt={leftAttempts[i] ?? null} />
            <ArtifactSide side={rightLabel} attempt={rightAttempts[i] ?? null} />
          </div>
        </Disclosure>
      ))}
    </div>
  );
}

function AttemptTitleSide({
  side,
  index,
  attempt,
  config,
}: {
  side: string;
  index: number;
  attempt: Attempt | null;
  config: CohortConfig | null;
}) {
  if (!attempt) {
    return (
      <span className="text-muted-foreground">
        {side} · attempt {index + 1}: none
      </span>
    );
  }
  const badge = describeGateOutcome({
    scored: attempt.scores.length > 0,
    outcome: attempt.outcome,
    fallbackMinScoreRatio: config?.gates.minScoreRatio ?? null,
    ratio: attempt.max > 0 ? attempt.total / attempt.max : 0,
    compact: true,
  });
  // A passing attempt is already shown by the stage badge above; an attempt
  // badge appears only when something else happened (below the gate, not
  // scored, retries exhausted), which is what the fail-then-revise row needs.
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground">
        {side} · attempt {index + 1}
      </span>
      <span className="font-mono">
        {attempt.max > 0 ? `${attempt.total}/${attempt.max}` : attempt.submission.status}
      </span>
      {badge.tone === "pass" ? null : <span className={gateToneClass(badge.tone)}>{badge.label}</span>}
      <span className="text-muted-foreground">{formatUtc(attempt.submission.createdAt)}</span>
    </span>
  );
}

function CriterionRows({ left, right }: { left: Attempt | null; right: Attempt | null }) {
  const ids = [
    ...new Set([
      ...(left?.scores ?? []).map((r) => r.criterionId),
      ...(right?.scores ?? []).map((r) => r.criterionId),
    ]),
  ];
  if (ids.length === 0) {
    return <p className="text-xs text-muted-foreground">Neither attempt has been scored yet.</p>;
  }
  return (
    <>
      <div className="grid gap-px overflow-hidden rounded-md border bg-border lg:grid-cols-2">
        {ids.flatMap((id) => [
          <CriterionCell
            key={`${id}-left`}
            side="Left"
            criterionId={id}
            score={left?.scores.find((r) => r.criterionId === id) ?? null}
            present={left !== null}
          />,
          <CriterionCell
            key={`${id}-right`}
            side="Right"
            criterionId={id}
            score={right?.scores.find((r) => r.criterionId === id) ?? null}
            present={right !== null}
          />,
        ])}
      </div>
      <div className="mt-1.5 grid gap-x-4 text-[11px] text-muted-foreground lg:grid-cols-2">
        <p>{judgeLine("Left", left)}</p>
        <p>{judgeLine("Right", right)}</p>
      </div>
    </>
  );
}

function judgeLine(side: string, attempt: Attempt | null): string {
  if (!attempt || attempt.scores.length === 0) return `${side}: not scored`;
  const first = attempt.scores[0];
  const overridden = attempt.scores.some((r) => r.overrideScore !== null)
    ? " · includes an instructor override"
    : "";
  return `${side}: judged by ${first.judgeModel} · prompt ${first.promptVersion}${overridden}`;
}

function CriterionCell({
  side,
  criterionId,
  score,
  present,
}: {
  side: string;
  criterionId: string;
  score: RubricScore | null;
  present: boolean;
}) {
  return (
    <div className="min-w-0 bg-background p-2.5 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">
          <span className="text-muted-foreground">{side} · </span>
          {humanizeId(criterionId)}
        </span>
        <span className="shrink-0 font-mono">
          {score === null ? (
            "n/a"
          ) : score.overrideScore !== null ? (
            <>
              <s className="text-muted-foreground">{score.score}</s> {score.overrideScore}/
              {score.maxScore}
            </>
          ) : (
            <>
              {score.score}/{score.maxScore}
            </>
          )}
        </span>
      </div>
      {score ? (
        <Rationale text={score.rationale} improve={score.improve} />
      ) : (
        <p className="mt-1 text-muted-foreground">
          {present ? "Not scored on this criterion." : "No attempt here."}
        </p>
      )}
    </div>
  );
}

function ArtifactSide({ side, attempt }: { side: string; attempt: Attempt | null }) {
  if (!attempt) {
    return (
      <p className="text-xs text-muted-foreground">{side}: no artifact for this attempt.</p>
    );
  }
  return (
    <div className="min-w-0 space-y-2">
      <details>
        <summary className="cursor-pointer text-xs text-primary">
          {side}: submitted artifact
        </summary>
        <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
          {attempt.submission.contentText}
        </p>
      </details>
      {attempt.submission.reflectionText ? (
        <details>
          <summary className="cursor-pointer text-xs text-primary">
            {side}: learner reflection (unscored)
          </summary>
          <p className="mt-2 whitespace-pre-wrap rounded-md border p-3 text-xs">
            {attempt.submission.reflectionText}
          </p>
        </details>
      ) : null}
    </div>
  );
}
