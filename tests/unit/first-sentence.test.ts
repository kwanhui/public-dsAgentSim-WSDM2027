import { describe, expect, it } from "vitest";
import { splitFirstSentence } from "@/lib/text/first-sentence";

describe("splitFirstSentence", () => {
  it("splits at the first sentence boundary", () => {
    expect(splitFirstSentence("States the objective clearly. It also names the owner.")).toEqual({
      first: "States the objective clearly.",
      rest: "It also names the owner.",
    });
  });

  it("returns the whole text when there is one sentence", () => {
    expect(splitFirstSentence("  Complete and grounded.  ")).toEqual({
      first: "Complete and grounded.",
      rest: "",
    });
  });

  it("does not split inside decimals, file names or common abbreviations", () => {
    const text =
      "Cites 8,170 rows in churn_extract.csv and a 4.5 lift, e.g. Priya's list. The horizon is vague.";
    expect(splitFirstSentence(text).first).toBe(
      "Cites 8,170 rows in churn_extract.csv and a 4.5 lift, e.g. Priya's list.",
    );
  });

  it("splits after a closing quote", () => {
    expect(splitFirstSentence('Quotes "the save rule." Then stops.').rest).toBe("Then stops.");
  });
});
