// Replay fixtures: the learner side of a recorded engagement (every learner
// message and every gate submission, in the order they happened), plus the
// few hand-written parts a replay needs on top of the record: a fallback data
// request for a data owner who asks for purpose, fields and granularity, the
// expected outcome of each submission, and named text substitutions that bring
// the recorded artifacts in line with the current scenario.
//
// The timeline is extracted from a cohort snapshot by extract-fixture.ts, so a
// fixture can always be traced back to the engagement it came from.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type TimelineStep =
  | {
      kind: "message";
      /** Position in the recorded engagement, 0-based over learner steps. */
      index: number;
      recordedAt: string;
      stage: string;
      personaId: string;
      text: string;
    }
  | {
      kind: "submit";
      index: number;
      recordedAt: string;
      stage: string;
      artifactKind: string;
      /** 1-based attempt number at this stage in the recording. */
      attempt: number;
      text: string;
    };

export interface Substitution {
  /** Literal text to find (every occurrence is replaced). */
  find: string;
  replace: string;
  /** Why the text changes, for the log and for anyone auditing the fixture. */
  reason: string;
}

export interface ReplayFixture {
  format: "agenticpracticum-replay-fixture";
  formatVersion: 1;
  source: {
    snapshot: string;
    snapshotExportedAt: string;
    cohortSlug: string;
    engagementId: string;
    scenarioId: string;
    learnerMessages: number;
    submissions: number;
  };
  timeline: TimelineStep[];
  /** Hand-written: sent to the data owner when the data has not been released
   * after the recorded request, i.e. when the persona asks for purpose, fields
   * and granularity before releasing. */
  dataRequest?: { personaId: string; text: string; maxAttempts: number };
  /** Hand-written: what each submission is expected to do, by timeline index.
   * "advance" (the default) means the gate passed and the stage moved on;
   * "not-advance" means the gate held the learner at the stage. */
  expect?: Record<string, "advance" | "not-advance">;
  /** Hand-written: named sets of substitutions, applied with --apply. */
  substitutions?: Record<string, Substitution[]>;
  /** Hand-written: substitution sets applied when --apply is not given. */
  defaultApply?: string[];
  notes?: string[];
}

export function loadFixture(path: string): ReplayFixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ReplayFixture;
  if (raw.format !== "agenticpracticum-replay-fixture") {
    throw new Error(`${path} is not a replay fixture (format ${String(raw.format)})`);
  }
  return raw;
}

export interface AppliedSubstitution extends Substitution {
  set: string;
  count: number;
}

/**
 * Applies the named substitution sets to every step's text. Returns the new
 * timeline and what was replaced, so the replay can log it. A substitution
 * that matches nothing is reported with count 0 rather than dropped silently:
 * it usually means the fixture and the substitution list have drifted.
 */
export function applySubstitutions(
  fixture: ReplayFixture,
  sets: string[],
): { timeline: TimelineStep[]; applied: AppliedSubstitution[] } {
  const applied: AppliedSubstitution[] = [];
  let timeline = fixture.timeline.map((s) => ({ ...s }));
  for (const set of sets) {
    const subs = fixture.substitutions?.[set];
    if (!subs) throw new Error(`Unknown substitution set "${set}"; the fixture has ${Object.keys(fixture.substitutions ?? {}).join(", ") || "none"}`);
    for (const sub of subs) {
      let count = 0;
      timeline = timeline.map((step) => {
        const parts = step.text.split(sub.find);
        count += parts.length - 1;
        return parts.length > 1 ? { ...step, text: parts.join(sub.replace) } : step;
      });
      applied.push({ ...sub, set, count });
    }
  }
  return { timeline, applied };
}

export function expectationFor(fixture: ReplayFixture, step: TimelineStep): "advance" | "not-advance" {
  return fixture.expect?.[String(step.index)] ?? "advance";
}

// ---------------------------------------------------------------- patches
//
// A replay patch is a documented, versioned file of exact text replacements
// in a fixture's timeline (scripts/replay/patches/). Unlike a substitution
// set, every entry names the step it changes (an artifact by its stage, or a
// learner message by its timeline index) and must match exactly once there,
// so a patch cannot drift silently. The regeneration records the patch
// file's sha256 with the regenerated run.

/** The patch the H1 replay applies unless --no-patch is given. */
export const DEFAULT_H1_PATCH = "scripts/replay/patches/h1-current-scenario.json";

export interface PatchEntry {
  /** The stage whose artifact (or recorded message) the entry changes. */
  stage: string;
  /** The artifact kind at that stage; omitted for a message entry. */
  artifact?: string;
  /** Timeline index of a learner message; omitted for an artifact entry. */
  message?: number;
  old: string;
  new: string;
  reason: string;
}

export interface ReplayPatch {
  format: "agenticpracticum-replay-patch";
  formatVersion: 1;
  fixture: string;
  fixtureEngagementId: string;
  scenario?: string;
  description: string[];
  entries: PatchEntry[];
}

export interface LoadedPatch {
  file: string;
  sha256: string;
  patch: ReplayPatch;
}

export function loadPatch(path: string): LoadedPatch {
  const raw = readFileSync(path);
  const patch = JSON.parse(raw.toString("utf8")) as ReplayPatch;
  if (patch.format !== "agenticpracticum-replay-patch") {
    throw new Error(`${path} is not a replay patch (format ${String(patch.format)})`);
  }
  return { file: path, sha256: createHash("sha256").update(raw).digest("hex"), patch };
}

export interface AppliedPatchEntry extends PatchEntry {
  index: number;
}

function occurrences(text: string, find: string): number {
  return find ? text.split(find).length - 1 : 0;
}

/**
 * Applies a patch to a timeline. Every entry must find exactly one step (the
 * submission at its stage with its artifact kind, or the message at its
 * index) and its old text exactly once in that step; anything else throws,
 * because it means the patch and the fixture no longer describe the same
 * recording. Returns the new timeline and the entries with the index of the
 * step each one changed.
 */
export function applyPatch(
  fixture: ReplayFixture,
  timeline: TimelineStep[],
  patch: ReplayPatch,
): { timeline: TimelineStep[]; applied: AppliedPatchEntry[] } {
  if (patch.fixtureEngagementId && patch.fixtureEngagementId !== fixture.source.engagementId) {
    throw new Error(
      `patch is for engagement ${patch.fixtureEngagementId}, the fixture records ${fixture.source.engagementId}`,
    );
  }
  const out = timeline.map((s) => ({ ...s }));
  const applied: AppliedPatchEntry[] = [];
  for (const entry of patch.entries) {
    const targets = out.filter((s) =>
      entry.message !== undefined
        ? s.kind === "message" && s.index === entry.message && s.stage === entry.stage
        : s.kind === "submit" && s.stage === entry.stage && (!entry.artifact || s.artifactKind === entry.artifact),
    );
    const where = entry.message !== undefined ? `message ${entry.message}` : `${entry.artifact ?? "artifact"} at ${entry.stage}`;
    if (targets.length !== 1) throw new Error(`patch entry for ${where}: ${targets.length} matching steps, expected 1`);
    const step = targets[0];
    const n = occurrences(step.text, entry.old);
    if (n !== 1) throw new Error(`patch entry for ${where}: old text found ${n} times, expected once: ${JSON.stringify(entry.old)}`);
    step.text = step.text.replace(entry.old, () => entry.new);
    applied.push({ ...entry, index: step.index });
  }
  return { timeline: out, applied };
}
