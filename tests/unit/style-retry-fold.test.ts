import { describe, expect, it } from "vitest";
import { foldStyleRetries, styleNote } from "@/lib/admin/style-retry-fold";
import { describeEvent } from "@/lib/admin/event-labels";

const ev = (id: number, type: string, detailJson: unknown = {}) => ({ id, type, detailJson });

describe("styleNote", () => {
  it("counts the rules and says whether the rewrite fixed them", () => {
    expect(styleNote({ patterns: ["not-just", "comma-splice"], patternsAfterRetry: [] }).line).toBe(
      "style rewrite: 2 rules, fixed",
    );
    const partial = styleNote({ patterns: ["not-contrast"], patternsAfterRetry: ["not-contrast"] });
    expect(partial.line).toBe("style rewrite: 1 rule, 1 still present");
    expect(partial.detail).toContain("Still present after the rewrite: contrasted with a negation");
    expect(partial.detail).toMatch(/^Flagged: /);
    expect(styleNote({ patterns: ["em-dash"], patternsAfterRetry: null }).line).toBe(
      "style rewrite: 1 rule, rewrite failed, first draft kept",
    );
  });

  it("counts a rule that first appears in the rewrite as new, not as still present", () => {
    const swapped = styleNote({ patterns: ["exactly"], patternsAfterRetry: ["comma-splice"] });
    expect(swapped.line).toBe("style rewrite: 1 rule, 1 fixed, 1 new");
    expect(swapped.detail).not.toContain("Still present");
    expect(swapped.detail).toMatch(/^Flagged: .+\. New after the rewrite: .+\.$/);
    const both = styleNote({ patterns: ["exactly", "not-just"], patternsAfterRetry: ["exactly", "comma-splice"] });
    expect(both.line).toBe("style rewrite: 2 rules, 1 still present, 1 new");
    expect(styleNote({ patterns: ["em-dash"], patternsAfterRetry: null }).detail).toContain("The rewrite call failed");
  });
});

describe("foldStyleRetries", () => {
  it("folds a style retry into the reply of the same persona that follows it", () => {
    const rows = foldStyleRetries([
      ev(1, "persona_style_retry", { personaId: "client", kind: "turn", patterns: ["not-just"], patternsAfterRetry: [] }),
      ev(2, "persona_consistency", { personaId: "client", consistent: true }),
      ev(3, "persona_turn", { personaId: "client", styleRetry: true }),
      ev(4, "identity_question", { personaId: "client", outcome: "stated" }),
    ]);
    expect(rows.map((r) => r.event.id)).toEqual([2, 3, 4]);
    expect(rows[1].style?.line).toBe("style rewrite: 1 rule, fixed");
    expect(rows[1].folded?.id).toBe(1);
    expect(rows[0].style).toBeNull();
    expect(rows[2].style).toBeNull();
  });

  it("folds a reaction rewrite into the client reaction, not a chat reply", () => {
    const rows = foldStyleRetries([
      ev(1, "persona_style_retry", { personaId: "client", kind: "reaction", patterns: ["em-dash"], patternsAfterRetry: [] }),
      ev(2, "persona_turn", { personaId: "client" }),
      ev(3, "client_reaction", { personaId: "client" }),
    ]);
    expect(rows.map((r) => r.event.id)).toEqual([2, 3]);
    expect(rows[0].style).toBeNull();
    expect(rows[1].style?.line).toBe("style rewrite: 1 rule, fixed");
  });

  it("keeps a style retry with no reply after it as its own row", () => {
    const rows = foldStyleRetries([
      ev(1, "persona_style_retry", { personaId: "owner", kind: "turn", patterns: ["exactly"], patternsAfterRetry: [] }),
      ev(2, "persona_turn", { personaId: "client" }),
    ]);
    expect(rows.map((r) => r.event.id)).toEqual([1, 2]);
    expect(rows[0].style?.line).toBe("style rewrite: 1 rule, fixed");
    expect(rows[0].folded).toBeNull();
  });

  it("drops the reply's own style flag when the note is shown", () => {
    const detail = { personaId: "client", promptVersion: "persona-v7", styleRetry: true };
    expect(describeEvent("persona_turn", detail).summary).toBe("persona-v7 · rewritten for style");
    expect(describeEvent("persona_turn", detail, undefined, { omitStyleFlag: true }).summary).toBe("persona-v7");
  });
});
