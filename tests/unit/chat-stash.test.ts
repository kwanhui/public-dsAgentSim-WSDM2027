// The in-flight message stash behind the chat pane (components/workspace/
// chat-stash.ts). The server persists a learner's question only together
// with the persona's reply, so a tab closed mid-turn loses the question; the
// pane stashes the message at send time, clears it when the reply confirms
// persistence, and on mount restores a stranded stash into the box (peek in
// the state initialiser, clear in an effect, so the repeatable read and the
// one-off clear stay apart). Storage can be missing or throwing (private
// windows, blocked site data), and none of that may break sending.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStashedMessage,
  peekStashedMessage,
  stashInFlightMessage,
  stashKey,
} from "@/components/workspace/chat-stash";

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

describe("chat stash keys", () => {
  it("scopes the stash to one channel", () => {
    expect(stashKey("chan-1")).not.toBe(stashKey("chan-2"));
    stashInFlightMessage("chan-1", "for the sponsor");
    stashInFlightMessage("chan-2", "for the data owner");
    expect(peekStashedMessage("chan-1")).toBe("for the sponsor");
    expect(peekStashedMessage("chan-2")).toBe("for the data owner");
  });

  it("stays inside the app's namespace so it cannot collide with other keys", () => {
    expect(stashKey("chan-1")).toMatch(/^agenticpracticum:/);
  });
});

describe("stash, peek, clear", () => {
  it("peeks without consuming, so a state initialiser can read it repeatedly", () => {
    stashInFlightMessage("chan-1", "did the extract land?");
    expect(peekStashedMessage("chan-1")).toBe("did the extract land?");
    expect(peekStashedMessage("chan-1")).toBe("did the extract land?");
  });

  it("returns null when nothing was stashed", () => {
    expect(peekStashedMessage("chan-1")).toBeNull();
  });

  it("clears the stash so a restored message does not resurface", () => {
    stashInFlightMessage("chan-1", "in flight");
    clearStashedMessage("chan-1");
    expect(peekStashedMessage("chan-1")).toBeNull();
  });

  it("overwrites the stash on the next send", () => {
    stashInFlightMessage("chan-1", "first try");
    stashInFlightMessage("chan-1", "second try");
    expect(peekStashedMessage("chan-1")).toBe("second try");
  });

  it("treats a whitespace-only stash as nothing to restore", () => {
    stashInFlightMessage("chan-1", "   ");
    expect(peekStashedMessage("chan-1")).toBeNull();
  });
});

describe("storage that throws", () => {
  it("swallows a throwing setItem so the send still goes out", () => {
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => stashInFlightMessage("chan-1", "hello")).not.toThrow();
  });

  it("returns null instead of throwing when getItem throws", () => {
    storage.getItem = () => {
      throw new Error("SecurityError");
    };
    expect(peekStashedMessage("chan-1")).toBeNull();
  });

  it("swallows a throwing removeItem on clear", () => {
    storage.removeItem = () => {
      throw new Error("SecurityError");
    };
    expect(() => clearStashedMessage("chan-1")).not.toThrow();
  });

  it("copes with no window at all", () => {
    vi.unstubAllGlobals();
    expect(() => stashInFlightMessage("chan-1", "hello")).not.toThrow();
    expect(peekStashedMessage("chan-1")).toBeNull();
    expect(() => clearStashedMessage("chan-1")).not.toThrow();
  });
});
