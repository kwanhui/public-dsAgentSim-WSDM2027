// Gate-draft autosave (components/workspace/draft-stash.ts): kept per
// engagement and stage, restored on the next visit, cleared after a
// submission, and harmless when storage is missing or throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  draftKey,
  draftSavedLine,
  loadDraft,
  saveDraft,
} from "@/components/workspace/draft-stash";

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gate draft autosave", () => {
  it("keys drafts by engagement and stage", () => {
    expect(draftKey("e1", "formulation")).not.toBe(draftKey("e1", "cleaning"));
    expect(draftKey("e1", "formulation")).not.toBe(draftKey("e2", "formulation"));
  });

  it("restores a saved draft with its time", () => {
    const at = new Date("2026-09-30T14:32:00");
    saveDraft("e1", "formulation", "Objective: rank subscribers", at);
    expect(loadDraft("e1", "formulation")).toEqual({
      text: "Objective: rank subscribers",
      savedAt: at.toISOString(),
    });
    expect(loadDraft("e1", "cleaning")).toBeNull();
  });

  it("clears the draft after a submission", () => {
    saveDraft("e1", "formulation", "text");
    clearDraft("e1", "formulation");
    expect(loadDraft("e1", "formulation")).toBeNull();
  });

  it("drops the entry when the box is emptied", () => {
    saveDraft("e1", "formulation", "text");
    expect(saveDraft("e1", "formulation", "   ")).toBeNull();
    expect(storage.store.size).toBe(0);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new Error("blocked");
      },
    });
    expect(saveDraft("e1", "formulation", "text")).toBeNull();
    expect(loadDraft("e1", "formulation")).toBeNull();
    expect(() => clearDraft("e1", "formulation")).not.toThrow();
  });

  it("formats the saved line as local HH:MM with the zone, as the chat does", () => {
    const opts = { timeZone: "Asia/Singapore", locale: "en-GB", now: new Date("2026-09-30T02:00:00Z") };
    expect(draftSavedLine("2026-09-30T01:05:00Z", opts)).toMatch(/^Draft saved in this browser 09:05 (SGT|GMT\+8)$/);
    expect(draftSavedLine("garbage")).toBe("Draft saved in this browser");
  });
});
