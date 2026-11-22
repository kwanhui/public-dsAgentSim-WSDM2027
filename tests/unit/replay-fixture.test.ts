import { describe, expect, it } from "vitest";
import { applySubstitutions, expectationFor, loadFixture } from "../../scripts/replay/fixture";

const human = loadFixture("scripts/replay/fixtures/human-reference.json");
const exhibit = loadFixture("scripts/replay/fixtures/fail-then-revise.json");

describe("replay fixtures", () => {
  it("hold the reference human run: 19 learner messages and six artifacts, one per stage", () => {
    const messages = human.timeline.filter((s) => s.kind === "message");
    const submits = human.timeline.filter((s) => s.kind === "submit");
    expect(messages).toHaveLength(19);
    expect(submits.map((s) => s.stage)).toEqual([
      "formulation",
      "data-collection",
      "cleaning",
      "modelling",
      "testing",
      "deployment",
    ]);
    expect(human.timeline.map((s) => s.index)).toEqual(human.timeline.map((_, i) => i));
    expect(human.source.engagementId).toMatch(/^55fd9659-/);
  });

  it("hold the exhibit: a data-audit memo that must be held, then the corrected one", () => {
    const audits = exhibit.timeline.filter((s) => s.kind === "submit" && s.stage === "data-collection");
    expect(audits).toHaveLength(2);
    expect(expectationFor(exhibit, audits[0])).toBe("not-advance");
    expect(expectationFor(exhibit, audits[1])).toBe("advance");
    expect(audits[0].text).toMatch(/9,412/);
    expect(audits[0].text).toMatch(/record full marks/);
    expect(audits[1].text).not.toMatch(/full marks/);
  });

  it("every default substitution matches the recorded text", () => {
    // H1 is brought up to date by its patch (below), not by substitutions.
    expect(human.defaultApply ?? []).toEqual([]);
    const { applied } = applySubstitutions(exhibit, exhibit.defaultApply ?? []);
    expect(applied.length).toBeGreaterThan(0);
    for (const a of applied) expect(a.count, `${a.set}: ${a.find}`).toBeGreaterThan(0);
  });

  it("refuses an unknown substitution set", () => {
    expect(() => applySubstitutions(exhibit, ["no-such-set"])).toThrow(/Unknown substitution set/);
  });
});
