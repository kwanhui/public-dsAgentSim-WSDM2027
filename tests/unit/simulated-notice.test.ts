import { describe, expect, it } from "vitest";
import {
  joinNames,
  simulatedNoticeKey,
  simulatedNoticeLines,
  stakeholderNames,
  storageNoticeLine,
} from "@/lib/engagement/simulated-notice";
import { loadScenario } from "@/lib/scenarios/load";

describe("simulated-stakeholder notice", () => {
  it("names the three churn stakeholders in role order", async () => {
    const scenario = await loadScenario("customer-churn");
    expect(simulatedNoticeLines(scenario.personas)).toEqual([
      "Sarah Tan, Marcus Wong and Priya Nair are simulated by a language model.",
      "Your messages are sent to the model provider and stored for your instructor.",
    ]);
  });

  it("orders by role, not by scenario file order", () => {
    expect(
      stakeholderNames([
        { name: "End", role: "end-user" },
        { name: "Client", role: "client-sponsor" },
        { name: "Data", role: "data-owner" },
      ]),
    ).toEqual(["Client", "Data", "End"]);
  });

  it("joins one, two and three names plainly", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("keeps the copy free of em dashes and exclamation marks", () => {
    const text = simulatedNoticeLines([{ name: "A", role: "client-sponsor" }]).join(" ");
    expect(text).not.toMatch(/[—!]/);
    expect(text).toContain("A is simulated");
  });

  it("keys the dismissal per learner", () => {
    expect(simulatedNoticeKey("abc")).not.toBe(simulatedNoticeKey("def"));
  });
});

describe("notice wording by join route", () => {
  const personas = [{ name: "A", role: "client-sponsor" }];

  it("tells an invited learner the messages are stored for the instructor", () => {
    expect(simulatedNoticeLines(personas, "invite")[1]).toBe(
      "Your messages are sent to the model provider and stored for your instructor.",
    );
    expect(simulatedNoticeLines(personas)[1]).toBe(simulatedNoticeLines(personas, "invite")[1]);
  });

  it("tells a sandbox visitor the messages are stored on the demo server", () => {
    const line = simulatedNoticeLines(personas, "sandbox")[1];
    expect(line).toBe("Your messages are sent to the model provider and stored on this demo server.");
    expect(line).not.toContain("instructor");
    expect(storageNoticeLine("sandbox")).toBe(line);
  });

  it("keeps the instructor wording for the analyst agent's seat", () => {
    expect(storageNoticeLine("agent")).toBe(storageNoticeLine("invite"));
  });
});
