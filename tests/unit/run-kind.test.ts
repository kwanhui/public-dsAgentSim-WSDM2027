import { describe, expect, it } from "vitest";
import { isScriptedReplay, runKind, wallClockComparable, RUN_KIND_LABELS } from "@/lib/admin/run-kind";

describe("run kind", () => {
  const labels = { h: "H1", x: "exhibit", a: "A1", l: "L7" };
  it("labels H1 and the exhibit as scripted replays, from the label or the replay flag", () => {
    expect(runKind({ labels }, { id: "h", mode: "human" })).toBe("scripted");
    expect(runKind({ labels }, { id: "x", mode: "human" })).toBe("scripted");
    expect(runKind({ labels }, { id: "l", mode: "human" })).toBe("learner");
    expect(runKind({ labels, scriptedReplays: ["l"] }, { id: "l", mode: "human" })).toBe("scripted");
    expect(runKind({ labels }, { id: "a", mode: "agent" })).toBe("agent");
    expect(isScriptedReplay({ labels: {} }, { id: "z", mode: "human" })).toBe(false);
    expect(RUN_KIND_LABELS.scripted).toBe("Scripted reference (author replay)");
  });
});

describe("wallClockComparable", () => {
  it("is false (the compare view prints n/a) when either side is a scripted replay", () => {
    expect(wallClockComparable("agent", "scripted")).toBe(false);
    expect(wallClockComparable("scripted", "learner")).toBe(false);
    expect(wallClockComparable("scripted", "scripted")).toBe(false);
  });

  it("is true for agent and learner runs", () => {
    expect(wallClockComparable("agent", "agent")).toBe(true);
    expect(wallClockComparable("agent", "learner")).toBe(true);
  });
});
