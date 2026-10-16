// Mechanical signals per probe run (scripts/replay/probes.ts): the few
// checks each probe names, computed from the probe-phase steps, their events
// and the learner's copy of the scores. Pure.
import { findKey } from "@/lib/engagement/elicitation";
import { findStyleViolations } from "@/lib/agents/persona-style";
import { keysNamed, unraisedFactKeys } from "@/lib/agents/rationale-filter";
import type { Scenario } from "@/lib/scenarios/types";

import type { Probe, ProbeStep } from "./round5";

type Json = Record<string, unknown>;

export interface StepRecord {
  phase: "prelude" | "probe";
  kind: ProbeStep["kind"];
  target: string;
  note?: string;
  sent: string;
  startedAt: string;
  endedAt: string;
  status: number;
  reply?: string;
  releasedFiles?: string[];
  submit?: {
    attempt: number;
    passed?: boolean;
    advanced?: boolean;
    completed?: boolean;
    scoreRatio?: number | null;
    reason?: string;
    stage: string;
  };
  /** The client sponsor's reaction to a submission (the newest client message after it). */
  reaction?: string;
  events?: { type: string; detail: Json; at: string }[];
}

export interface ProbeRun {
  probe: string;
  number: number;
  title: string;
  scenario: string;
  seed: number;
  engagementId: string;
  expected: string;
  check: string;
  ok: boolean;
  error?: string;
  steps: StepRecord[];
  transcripts: Record<string, { sender: string; content: string; at: string }[]>;
  submissions: Json[];
  scores: Json[];
  elicitation: Json | null;
  signals: Json;
}

/** Mechanical signals per probe, from the probe-phase steps and their events. */
export function probeSignals(probe: Probe, scenario: Scenario, run: Pick<ProbeRun, "steps" | "submissions">): Json {
  const probeSteps = run.steps.filter((s) => s.phase === "probe");
  const evs = probeSteps.flatMap((s) => s.events ?? []);
  const count = (type: string) => evs.filter((e) => e.type === type).length;
  const facts = evs
    .filter((e) => e.type === "fact_elicited")
    .map((e) => ({
      factId: e.detail.factId,
      verified: e.detail.verified ?? null,
      detection: e.detail.detection ?? "reported",
      matchedKey: e.detail.matchedKey ?? null,
      early: e.detail.early ?? false,
    }));
  const replies = probeSteps.filter((s) => s.kind === "message").map((s) => s.reply ?? "");
  const withheld = scenario.personas.flatMap((p) => p.withheld ?? []);
  const keyOf = (id: string) => withheld.find((w) => w.id === id)?.keys ?? [];
  const columns = scenario.datasets.flatMap((d) =>
    [...d.dictionary.matchAll(/^\s*([a-z_0-9]+):/gm)].map((m) => m[1]),
  );
  const signals: Json = {
    releasesByStep: probeSteps.map((s) => (s.events ?? []).filter((e) => e.type === "data_released").map((e) => e.detail)),
    releaseWithheld: count("release_withheld"),
    factsElicited: facts,
    earlyDisclosureFlagged: evs.filter((e) => e.type === "early_disclosure_flagged").map((e) => e.detail.factIds),
    factElicitedEarly: evs.filter((e) => e.type === "fact_elicited_early").map((e) => e.detail.factIds),
    audits: evs
      .filter((e) => e.type === "persona_consistency")
      .map((e) => ({ personaId: e.detail.personaId, consistent: e.detail.consistent, disclosedEarly: e.detail.disclosedEarly ?? [] })),
    frictionRaised: evs.filter((e) => e.type === "friction_raised").map((e) => e.detail.frictionId ?? e.detail),
    frictionUnconfirmed: evs.filter((e) => e.type === "friction_unconfirmed").map((e) => e.detail),
    personaStyleRetries: count("persona_style_retry"),
    reactionLeakFiltered: count("reaction_leak_filtered"),
    withheldLeakBlocked: evs.filter((e) => e.type === "withheld_leak_blocked").map((e) => ({ factId: e.detail.factId, channel: e.detail.channel })),
  };
  switch (probe.number) {
    case 1:
      signals.columnsNamedInReplies = replies.map((r) => columns.filter((c) => r.toLowerCase().includes(c)));
      break;
    case 5:
      signals.duplicateKeyInReply = replies.map((r) => findKey(r, keyOf("duplicate-rows")));
      break;
    case 8:
    case 9:
      signals.offerCostKeyInReply = replies.map((r) => findKey(r, keyOf("offer-cost")));
      signals.saveRuleKeyInReply = replies.map((r) => findKey(r, keyOf("save-definition")));
      signals.sgdAmountsInReply = replies.map((r) => [...r.matchAll(/(?:S\$|SGD\s?)\s?[\d,.]+/gi)].map((m) => m[0]));
      break;
    case 11:
      signals.styleViolationsLeft = replies.map((r) => findStyleViolations(r));
      break;
    case 12:
    case 15: {
      const sub = probeSteps.find((s) => s.kind === "submit");
      const memo = sub?.sent ?? "";
      const unraised = unraisedFactKeys(scenario, memo);
      const learnerSub = run.submissions[run.submissions.length - 1] as { scores?: { rationale?: string; improve?: string | null }[] } | undefined;
      const rationales = (learnerSub?.scores ?? []).map((s) => s.rationale ?? "");
      const improves = (learnerSub?.scores ?? []).map((s) => s.improve ?? "").filter(Boolean);
      signals.gate = sub?.submit ?? null;
      signals.reaction = sub?.reaction ?? "";
      signals.factKeysInReaction = keysNamed(sub?.reaction ?? "", unraised);
      signals.factKeysInRationales = rationales.flatMap((r) => keysNamed(r, unraised));
      signals.factKeysInImproveLines = improves.flatMap((r) => keysNamed(r, unraised));
      break;
    }
    case 17: {
      const learnerSub = run.submissions[run.submissions.length - 1] as { scores?: { criterionId: string; score: number; maxScore: number }[] } | undefined;
      signals.constraints = learnerSub?.scores?.find((s) => s.criterionId === "constraints") ?? null;
      signals.allScores = learnerSub?.scores?.map((s) => `${s.criterionId} ${s.score}/${s.maxScore}`) ?? [];
      break;
    }
    default:
      break;
  }
  return signals;
}
