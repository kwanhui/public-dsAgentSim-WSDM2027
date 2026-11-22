import { STAGE_IDS, stageIndex, type StageId } from "@/lib/scenarios/types";

// Builders for links into /admin/compare. The cohort overview uses these so
// the headline contrast is one click from the cohort page: the cohort's
// pinned showcase pair when it has one, otherwise the furthest analyst-agent
// run beside the furthest human engagement. The compare page uses them for
// its archived-cohorts toggle.

// The engagement fields needed to rank runs and address them in a link. The
// cohort overview passes its engagement rows; any row shape with these
// fields works.
export interface CompareCandidate {
  id: string;
  mode: string;
  status: string;
  currentStage: string;
  createdAt: Date;
}

// Stage-progress rank, matching the compare page's auto-fill: a completed
// run outranks every stage, otherwise the current stage's index.
function rank(row: CompareCandidate): number {
  return row.status === "completed"
    ? STAGE_IDS.length
    : stageIndex(row.currentStage as StageId);
}

// The furthest-advanced run among those matching `pick`: stage first, then
// most recently started. This is the same tie-break the compare page applies when
// it fills the right column from a ?a=-only link.
export function mostAdvanced(
  rows: CompareCandidate[],
  pick: (row: CompareCandidate) => boolean,
): CompareCandidate | null {
  const candidates = rows.filter(pick);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => {
    if (rank(r) !== rank(best)) return rank(r) > rank(best) ? r : best;
    return r.createdAt > best.createdAt ? r : best;
  });
}

// Compare-view link for one cohort's overview page. The link always scopes
// the pickers to the cohort (?cohort=), and when the cohort holds at least
// one agent run and one human engagement it also preselects the pair worth
// looking at first: the furthest agent run on the left, the furthest human
// on the right. An archived cohort's runs sit behind ?archived=1 on the
// compare page, so the link carries that flag for an archived cohort.
export function cohortCompareHref(
  cohortId: string,
  rows: CompareCandidate[],
  options?: { archived?: boolean; pinned?: PinnedPair | null },
): string {
  const params = new URLSearchParams({ cohort: cohortId });
  if (options?.archived) params.set("archived", "1");
  const pair = pinnedPairIn(rows, options?.pinned ?? null) ?? furthestPair(rows);
  if (pair) {
    params.set("a", pair.agent);
    params.set("b", pair.human);
  }
  return `/admin/compare?${params.toString()}`;
}

// The cohort config's showcase.comparePair, by engagement id.
export interface PinnedPair {
  human: string;
  agent: string;
}

// A pinned pair is used only while both engagements are still in the rows
// (a cohort can lose a run to a purge); otherwise the furthest pair applies.
export function pinnedPairIn(rows: CompareCandidate[], pinned: PinnedPair | null): PinnedPair | null {
  if (!pinned) return null;
  const ids = new Set(rows.map((r) => r.id));
  return ids.has(pinned.human) && ids.has(pinned.agent) ? pinned : null;
}

function furthestPair(rows: CompareCandidate[]): PinnedPair | null {
  const agent = mostAdvanced(rows, (r) => r.mode === "agent");
  const human = mostAdvanced(rows, (r) => r.mode !== "agent");
  return agent && human ? { agent: agent.id, human: human.id } : null;
}

// The compare page's own archived toggle: the same view with the current
// selection kept and the archived flag switched on or off.
export function compareArchivedToggleHref(
  current: { cohort?: string; a?: string; b?: string },
  includeArchived: boolean,
): string {
  const params = new URLSearchParams();
  if (current.cohort) params.set("cohort", current.cohort);
  if (current.a) params.set("a", current.a);
  if (current.b) params.set("b", current.b);
  if (includeArchived) params.set("archived", "1");
  const qs = params.toString();
  return qs ? `/admin/compare?${qs}` : "/admin/compare";
}
