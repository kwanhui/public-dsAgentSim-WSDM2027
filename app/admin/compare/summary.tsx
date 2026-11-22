// The compare view's summary: what the two runs held constant, and the tiles
// that state the gap between them.

import { STAGE_IDS } from "@/lib/scenarios/types";
import type { CohortConfig } from "@/lib/cohort/defaults";
import { formatCount, formatDuration, plural, signed } from "@/lib/admin/format";
import { formatUsd } from "@/lib/llm/budget-format";
import { NOT_RECORDED, analystModelLabel, splitConditions, type ConditionPart } from "@/lib/admin/run-provenance";
import { wallClockComparable } from "@/lib/admin/run-kind";
import { hiddenFactsLine } from "@/lib/admin/elicitation-recorded";
import type { SideData, StageCell } from "./side-data";

export function HeldConstant({ left, right }: { left: SideData; right: SideData }) {
  const parts: ConditionPart[] = [
    { label: "Scenario", left: left.scenario.title, right: right.scenario.title },
    { label: "Persona model", left: left.personaModel, right: right.personaModel },
    // Shown when either side is an agent run: two agent runs on different
    // analyst models must not read as held constant.
    ...(left.isAgent || right.isAgent
      ? [
          {
            label: "Analyst model",
            left: left.isAgent ? left.analystModel : analystModelLabel(left),
            right: right.isAgent ? right.analystModel : analystModelLabel(right),
          },
        ]
      : []),
    { label: "Persona prompt", left: left.personaPrompt, right: right.personaPrompt },
    { label: "Judge model", left: left.judgeModel, right: right.judgeModel },
    { label: "Judge prompt", left: left.judgePrompt, right: right.judgePrompt },
    { label: "Auditor prompt", left: left.auditorPrompt, right: right.auditorPrompt },
    { label: "Gate policy", left: gatePolicy(left.config), right: gatePolicy(right.config) },
    { label: "Cohort", left: left.cohortName, right: right.cohortName },
  ];
  const { same, differ, unrecorded } = splitConditions(parts);

  return (
    <div className="mt-6 space-y-1.5 rounded-lg border bg-muted/30 p-4 text-xs">
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Held constant:</span>{" "}
        {same.length === 0
          ? "nothing. The two runs share no recorded setting."
          : same.map((p) => `${p.label.toLowerCase()} ${p.value}`).join(" · ")}
      </p>
      {differ.length > 0 ? (
        <p className="text-foreground">
          <span className="font-medium">Differs:</span>{" "}
          {differ
            .map((p) => `${p.label.toLowerCase()} (left ${p.left}, right ${p.right})`)
            .join(" · ")}
        </p>
      ) : null}
      {unrecorded.length > 0 ? (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Not recorded:</span>{" "}
          {unrecorded
            .map(
              (p) =>
                `${p.label.toLowerCase()} (left ${p.left ?? NOT_RECORDED}, right ${p.right ?? NOT_RECORDED})`,
            )
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function gatePolicy(config: CohortConfig): string {
  const { minScoreRatio, maxRetries } = config.gates;
  return minScoreRatio === null
    ? `formative (no pass mark), ${plural(maxRetries + 1, "attempt")}`
    : `pass mark ${Math.round(minScoreRatio * 100)}% of rubric, ${plural(maxRetries + 1, "attempt")}`;
}

interface Tile {
  label: string;
  leftValue: string;
  rightValue: string;
  delta: string;
  hint: string;
}

// Which side a left-minus-right difference favours, in words.
function side(delta: number | null, larger: { left: string; right: string; same: string }) {
  if (delta === null) return "";
  if (delta === 0) return larger.same;
  return delta > 0 ? larger.left : larger.right;
}

export function DeltaStrip({ left, right }: { left: SideData; right: SideData }) {
  // Runs that have reached different stages have different totals available,
  // so the score, message and time tiles report the stages both runs scored.
  // A whole-run figure beside a shared-stage delta misled in both directions.
  const shared = STAGE_IDS.filter((s) => left.stages[s].max > 0 && right.stages[s].max > 0);
  const none = shared.length === 0;
  const noneHint = "no stage is scored on both sides; see the run cards below";
  const sharedSum = (data: SideData, pick: (cell: StageCell) => number) =>
    shared.reduce((sum, s) => sum + pick(data.stages[s]), 0);
  const sharedScore = (data: SideData) => sharedSum(data, (c) => c.score);
  const sharedMax = (data: SideData) => sharedSum(data, (c) => c.max);
  const sharedMessages = (data: SideData) => sharedSum(data, (c) => c.learnerMessages);
  // A shared stage can still be open on one side, and an open stage has no
  // closed span to add up.
  const sharedDuration = (data: SideData): number | null =>
    !none && shared.every((s) => data.stages[s].durationMs !== null)
      ? sharedSum(data, (c) => c.durationMs ?? 0)
      : null;

  const scoreDelta = none ? null : sharedScore(left) - sharedScore(right);
  const messageDelta = none ? null : sharedMessages(left) - sharedMessages(right);
  const stageDelta = reachedCount(left) - reachedCount(right);
  const leftDuration = sharedDuration(left);
  const rightDuration = sharedDuration(right);
  // A replay has no think time, so a difference against it is not comparable.
  const timeComparable = wallClockComparable(left.kind, right.kind);
  const timeDelta =
    timeComparable && leftDuration !== null && rightDuration !== null
      ? leftDuration - rightDuration
      : null;
  const tokenDelta = left.totals.meteredTokens - right.totals.meteredTokens;
  const na = "n/a";
  const factDelta = left.elicitation.obtained - right.elicitation.obtained;
  const failedHint = (data: SideData, name: string) => {
    const parts = [
      data.totals.failedAttempts > 0 ? plural(data.totals.failedAttempts, "failed attempt") : null,
      data.totals.interruptedAttempts > 0 ? plural(data.totals.interruptedAttempts, "interrupted attempt") : null,
    ].filter(Boolean);
    return parts.length > 0 ? `${name}: ${parts.join(" and ")} excluded` : null;
  };
  const failedNote = [failedHint(left, "left"), failedHint(right, "right")].filter(Boolean).join("; ");
  // What each side's time measures: an agent run's completed stage
  // attempts, a scripted replay's replay time, a learner's elapsed time.
  const basis = (data: SideData, name: string) =>
    data.kind === "agent"
      ? `${name}: active time of completed stage attempts`
      : data.kind === "scripted"
        ? `${name}: replay time, no think time`
        : `${name}: elapsed time`;
  const basisNote = `${basis(left, "left")}; ${basis(right, "right")}`;

  const tiles: Tile[] = [
    {
      label: "Rubric score, shared stages",
      leftValue: none ? na : withPercent(sharedScore(left), sharedMax(left)),
      rightValue: none ? na : withPercent(sharedScore(right), sharedMax(right)),
      delta: scoreDelta === null ? na : signed(scoreDelta),
      hint: none
        ? noneHint
        : `${plural(shared.length, "stage")}; ${side(scoreDelta, {
            left: "left higher",
            right: "right higher",
            same: "equal",
          })}`,
    },
    {
      label: "Messages sent, shared stages",
      leftValue: none ? na : formatCount(sharedMessages(left)),
      rightValue: none ? na : formatCount(sharedMessages(right)),
      delta: messageDelta === null ? na : signed(messageDelta),
      hint: none
        ? noneHint
        : side(messageDelta, { left: "left sent more", right: "right sent more", same: "equal" }),
    },
    {
      label: "Stages reached",
      leftValue: `${reachedCount(left)}/${STAGE_IDS.length}`,
      rightValue: `${reachedCount(right)}/${STAGE_IDS.length}`,
      delta: signed(stageDelta),
      hint: side(stageDelta, { left: "left further", right: "right further", same: "equal" }),
    },
    {
      label: "Wall clock, shared stages",
      leftValue: formatDuration(leftDuration),
      rightValue: formatDuration(rightDuration),
      delta:
        timeDelta === null
          ? na
          : `${timeDelta >= 0 ? "+" : "−"}${formatDuration(Math.abs(timeDelta))}`,
      hint: [
        none
          ? noneHint
          : !timeComparable
            ? ""
            : timeDelta === null
              ? "a shared stage is still open on one side"
              : side(timeDelta, { left: "left took longer", right: "right took longer", same: "equal" }),
        basisNote,
        failedNote,
      ]
        .filter(Boolean)
        .join("; "),
    },
    {
      // The elicitation trace: hidden facts the run
      // obtained from the stakeholders, and the learner message at which
      // each one came.
      label: "Hidden facts obtained",
      leftValue: hiddenFactsLine(left.elicitation, left.elicitationRecorded, { alwaysVerified: true }),
      rightValue: hiddenFactsLine(right.elicitation, right.elicitationRecorded, { alwaysVerified: true }),
      delta: left.elicitationRecorded && right.elicitationRecorded ? signed(factDelta) : "n/a",
      hint:
        left.elicitationRecorded && right.elicitationRecorded
          ? `left: ${obtainedAt(left)}; right: ${obtainedAt(right)}`
          : left.elicitationRecorded || right.elicitationRecorded
            ? `one run predates the elicitation trace; left: ${obtainedAt(left)}; right: ${obtainedAt(right)}`
            : "both runs predate the elicitation trace",
    },
    {
      label: "Tokens (all metered calls)",
      leftValue: formatCount(left.totals.meteredTokens),
      rightValue: formatCount(right.totals.meteredTokens),
      delta: signed(tokenDelta),
      hint:
        stageDelta === 0
          ? `whole run; ${side(tokenDelta, { left: "left used more", right: "right used more", same: "equal" })}`
          : "whole run; the runs reached different stages",
    },
    ...(left.usd !== null && right.usd !== null
      ? [
          {
            label: "USD (all metered calls)",
            leftValue: formatUsd(left.usd),
            rightValue: formatUsd(right.usd),
            delta: `${left.usd - right.usd >= 0 ? "+" : "−"}${formatUsd(Math.abs(left.usd - right.usd)).replace("USD ", "")}`,
            hint: "whole run, at list prices for the model that served it (the offline mock is USD 0.00)",
          },
        ]
      : []),
  ];

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full rounded-lg border text-left text-sm">
        <caption className="px-3 pb-2 text-left text-xs text-muted-foreground">
          {none
            ? "No stage is scored on both sides."
            : `${plural(shared.length, "stage")} scored on both sides.`}{" "}
          Differences are left minus right; score, messages and wall clock cover only those stages.
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="px-3 py-1.5 font-medium">Measure</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Left</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Right</th>
            <th scope="col" className="hidden px-3 py-1.5 font-medium sm:table-cell">Difference</th>
            <th scope="col" className="hidden px-3 py-1.5 font-medium sm:table-cell">Note</th>
          </tr>
        </thead>
        <tbody>
          {tiles.map((t) => (
            <tr key={t.label} className="border-b align-top last:border-0">
              <th scope="row" className="px-3 py-1.5 font-medium">
                {t.label}
                {/* Below 640 px the difference and note sit under the
                    measure, so the table fits a phone without scrolling. */}
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground sm:hidden">
                  Difference <span className="font-mono">{t.delta}</span>
                  {t.hint ? `; ${t.hint}` : ""}
                </span>
              </th>
              <td className="break-words px-3 py-1.5 font-mono text-xs">{t.leftValue}</td>
              <td className="break-words px-3 py-1.5 font-mono text-xs">{t.rightValue}</td>
              <td className="hidden px-3 py-1.5 font-mono text-xs sm:table-cell">{t.delta}</td>
              <td className="hidden px-3 py-1.5 text-xs text-muted-foreground sm:table-cell">{t.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "messages 3, 7" (or "message 3") for the learner messages at which each
// obtained fact came, or "not obtained".
// A fact the auditor flagged as disclosed early reads "4 (early)", as the
// dagger does in the paper's Table 2.
export function obtainedAt(data: Pick<SideData, "elicitation"> & { elicitationRecorded?: boolean }): string {
  if (data.elicitationRecorded === false) return NOT_RECORDED;
  const at = data.elicitation.facts
    .filter((f) => f.obtainedAtLearnerMessage !== null)
    .map((f) => ({ n: f.obtainedAtLearnerMessage as number, early: Boolean(f.early) }))
    .sort((a, b) => a.n - b.n);
  if (at.length === 0) return "not obtained";
  return `${at.length === 1 ? "message" : "messages"} ${at.map((a) => (a.early ? `${a.n} (early)` : String(a.n))).join(", ")}`;
}

export function withPercent(score: number, max: number): string {
  return max > 0 ? `${score}/${max} (${Math.round((score / max) * 100)}%)` : `${score}/${max}`;
}

export function reachedCount(data: SideData): number {
  return STAGE_IDS.filter((s) => data.stages[s].reached).length;
}
