import { describe, expect, it } from "vitest";
import {
  currentRemaining,
  messagesLeftLine,
  remainingFromResponse,
} from "@/components/workspace/message-allowance";
import { engagementTotal, engagementTotalLine } from "@/components/workspace/engagement-total";
import { formatLearnerTime } from "@/components/workspace/learner-time";
import { messageCapMessage } from "@/lib/engagement/message-cap";

describe("remaining-message line", () => {
  it("states what is left of the allowance", () => {
    expect(messagesLeftLine(184, 200)).toBe("184 of 200 messages left");
    expect(messagesLeftLine(1, 200)).toBe("1 of 200 messages left");
  });

  it("shows the cap message at zero and never counts below it", () => {
    expect(messagesLeftLine(0, 200)).toBe(messageCapMessage(200));
    expect(messagesLeftLine(-3, 200)).toBe(messageCapMessage(200));
  });

  it("reads messagesRemaining from a chat response when present", () => {
    expect(remainingFromResponse({ messagesRemaining: 12 })).toBe(12);
    expect(remainingFromResponse({ error: "message-limit", messagesRemaining: 0 })).toBe(0);
    expect(remainingFromResponse({ message: {} })).toBeNull();
    expect(remainingFromResponse(null)).toBeNull();
  });

  it("takes the lower of the bundle and the latest response", () => {
    expect(currentRemaining(190, null)).toBe(190);
    expect(currentRemaining(190, 184)).toBe(184);
    expect(currentRemaining(180, 184)).toBe(180);
  });

  it("keeps the copy free of em dashes and exclamation marks", () => {
    expect(messagesLeftLine(5, 10) + messagesLeftLine(0, 10)).not.toMatch(/[—!]/);
  });
});

describe("engagement total", () => {
  const s = (stage: string, scores: [number, number][]) => ({
    stage,
    scores: scores.map(([score, maxScore]) => ({ score, maxScore })),
  });

  it("sums the last scored submission at each stage", () => {
    const total = engagementTotal(
      [
        s("scoping", [[5, 10], [4, 10]]),
        s("scoping", [[9, 10], [10, 10]]),
        s("data", [[8, 10]]),
        s("data", []),
      ],
      true,
    );
    expect(total).toEqual({ score: 27, max: 30 });
    expect(engagementTotalLine(total)).toBe("Total 27 of 30.");
  });

  it("shows no total when scores are hidden or nothing was scored", () => {
    expect(engagementTotal([s("scoping", [[9, 10]])], false)).toBeNull();
    expect(engagementTotal([s("scoping", [])], true)).toBeNull();
    expect(engagementTotalLine(null)).toBeNull();
  });
});

describe("learner timestamps", () => {
  const opts = { locale: "en-GB", timeZone: "Asia/Singapore" };

  it("adds the date and the zone to an older timestamp", () => {
    const out = formatLearnerTime("2026-09-29T17:37:00Z", { ...opts, now: new Date("2026-10-02T00:00:00Z") });
    expect(out).toMatch(/^30 Sept?, 01:37 (SGT|GMT\+8)$/);
  });

  it("shows only the time and zone for today", () => {
    const out = formatLearnerTime("2026-09-29T17:37:00Z", { ...opts, now: new Date("2026-09-30T08:00:00Z") });
    expect(out).toMatch(/^01:37 (SGT|GMT\+8)$/);
  });

  it("uses the zone's day, not UTC's, to decide what counts as today", () => {
    // 17:37 UTC on the 29th is the 30th in Singapore; "now" is the 29th there.
    const out = formatLearnerTime("2026-09-29T17:37:00Z", { ...opts, now: new Date("2026-09-29T10:00:00Z") });
    expect(out).toMatch(/^30 Sept?, 01:37/);
  });

  it("can always include the date, and returns nothing for a bad input", () => {
    const now = new Date("2026-09-30T08:00:00Z");
    expect(formatLearnerTime("2026-09-29T17:37:00Z", { ...opts, now, withDate: true })).toMatch(/^30 Sept?, 01:37/);
    expect(formatLearnerTime("not a date")).toBe("");
  });
});
