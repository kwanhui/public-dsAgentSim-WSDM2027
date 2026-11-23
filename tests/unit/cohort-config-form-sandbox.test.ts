// The Configuration form's sandbox fields: the per-network seat limit and the
// optional event window round-trip through the draft, are validated before a
// save, and are written in the shape the schema stores.

import { describe, expect, it } from "vitest";
import { CohortConfigSchema, DEFAULT_COHORT_CONFIG, type CohortConfig } from "@/lib/cohort/defaults";
import { toConfig, toDraft, validate } from "@/components/admin/cohort-config-form";

const stored: CohortConfig = {
  ...DEFAULT_COHORT_CONFIG,
  sandbox: { ...DEFAULT_COHORT_CONFIG.sandbox, openJoin: true, dailyBudgetUsd: 8 },
};

describe("Configuration form, sandbox limits", () => {
  it("shows the stored per-network limit and saves a changed one", () => {
    const draft = toDraft(stored);
    expect(draft.joinsPerAddress).toBe("5");
    expect(draft.eventOn).toBe(false);
    const saved = toConfig({ ...draft, joinsPerAddress: "8" }, stored);
    expect(saved.sandbox.maxJoinsPerAddressPerDay).toBe(8);
    expect(saved.sandbox.eventWindow).toBeNull();
    expect(CohortConfigSchema.safeParse(saved).success).toBe(true);
  });

  it("refuses a per-network limit below 1", () => {
    expect(validate({ ...toDraft(stored), joinsPerAddress: "0" }, false).joinsPerAddress).toBeDefined();
    expect(validate({ ...toDraft(stored), joinsPerAddress: "1" }, false).joinsPerAddress).toBeUndefined();
  });

  it("saves an event window that the schema accepts and reads it back", () => {
    const draft = {
      ...toDraft(stored),
      eventOn: true,
      eventStart: "2027-02-15T00:00:00+08:00",
      eventEnd: "2027-02-20T00:00:00+08:00",
      eventJoinsPerAddress: "50",
      eventBudget: "30",
    };
    expect(validate(draft, false)).toEqual({});
    const saved = toConfig(draft, stored);
    expect(saved.sandbox.eventWindow).toEqual({
      startsAt: "2027-02-15T00:00:00+08:00",
      endsAt: "2027-02-20T00:00:00+08:00",
      maxJoinsPerAddressPerDay: 50,
      dailyBudgetUsd: 30,
    });
    expect(CohortConfigSchema.safeParse(saved).success).toBe(true);
    expect(toDraft(saved)).toMatchObject({ eventOn: true, eventJoinsPerAddress: "50", eventBudget: "30" });
  });

  it("refuses a window without an offset, or one that ends before it starts", () => {
    const base = { ...toDraft(stored), eventOn: true, eventJoinsPerAddress: "50", eventBudget: "30" };
    const noOffset = validate({ ...base, eventStart: "2027-02-15T00:00:00", eventEnd: "2027-02-20T00:00:00+08:00" }, false);
    expect(noOffset.eventStart).toBeDefined();
    const backwards = validate({ ...base, eventStart: "2027-02-20T00:00:00+08:00", eventEnd: "2027-02-15T00:00:00+08:00" }, false);
    expect(backwards.eventEnd).toMatch(/after the start/);
  });

  it("clears the window when it is switched off, and keeps it behind a closed sandbox", () => {
    const withWindow: CohortConfig = {
      ...stored,
      sandbox: {
        ...stored.sandbox,
        eventWindow: { startsAt: "2027-02-15T00:00:00+08:00", endsAt: "2027-02-20T00:00:00+08:00", maxJoinsPerAddressPerDay: 50, dailyBudgetUsd: 30 },
      },
    };
    expect(toConfig({ ...toDraft(withWindow), eventOn: false }, withWindow).sandbox.eventWindow).toBeNull();
    expect(toConfig({ ...toDraft(withWindow), openJoin: false }, withWindow).sandbox.eventWindow).toEqual(withWindow.sandbox.eventWindow);
  });
});
