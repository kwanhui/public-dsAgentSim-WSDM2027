import { NOT_RECORDED } from "@/lib/admin/run-provenance";

export { NOT_RECORDED };

// Whether an engagement has an elicitation trace at all. The trace started
// with persona-v3; a run from before then has no fact_elicitations rows and
// no fact_elicited events, and its hidden-facts count would read "0 of N",
// which is a measurement that was never taken. The admin views and the
// export print "not recorded" for those runs instead.
//
// The rule is agent I's elicitationTraceRecorded (lib/engagement/
// elicitation.ts): the engagement's elicitation_trace flag (migration 0014),
// any recorded reveal, or any persona event logged under persona-v3 or later.
// One case it leaves open is handled here: a run with no persona event left
// (none yet, or purged after the retention window) and no flag, which is
// recorded when it started after the trace shipped and not recorded before.

import { elicitationTraceRecorded, FIRST_TRACED_PERSONA_VERSION } from "@/lib/engagement/elicitation";

export const TRACE_FIRST_PERSONA_PROMPT = `persona-v${FIRST_TRACED_PERSONA_VERSION}`;

// When persona-v3 and the elicitation trace shipped (commit d85779d).
export const TRACE_STARTED_AT = new Date("2026-09-29T18:25:29Z");

const PERSONA_EVENT_TYPES = new Set(["persona_turn", "client_reaction", "identity_question", "persona_style_retry"]);

interface EventLike {
  type: string;
  detailJson: unknown;
}

/** The number in "persona-v3", or null for anything else. */
export function personaPromptNumber(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const m = /^persona-v(\d+)$/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

export function elicitationRecorded(input: {
  elicitationTrace?: boolean | null;
  createdAt: Date | string;
  events: readonly EventLike[];
}): boolean {
  if (elicitationTraceRecorded({ elicitationTrace: input.elicitationTrace, events: input.events })) return true;
  if (input.elicitationTrace === false) return false;
  if (input.events.some((e) => PERSONA_EVENT_TYPES.has(e.type))) return false;
  const created = typeof input.createdAt === "string" ? new Date(input.createdAt) : input.createdAt;
  return !Number.isNaN(created.getTime()) && created >= TRACE_STARTED_AT;
}

/** "2 of 4 (1 verified)", "0 of 4", or "not recorded". */
export function hiddenFactsLine(
  summary: { obtained: number; total: number; verified: number } | null,
  recorded: boolean,
  opts: { alwaysVerified?: boolean } = {},
): string {
  if (!summary) return "";
  if (!recorded) return NOT_RECORDED;
  const verified = opts.alwaysVerified || summary.obtained > 0 ? ` (${summary.verified} verified)` : "";
  return `${summary.obtained} of ${summary.total}${verified}`;
}
