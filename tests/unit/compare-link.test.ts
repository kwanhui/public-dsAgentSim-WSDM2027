import { describe, expect, it } from "vitest";
import {
  cohortCompareHref,
  compareArchivedToggleHref,
  mostAdvanced,
  pinnedPairIn,
  type CompareCandidate,
} from "@/lib/admin/compare-link";

// The cohort overview's "Compare engagements" link must land an instructor on
// a comparison, not on an empty form: scoped to the cohort always, and with
// the furthest agent run beside the furthest human preselected once both
// exist.

function row(overrides: Partial<CompareCandidate> & { id: string }): CompareCandidate {
  return {
    mode: "human",
    status: "active",
    currentStage: "formulation",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("mostAdvanced", () => {
  it("returns null when nothing matches the filter", () => {
    expect(mostAdvanced([row({ id: "h1" })], (r) => r.mode === "agent")).toBeNull();
  });

  it("prefers the later pipeline stage", () => {
    const early = row({ id: "early", currentStage: "formulation" });
    const late = row({ id: "late", currentStage: "modelling" });
    expect(mostAdvanced([early, late], () => true)?.id).toBe("late");
    expect(mostAdvanced([late, early], () => true)?.id).toBe("late");
  });

  it("ranks a completed run above any in-progress stage", () => {
    const deep = row({ id: "deep", currentStage: "deployment" });
    const done = row({ id: "done", status: "completed", currentStage: "cleaning" });
    expect(mostAdvanced([deep, done], () => true)?.id).toBe("done");
  });

  it("breaks a stage tie by the most recent start", () => {
    const older = row({
      id: "older",
      currentStage: "testing",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const newer = row({
      id: "newer",
      currentStage: "testing",
      createdAt: new Date("2026-08-02T00:00:00Z"),
    });
    expect(mostAdvanced([older, newer], () => true)?.id).toBe("newer");
  });
});

describe("cohortCompareHref", () => {
  const agent = row({ id: "agent-1", mode: "agent", currentStage: "modelling" });
  const agentFurther = row({
    id: "agent-2",
    mode: "agent",
    status: "completed",
    currentStage: "deployment",
  });
  const human = row({ id: "human-1", currentStage: "cleaning" });
  const humanFurther = row({ id: "human-2", currentStage: "testing" });

  it("scopes to the cohort when there are no engagements", () => {
    expect(cohortCompareHref("c-1", [])).toBe("/admin/compare?cohort=c-1");
  });

  it("scopes to the cohort when only one side exists", () => {
    expect(cohortCompareHref("c-1", [human, humanFurther])).toBe("/admin/compare?cohort=c-1");
    expect(cohortCompareHref("c-1", [agent])).toBe("/admin/compare?cohort=c-1");
  });

  it("preselects the furthest agent run and the furthest human", () => {
    expect(cohortCompareHref("c-1", [human, agent, humanFurther, agentFurther])).toBe(
      "/admin/compare?cohort=c-1&a=agent-2&b=human-2",
    );
  });

  it("carries the archived flag for an archived cohort", () => {
    expect(cohortCompareHref("c-1", [agent, human], { archived: true })).toBe(
      "/admin/compare?cohort=c-1&archived=1&a=agent-1&b=human-1",
    );
    expect(cohortCompareHref("c-1", [], { archived: true })).toBe(
      "/admin/compare?cohort=c-1&archived=1",
    );
  });

  it("escapes ids in the query string", () => {
    expect(cohortCompareHref("c 1", [])).toBe("/admin/compare?cohort=c+1");
  });
});

describe("compareArchivedToggleHref", () => {
  it("adds the archived flag and keeps the current selection", () => {
    expect(compareArchivedToggleHref({ cohort: "c-1", a: "a-1", b: "b-1" }, true)).toBe(
      "/admin/compare?cohort=c-1&a=a-1&b=b-1&archived=1",
    );
  });

  it("drops the flag on the way back", () => {
    expect(compareArchivedToggleHref({ cohort: "c-1" }, false)).toBe(
      "/admin/compare?cohort=c-1",
    );
  });

  it("handles an empty selection in both directions", () => {
    expect(compareArchivedToggleHref({}, true)).toBe("/admin/compare?archived=1");
    expect(compareArchivedToggleHref({}, false)).toBe("/admin/compare");
  });
});

describe("pinned showcase pair", () => {
  const rows = [
    row({ id: "human-ref", status: "completed" }),
    row({ id: "agent-a1", mode: "agent", status: "completed" }),
    row({ id: "agent-newer", mode: "agent", status: "completed", createdAt: new Date("2026-09-02T00:00:00Z") }),
  ];

  it("links the pinned pair instead of the newest agent run", () => {
    const href = cohortCompareHref("c1", rows, { pinned: { human: "human-ref", agent: "agent-a1" } });
    const params = new URL(href, "http://x").searchParams;
    expect(params.get("a")).toBe("agent-a1");
    expect(params.get("b")).toBe("human-ref");
  });

  it("falls back to the furthest pair when a pinned run is gone", () => {
    expect(pinnedPairIn(rows, { human: "human-ref", agent: "purged" })).toBeNull();
    const href = cohortCompareHref("c1", rows, { pinned: { human: "human-ref", agent: "purged" } });
    expect(new URL(href, "http://x").searchParams.get("a")).toBe("agent-newer");
  });
});
