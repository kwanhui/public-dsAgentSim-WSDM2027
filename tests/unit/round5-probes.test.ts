// The round-5 probe list (scripts/replay/probes/round5.ts) and the signals
// the probe runner computes (scripts/replay/probes/signals.ts).
import { describe, expect, it } from "vitest";
import { ROUND5_PROBES, prelude } from "../../scripts/replay/probes/round5";
import { probeSignals, type StepRecord } from "../../scripts/replay/probes/signals";
import { parseCsv } from "../../scripts/replay/csv";
import { checkReleaseScope } from "@/lib/agents/release-scope";
import { loadScenario } from "@/lib/scenarios/load";

const churn = await loadScenario("customer-churn");
const forecasting = await loadScenario("demand-forecasting");

const step = (over: Partial<StepRecord>): StepRecord => ({
  phase: "probe",
  kind: "message",
  target: "client",
  sent: "",
  startedAt: "2026-09-30T00:00:00Z",
  endedAt: "2026-09-30T00:00:01Z",
  status: 200,
  events: [],
  ...over,
});

describe("round-5 probes", () => {
  it("cover S3's probes 1, 2, 5, 6, 8, 9, 11, 12, 13, 15 (churn and segmentation) and 17 (both arms)", () => {
    expect([...new Set(ROUND5_PROBES.map((p) => p.number))].sort((a, b) => a - b)).toEqual([1, 2, 5, 6, 8, 9, 11, 12, 13, 15, 17]);
    expect(new Set(ROUND5_PROBES.map((p) => p.id)).size).toBe(ROUND5_PROBES.length);
    expect(ROUND5_PROBES.find((p) => p.number === 13)!.scenario).toBe("demand-forecasting");
    expect(ROUND5_PROBES.filter((p) => p.number === 15).map((p) => p.scenario).sort()).toEqual([
      "customer-churn",
      "customer-segmentation",
    ]);
    for (const p of ROUND5_PROBES) {
      expect(p.expected.length).toBeGreaterThan(20);
      expect(p.steps.length).toBeGreaterThan(0);
    }
  });

  it("reach cleaning in churn with the patched H1 work, and modelling in forecasting with a scoped request", () => {
    const toCleaning = prelude("customer-churn", "cleaning", false);
    expect(toCleaning.filter((s) => s.kind === "submit")).toHaveLength(2);
    expect(toCleaning.map((s) => s.kind === "submit" && s.text).join("\n")).not.toMatch(/March|S\$180,000 quarterly/);
    const toModelling = prelude("demand-forecasting", "modelling", false);
    expect(toModelling.filter((s) => s.kind === "submit")).toHaveLength(3);
    // The scripted data requests pass the enforced release scope.
    for (const [scenario, steps] of [
      [churn, toCleaning],
      [forecasting, toModelling],
    ] as const) {
      const request = steps.find((s) => s.kind === "message" && s.personaId === "data-owner");
      expect(request, scenario.id).toBeDefined();
      const r = checkReleaseScope({
        scenario,
        dataset: scenario.datasets[0],
        learnerMessages: [request!.kind === "message" ? request!.text : ""],
      });
      expect(r.ok, `${scenario.id}: ${JSON.stringify(r.missing)}`).toBe(true);
    }
    expect(prelude("customer-churn", "formulation", false)).toEqual([]);
  });

  it("probe 1 sends a request that the release check refuses, and probe 17b hedges both constraints", () => {
    const p1 = ROUND5_PROBES.find((p) => p.number === 1)!;
    const first = p1.steps[0];
    expect(
      checkReleaseScope({ scenario: churn, dataset: churn.datasets[0], learnerMessages: [first.kind === "message" ? first.text : ""] }).ok,
    ).toBe(false);
    const hedged = ROUND5_PROBES.find((p) => p.id === "p17b-constraints-hedged")!.steps[0].text;
    const asked = ROUND5_PROBES.find((p) => p.id === "p17a-constraints-asked")!.steps.at(-1)!.text;
    expect(asked).toMatch(/S\$30/);
    expect(hedged).not.toMatch(/S\$30|6 months|6-month/);
    expect(hedged).toMatch(/to be confirmed/);
  });

  it("compute signals from the events and replies", () => {
    const p6 = ROUND5_PROBES.find((p) => p.number === 6)!;
    const s6 = probeSignals(p6, churn, {
      submissions: [],
      steps: [
        step({
          target: "data-owner",
          reply: "Subscribers who changed plans mid-month have two rows.",
          events: [
            { type: "fact_elicited", detail: { factId: "duplicate-rows", verified: true, matchedKey: "changed plans", detection: "reported" }, at: "x" },
            { type: "persona_consistency", detail: { personaId: "data-owner", consistent: true, disclosedEarly: [] }, at: "x" },
          ],
        }),
      ],
    });
    expect(s6.factsElicited).toEqual([{ factId: "duplicate-rows", verified: true, detection: "reported", matchedKey: "changed plans", early: false }]);
    const p9 = ROUND5_PROBES.find((p) => p.number === 9)!;
    const s9 = probeSignals(p9, churn, { submissions: [], steps: [step({ reply: "About S$30 an offer. Finance holds the value of a save." })] });
    expect(s9.offerCostKeyInReply).toEqual(["$30"]);
    expect(s9.sgdAmountsInReply).toEqual([["S$30"]]);
    const p15 = ROUND5_PROBES.find((p) => p.id === "p15a-generic-memo-churn")!;
    const s15 = probeSignals(p15, churn, {
      steps: [step({ kind: "submit", sent: p15.steps[0].text, reaction: "Did you check subscribers who changed plans?" })],
      submissions: [{ scores: [{ rationale: "Covers missing values.", improve: "Ask about each plan change." }] }],
    });
    expect(s15.factKeysInReaction).toEqual(["changed plans"]);
    expect(s15.factKeysInImproveLines).toEqual(["plan change"]);
  });

  it("parse the exports' CSV, quoted fields and all", () => {
    expect(parseCsv('a,b\n1,"x, ""y""\nz"\n2,\n')).toEqual([
      { a: "1", b: 'x, "y"\nz' },
      { a: "2", b: "" },
    ]);
  });
});
