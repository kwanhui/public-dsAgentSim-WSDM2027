import { describe, expect, it } from "vitest";
import { plainChatText } from "@/lib/admin/chat-text";

describe("plainChatText", () => {
  it("removes emphasis markers", () => {
    expect(plainChatText("one row per *individual subscribers* and **not** households")).toBe(
      "one row per individual subscribers and not households",
    );
    expect(plainChatText("__bold__ and _italic_")).toBe("bold and italic");
  });

  it("shows bullet markers as bullets and drops headings", () => {
    expect(plainChatText("## Plan\n- first\n* second\n  + nested")).toBe("Plan\n• first\n• second\n  • nested");
  });

  it("keeps column names, arithmetic and numbered lists", () => {
    const text = "Use tenure_months and plan_type.\n1. 8,170 * 0.03 is about 245\n2. done";
    expect(plainChatText(text)).toBe(text);
  });

  it("unwraps inline code and links", () => {
    expect(plainChatText("the `churned` flag, see [the dictionary](https://example.org/d)")).toBe(
      "the churned flag, see the dictionary (https://example.org/d)",
    );
  });
});
