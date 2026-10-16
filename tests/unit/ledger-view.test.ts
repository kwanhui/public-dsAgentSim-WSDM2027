import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {} }));

const { ledgerViewRows } = await import("@/lib/admin/ledger-view");

const scenario = {
  personas: [
    {
      id: "client",
      withheld: [{ id: "offer-cost", fact: "A retention offer costs about S$30 to serve.", keys: ["$30", "30 dollars"] }],
    },
  ],
} as unknown as Parameters<typeof ledgerViewRows>[1];

const row = (fact: string, provenance: string, source = "client", stage = "formulation") =>
  ({ fact, provenance, source, stage }) as Parameters<typeof ledgerViewRows>[0][number];

describe("ledgerViewRows", () => {
  it("shows a persona fact and its elicited twin once, with both tags", () => {
    const rows = ledgerViewRows(
      [
        row("Scenario seed fact.", "seed", "system"),
        row("Each retention offer costs approximately S$30.", "persona"),
        row("A retention offer costs about S$30 to serve.", "elicited"),
        row("Sarah wants a list by Friday.", "persona"),
      ],
      scenario,
    );
    expect(rows.map((r) => r.tags)).toEqual([["seed"], ["persona", "elicited"], ["persona"]]);
    expect(rows[1].fact).toBe("A retention offer costs about S$30 to serve.");
    expect(rows[1].personaWording).toBe("Each retention offer costs approximately S$30.");
  });

  it("leaves an elicited row alone when no persona row states the fact", () => {
    const rows = ledgerViewRows(
      [row("Offers are popular.", "persona"), row("A retention offer costs about S$30 to serve.", "elicited")],
      scenario,
    );
    expect(rows.map((r) => r.tags)).toEqual([["persona"], ["elicited"]]);
  });

  it("does not fold a persona row from another persona or stage", () => {
    const rows = ledgerViewRows(
      [
        row("Offers cost S$30.", "persona", "owner"),
        row("Offers cost S$30 each.", "persona", "client", "data-audit"),
        row("A retention offer costs about S$30 to serve.", "elicited"),
      ],
      scenario,
    );
    expect(rows).toHaveLength(3);
  });
});
