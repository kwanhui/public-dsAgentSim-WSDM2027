// A run from before the elicitation trace reads "not recorded", never a
// measured "0 of N" (lib/admin/elicitation-recorded.ts, on top of agent I's
// elicitationTraceRecorded).

import { describe, expect, it } from "vitest";
import {
  elicitationRecorded,
  hiddenFactsLine,
  NOT_RECORDED,
  personaPromptNumber,
  TRACE_STARTED_AT,
} from "@/lib/admin/elicitation-recorded";

const BEFORE = new Date("2026-08-26T04:04:47Z");
const AFTER = new Date(TRACE_STARTED_AT.getTime() + 60_000);
const turn = (promptVersion?: string) => ({ type: "persona_turn", detailJson: promptVersion ? { promptVersion } : {} });

describe("elicitationRecorded", () => {
  it("follows the engagement's own trace flag when it is set", () => {
    expect(elicitationRecorded({ elicitationTrace: true, createdAt: BEFORE, events: [] })).toBe(true);
    expect(elicitationRecorded({ elicitationTrace: false, createdAt: AFTER, events: [] })).toBe(false);
  });

  it("counts a recorded reveal as a trace", () => {
    expect(elicitationRecorded({ createdAt: BEFORE, events: [{ type: "fact_elicited", detailJson: {} }] })).toBe(true);
  });

  it("reads the persona prompt version of the turns", () => {
    expect(elicitationRecorded({ createdAt: BEFORE, events: [turn("persona-v3")] })).toBe(true);
    expect(elicitationRecorded({ createdAt: BEFORE, events: [turn("persona-v2"), turn("persona-v10")] })).toBe(true);
    expect(elicitationRecorded({ createdAt: AFTER, events: [turn("persona-v2")] })).toBe(false);
  });

  it("treats the showcase runs, whose turns carry no prompt version, as not recorded", () => {
    expect(elicitationRecorded({ createdAt: BEFORE, events: [turn(), turn()] })).toBe(false);
  });

  it("decides by start date when no persona turn is left", () => {
    expect(elicitationRecorded({ createdAt: AFTER, events: [] })).toBe(true);
    expect(elicitationRecorded({ createdAt: BEFORE.toISOString(), events: [] })).toBe(false);
  });

  it("parses persona prompt numbers", () => {
    expect(personaPromptNumber("persona-v4")).toBe(4);
    expect(personaPromptNumber("rubric-v4")).toBeNull();
    expect(personaPromptNumber(undefined)).toBeNull();
  });
});

describe("hiddenFactsLine", () => {
  const summary = { obtained: 0, total: 4, verified: 0 };
  it("never prints 0 of N for an unrecorded run", () => {
    expect(hiddenFactsLine(summary, false)).toBe(NOT_RECORDED);
    expect(hiddenFactsLine(summary, false)).not.toMatch(/of 4/);
  });
  it("prints the count for a recorded run", () => {
    expect(hiddenFactsLine(summary, true)).toBe("0 of 4");
    expect(hiddenFactsLine({ obtained: 2, total: 4, verified: 1 }, true)).toBe("2 of 4 (1 verified)");
    expect(hiddenFactsLine(summary, true, { alwaysVerified: true })).toBe("0 of 4 (0 verified)");
    expect(hiddenFactsLine(null, true)).toBe("");
  });
});
