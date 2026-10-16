// Staged sponsor pressures: which are pending, which the reaction that opens
// a stage delivers, and when a reply counts as having raised one.

import { describe, expect, it } from "vitest";
import {
  frictionRaised,
  frictionsHalfRaised,
  frictionsOpeningAt,
  frictionsRaisedIn,
  frictionsReportedAndRaised,
  pendingFrictions,
} from "@/lib/agents/frictions";
import { loadScenario } from "@/lib/scenarios/load";

const scenario = await loadScenario("customer-churn");
const client = scenario.personas.find((p) => p.role === "client-sponsor")!;
const friction = client.frictions[0];

describe("frictions", () => {
  it("are pending from their stage until the record holds them", () => {
    expect(pendingFrictions(client, "cleaning")).toEqual([]);
    expect(pendingFrictions(client, "modelling")).toEqual([friction]);
    expect(pendingFrictions(client, "testing")).toEqual([friction]);
    expect(pendingFrictions(client, "testing", [friction.ledger])).toEqual([]);
    expect(frictionRaised(friction, [` ${friction.ledger} `])).toBe(true);
  });

  it("are delivered by the reaction that opens their stage only", () => {
    expect(frictionsOpeningAt(client, "modelling")).toEqual([friction]);
    expect(frictionsOpeningAt(client, "testing")).toEqual([]);
  });

  it("count as raised when a key appears in the reply", () => {
    expect(frictionsRaisedIn("Could it also flag people we could upsell?", [friction])).toEqual([friction]);
    expect(frictionsRaisedIn("How long will modelling take?", [friction])).toEqual([]);
  });

  it("exist in every scenario's sponsor with keys the friction text states", async () => {
    for (const id of ["customer-churn", "customer-segmentation", "demand-forecasting"]) {
      const s = await loadScenario(id);
      const sponsor = s.personas.find((p) => p.role === "client-sponsor")!;
      for (const f of sponsor.frictions) expect(frictionsRaisedIn(f.text, [f]), id).toEqual([f]);
    }
  });

  it("count as raised (persona-v5) only when the id is reported and a key appears", () => {
    expect(friction.id).toBe("upsell-request");
    const reply = "Could it also flag people we could sell more to?";
    expect(frictionsReportedAndRaised(reply, [friction], ["upsell-request"])).toEqual([friction]);
    expect(frictionsReportedAndRaised(reply, [friction], ["[upsell-request]"])).toEqual([friction]);
    expect(frictionsReportedAndRaised(reply, [friction], [])).toEqual([]);
    expect(frictionsReportedAndRaised("Could it do more?", [friction], ["upsell-request"])).toEqual([]);
    expect(frictionsHalfRaised("Could it do more?", [friction], ["upsell-request"])).toEqual([
      { id: "upsell-request", reported: true, keyMatched: false },
    ]);
  });

  it("do not fire on ordinary promotion-data talk in the forecasting scenario", async () => {
    const s = await loadScenario("demand-forecasting");
    const f = s.personas.find((p) => p.role === "client-sponsor")!.frictions[0];
    expect(f.id).toBe("promotion-timing-request");
    for (const reply of [
      "Promotions are on the marketing calendar; promo_flag marks the days.",
      "We ran a promotion on eggs last week.",
      "The promotion days before June are unreliable.",
    ]) {
      expect(frictionsRaisedIn(reply, [f]), reply).toEqual([]);
    }
    expect(frictionsRaisedIn("Could the model also tell us when to run promotions?", [f])).toEqual([f]);
    expect(frictionsRaisedIn("Could it help us time our promotions?", [f])).toEqual([f]);
  });
});

