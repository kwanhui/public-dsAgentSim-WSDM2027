import { describe, expect, it } from "vitest";
import { demoContact, noticeStorageLine, providerLine } from "@/app/privacy/provider-line";

describe("privacy page provider line", () => {
  it("names the configured provider, the transfer out of Singapore and the provider's own terms", () => {
    expect(providerLine("anthropic")).toContain("sent to Anthropic");
    expect(providerLine("openai")).toContain("sent to OpenAI");
    expect(providerLine("anthropic")).toMatch(/outside Singapore/);
    expect(providerLine("anthropic")).toMatch(/Anthropic's terms on how long it keeps them apply/);
  });

  it("says nothing leaves the server for the offline test model", () => {
    expect(providerLine("mock")).toBe("This deployment runs an offline test model; nothing leaves this server.");
  });

  it("keeps the copy free of em dashes and exclamation marks", () => {
    for (const p of ["anthropic", "openai", "mock"]) {
      expect(providerLine(p)).not.toMatch(/[—!]/);
      expect(noticeStorageLine(p, "invite")).not.toMatch(/[—!]/);
    }
  });
});

describe("workspace notice and privacy page agree", () => {
  it("does not tell a mock-mode learner that messages go to a provider", () => {
    expect(noticeStorageLine("mock", "invite")).toBe(
      "Your messages stay on this server (an offline test model answers) and are stored for your instructor.",
    );
    expect(noticeStorageLine("mock", "sandbox")).toBe(
      "An offline test model answers, so your messages stay on this demo server, where the demo authors can read them. Your demo seat lives in this browser only: signing out or clearing this site's data ends it, and it cannot be opened on another device. This demo engagement is deleted automatically 30 days after you joined.",
    );
  });

  it("tells a sandbox visitor who can read their work and, when set, how to reach them", () => {
    expect(noticeStorageLine("anthropic", "sandbox", "demo@example.org")).toBe(
      "Your messages are sent to Anthropic and stored on this demo server, where the demo authors can read them. Your demo seat lives in this browser only: signing out or clearing this site's data ends it, and it cannot be opened on another device. This demo engagement is deleted automatically 30 days after you joined. Contact the demo authors: demo@example.org.",
    );
    expect(noticeStorageLine("anthropic", "sandbox", "  ")).not.toMatch(/Contact/);
    expect(noticeStorageLine("anthropic", "invite", "demo@example.org")).not.toMatch(/Contact|demo authors/);
    expect(demoContact({ DEMO_CONTACT: " a@b.org " } as unknown as NodeJS.ProcessEnv)).toBe("a@b.org");
    expect(demoContact({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("names the same provider as the privacy page", () => {
    expect(noticeStorageLine("anthropic", "invite")).toBe("Your messages are sent to Anthropic and stored for your instructor.");
    expect(noticeStorageLine("openai", "sandbox")).toBe(
      "Your messages are sent to OpenAI and stored on this demo server, where the demo authors can read them. Your demo seat lives in this browser only: signing out or clearing this site's data ends it, and it cannot be opened on another device. This demo engagement is deleted automatically 30 days after you joined.",
    );
  });
});

describe("sandbox deletion period", () => {
  it("is the same in the workspace notice and the retention purge", async () => {
    const { SANDBOX_DELETION_DAYS } = await import("@/app/privacy/provider-line");
    const { SANDBOX_RETENTION_DAYS } = await import("@/lib/logging/retention");
    expect(SANDBOX_DELETION_DAYS).toBe(SANDBOX_RETENTION_DAYS);
  });
});
