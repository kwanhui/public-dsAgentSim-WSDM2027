import { describe, expect, it } from "vitest";
import { humanizeId, reflowProse } from "@/lib/utils";
import { countWords, parseWordTarget, wordCountLine } from "@/lib/engagement/artifact-text";

describe("reflowProse", () => {
  it("joins hard-wrapped lines within a paragraph", () => {
    const src = "Meridian Mobile is a mid-sized telco with 480,000 postpaid\nsubscribers. Churn has crept up.";
    expect(reflowProse(src)).toBe(
      "Meridian Mobile is a mid-sized telco with 480,000 postpaid subscribers. Churn has crept up.",
    );
  });

  it("keeps paragraph breaks", () => {
    const src = "First paragraph\nstill first.\n\nSecond paragraph.";
    expect(reflowProse(src)).toBe("First paragraph still first.\n\nSecond paragraph.");
  });

  it("keeps list items on their own lines", () => {
    const src = "Deliverables:\n- a memo\n- a model\n2. numbered item";
    expect(reflowProse(src)).toBe("Deliverables:\n- a memo\n- a model\n2. numbered item");
  });

  it("trims surrounding whitespace", () => {
    expect(reflowProse("\n  hello\n  world\n")).toBe("hello world");
  });
});

describe("humanizeId", () => {
  it("turns slugs into sentence-case labels", () => {
    expect(humanizeId("target-definition")).toBe("Target definition");
    expect(humanizeId("data-audit")).toBe("Data audit");
    expect(humanizeId("objective")).toBe("Objective");
  });

  it("handles underscores and repeated separators", () => {
    expect(humanizeId("success__measure")).toBe("Success measure");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("a short problem statement")).toBe(4);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(countWords("  two\n\n words \t")).toBe(2);
    expect(countWords("   ")).toBe(0);
  });
});

describe("parseWordTarget", () => {
  it("reads the range the gate instructions ask for", () => {
    expect(parseWordTarget("Submit a data-collection memo (200-400 words): what data you")).toEqual({
      min: 200,
      max: 400,
    });
  });

  it("accepts dashes and the word 'to'", () => {
    expect(parseWordTarget("600–1000 words")).toEqual({ min: 600, max: 1000 });
    expect(parseWordTarget("300 to 500 words")).toEqual({ min: 300, max: 500 });
  });

  it("returns null when no range is stated", () => {
    expect(parseWordTarget("Submit a cleaning report covering each issue.")).toBeNull();
  });
});

describe("wordCountLine", () => {
  const target = { min: 300, max: 600 };

  it("counts words against the stage's target range", () => {
    const text = Array.from({ length: 113 }, () => "word").join(" ");
    expect(wordCountLine(text, target)).toBe("113 words · target 300 to 600");
  });

  it("says when the text is below the submission floor", () => {
    expect(wordCountLine("", target)).toBe("0 words · target 300 to 600 · too short to submit");
    expect(wordCountLine("one", null)).toBe("1 word · too short to submit");
  });
});
