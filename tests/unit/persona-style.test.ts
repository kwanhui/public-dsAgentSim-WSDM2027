// The persona-v3 style check: each banned pattern, the length cut, and the repair
// hook that keeps an over-long structured reply from failing the turn.

import { describe, expect, it } from "vitest";
import {
  describeStyleViolations,
  findStyleViolations,
  replyLengthRepair,
  truncateReply,
} from "@/lib/agents/persona-style";

describe("findStyleViolations", () => {
  it.each([
    ["Good catch on the duplicate rows. They come from plan changes.", "verdict-opener"],
    ["Fair place to start. The budget is fixed.", "verdict-opener"],
    ["This covers what I need for now.", "verdict-opener"],
    ["Now this actually tells me something.", "verdict-opener"],
    ["It has to be usable by frontline staff, not just accurate on paper.", "not-just"],
    ["That is not only a data issue.", "not-only"],
    ["That is exactly the kind of thing that burned us.", "exactly"],
    ["I genuinely need a shorter list.", "genuinely"],
    ["The list is long — too long.", "em-dash"],
    ["Send me a short note once you've confirmed the counts.", "note-once-closer"],
    ["Send me a one-line note once you have checked leakage.", "note-once-closer"],
    ["Go ahead and take both questions to him now.", "go-ahead"],
    ["Let me check with Finance and get back to you.", "follow-up-promise"],
    ["On the model type, that's your call, that's what we hired you for.", "comma-splice"],
    ["I don't have that figure, it's more Marcus's area.", "comma-splice"],
  ])("flags %j as %s", (reply, id) => {
    expect(findStyleViolations(reply)).toContain(id);
  });

  it.each([
    "The budget is fixed for this quarter. I need to know which part to drop first.",
    "If the list is longer than the team can call, that's a problem for me.",
    "When the scores are stale, it's the regulars who get annoyed.",
    "Priya's team makes the calls. Ask her once her channel opens.",
  ])("passes %j", (reply) => {
    expect(findStyleViolations(reply)).toEqual([]);
  });

  it("flags a reply over the character limit as too long", () => {
    expect(findStyleViolations("Short sentence here. ".repeat(30))).toContain("too-long");
  });

  it("names the broken rules for the corrective prompt", () => {
    expect(describeStyleViolations(["exactly", "go-ahead"])).toBe(
      'it uses "exactly"; it tells the consultant "go ahead and"',
    );
  });
});

describe("truncateReply", () => {
  it("cuts at the last sentence end within the limit", () => {
    const reply = `${"First sentence is here. ".repeat(10)}And a last one.`;
    const cut = truncateReply(reply, 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith(".")).toBe(true);
    expect(reply.startsWith(cut)).toBe(true);
  });

  it("falls back to a word boundary when no sentence ends in time", () => {
    const cut = truncateReply("word ".repeat(200), 50);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut.endsWith("word.")).toBe(true);
  });

  it("leaves a short reply alone", () => {
    expect(truncateReply("Fine.", 450)).toBe("Fine.");
  });
});

describe("replyLengthRepair", () => {
  it("cuts only an over-long reply and records that it did", async () => {
    const { repair, wasTruncated } = replyLengthRepair(40);
    const lists = { newFacts: [], revealedWithheld: [], raisedFrictions: [], releaseDatasets: [] };
    expect(await repair({ text: JSON.stringify({ reply: "Short.", ...lists }) })).toBeNull();
    expect(wasTruncated()).toBe(false);
    const fixed = await repair({
      text: JSON.stringify({ reply: "One sentence here. Another sentence that runs past the limit.", ...lists, newFacts: ["x"] }),
    });
    expect(JSON.parse(fixed!)).toEqual({ reply: "One sentence here.", ...lists, newFacts: ["x"] });
    expect(wasTruncated()).toBe(true);
  });

  it("gives up on text that is not JSON", async () => {
    const { repair } = replyLengthRepair(40);
    expect(await repair({ text: "not json" })).toBeNull();
  });
});

describe("round-3 style patterns", () => {
  it('flags the ", not X" contrast, "honestly" and "worth flagging"', async () => {
    const { findStyleViolations } = await import("@/lib/agents/persona-style");
    expect(findStyleViolations("A plain reason matters to us, not a score.")).toContain("not-contrast");
    expect(findStyleViolations("The caveat is upfront, not buried, in the memo.")).toContain("not-contrast");
    expect(findStyleViolations("Honestly, the list is too long.")).toContain("honestly");
    expect(findStyleViolations("It is worth flagging that the list is long.")).toContain("worth-flagging");
    expect(findStyleViolations("Whether or not it runs, we need it by Friday.")).not.toContain("not-contrast");
  });

  it("checks judge rationales with the patterns that apply to assessor prose", async () => {
    const { findJudgeStyleViolations } = await import("@/lib/agents/persona-style");
    expect(findJudgeStyleViolations("Good work overall. The memo states the budget, not the capacity.")).toEqual([
      "verdict-opener",
      "not-contrast",
    ]);
    // Length and chat closers do not apply to a rationale.
    expect(findJudgeStyleViolations("The memo does not state the capacity. ".repeat(20))).toEqual([]);
  });
});


describe("round-4 style patterns", () => {
  it.each([
    "This is exactly what I needed.",
    "This reads well. The budget is fixed.",
    "Fair question. The budget is fixed.",
    "Good questions. The budget is fixed.",
    "This looks solid. Send it to Priya.",
  ])("treats the showcase opener in %s as a verdict", (reply) => {
    expect(findStyleViolations(reply)).toContain("verdict-opener");
  });

  it.each([
    "Strip those rows out before any distance-based clustering.",
    "You'll get distorted centroids otherwise.",
    "The precision-at-1.25% figure is what I care about.",
    "What is the recall at 6,000?",
    "The AUC is fine by me.",
    "Pick a threshold that fills the list.",
    "Did you use cross-validation?",
    "Show me the feature importance.",
  ])("rewrites a stakeholder's method words: %s", (reply) => {
    expect(findStyleViolations(reply)).toContain("method-words");
  });

  it.each(["As I recall, the list was 6,000.", "I cannot recall the date.", "We rank by risk and call the top of the list."])(
    "leaves ordinary speech alone: %s",
    (reply) => {
      expect(findStyleViolations(reply)).not.toContain("method-words");
    },
  );

  it("does not apply the method words to judge rationales", async () => {
    const { findJudgeStyleViolations } = await import("@/lib/agents/persona-style");
    expect(findJudgeStyleViolations("The memo reports precision at the chosen threshold.")).toEqual([]);
  });
});

describe("rationale count and sponsor closer patterns", () => {
  it.each([
    "All four data-quality issues are addressed.",
    "The memo handles all 4 issues in the file.",
    "It covers all three known problems.",
  ])("flags a rationale that counts the problems to find: %s", async (rationale) => {
    const { findJudgeStyleViolations } = await import("@/lib/agents/persona-style");
    expect(findJudgeStyleViolations(rationale)).toContain("issue-count");
  });

  it("leaves a rationale without a count alone, and never applies the count to a persona reply", async () => {
    const { findJudgeStyleViolations } = await import("@/lib/agents/persona-style");
    expect(findJudgeStyleViolations("The memo addresses each issue it lists with a count from the file.")).toEqual([]);
    expect(findJudgeStyleViolations("All four columns are documented.")).toEqual([]);
    expect(findStyleViolations("All four issues are on my list.")).not.toContain("issue-count");
  });

  it.each([
    "I need those closed before this goes further.",
    "Fix the window before it moves further.",
    "Sort that before this goes anywhere near handover.",
    "The memo goes further than I asked.",
    "Timeframe is your technical call.",
  ])("treats the reworded sponsor closers as stock lines: %s", (reply) => {
    expect(findStyleViolations(reply)).toContain("stock-closer");
  });
});
