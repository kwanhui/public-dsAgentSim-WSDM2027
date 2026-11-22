// Scenario lint. The churn scenario shipped
// with a budget that did not cover the offer capacity at the withheld offer
// cost (S$180,000 a quarter against 6,000 offers a month at S$30), and an
// outage month outside the usage window; every seeded defect was also
// written into the learner's data dictionary. These checks keep the numbers
// in each scenario consistent with each other and with the committed data,
// and keep one defect per scenario out of the learner-facing text.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario } from "@/lib/scenarios/load";
import { stageReached, type Scenario } from "@/lib/scenarios/types";

const IDS = ["customer-churn", "customer-segmentation", "demand-forecasting"] as const;
const scenarios = Object.fromEntries(await Promise.all(IDS.map(async (id) => [id, await loadScenario(id)]))) as Record<
  (typeof IDS)[number],
  Scenario
>;

async function csvRows(id: string, file: string): Promise<Record<string, string>[]> {
  const text = await readFile(resolve(process.cwd(), "datasets", id, file), "utf8");
  const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.length > 0);
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

function num(text: string): number {
  return Number(text.replace(/,/g, ""));
}

// Every place a scenario states something: seed, brief, cards, withheld
// facts, frictions, guidance, instructions, both rubric wordings, the
// constraints to elicit, and the dictionaries and notes.
function allText(s: Scenario): string[] {
  return [
    s.brief,
    ...s.worldFactsSeed,
    ...s.personas.flatMap((p) => [
      p.card,
      ...p.withheld.flatMap((w) => [w.fact, w.revealWhen]),
      ...p.frictions.flatMap((f) => [f.text, f.ledger]),
    ]),
    ...s.stages.flatMap((st) => [
      st.guidance,
      st.gate.instructions,
      ...st.gate.rubric.flatMap((c) => [c.criterion, c.learnerText, ...c.constraints]),
    ]),
    ...s.datasets.flatMap((d) => [d.dictionary, d.notes ?? "", d.description]),
  ];
}

function withheld(s: Scenario, id: string) {
  const w = s.personas.flatMap((p) => p.withheld).find((x) => x.id === id);
  if (!w) throw new Error(`no withheld fact ${id} in ${s.id}`);
  return w;
}

// Learner-facing text: what the workspace shows before and during a stage.
function learnerText(s: Scenario): string[] {
  return [
    s.brief,
    ...s.stages.flatMap((st) => [st.guidance, st.gate.instructions, ...st.gate.rubric.map((c) => c.learnerText)]),
    ...s.datasets.flatMap((d) => [d.description, d.dictionary]),
  ];
}

describe("numeric identities", () => {
  it("churn: the quarterly budget pays for the monthly offer capacity at the withheld offer cost", () => {
    const s = scenarios["customer-churn"];
    const seed = s.worldFactsSeed.join(" ");
    const budget = num(seed.match(/quarterly campaign budget is S\$([\d,]+)/)![1]);
    const capacity = num(seed.match(/roughly ([\d,]+) retention offers per month/)![1]);
    const cost = num(withheld(s, "offer-cost").fact.match(/S\$(\d+)/)![1]);
    expect(budget).toBe(540_000);
    expect(budget).toBe(capacity * cost * 3);
    // Every budget figure anywhere in the scenario is the same one.
    const budgets = allText(s).flatMap((t) => [...t.matchAll(/S\$([\d,]+(?:K)?)[^.]{0,40}budget|budget[^.]{0,40}S\$([\d,]+(?:K)?)/gi)]);
    expect(budgets.length).toBeGreaterThanOrEqual(3);
    for (const m of budgets) expect(m[1] ?? m[2], m[0]).toBe("540,000");
    // The card's capacity matches the seed.
    const client = s.personas.find((p) => p.role === "client-sponsor")!;
    expect(client.card).toContain(`about ${capacity.toLocaleString("en-US")} offers a month`);
  });

  it("churn: the usage outage falls inside the three-month usage window", () => {
    const s = scenarios["customer-churn"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const observation = months.indexOf(s.datasets[0].notes!.match(/the (\w+) observation month/)![1]);
    const window = [observation - 2, observation - 1, observation].map((i) => months[i]);
    const outage = s.datasets[0].dictionary.match(/the (\w+) mediation outage/)![1];
    expect(window).toContain(outage);
    // The dictionary and the rubric name the same month, and no other.
    for (const t of allText(s)) {
      for (const m of t.matchAll(/(\w+) (?:mediation )?(?:outage|usage gap)/g)) {
        if (months.includes(m[1])) expect(m[1], t).toBe(outage);
      }
    }
  });

  it("segmentation: the audience limit and the open-rate fall agree everywhere", () => {
    const s = scenarios["customer-segmentation"];
    for (const t of allText(s)) {
      for (const m of t.matchAll(/(\d+)\s*(?:-|to)\s*(\d+) (?:actionable |distinct campaign )?audiences/g)) {
        expect(`${m[1]}-${m[2]}`, t).toBe("4-8");
      }
    }
    expect(s.worldFactsSeed.join(" ")).toContain("from 24% to 15%");
    expect(s.personas[0].card).toMatch(/24%\s+to 15%/);
  });

  it("forecasting: a lost sale costs more than a wasted loaf, and the wastage range agrees", () => {
    const s = scenarios["demand-forecasting"];
    const [waste, lost] = [...withheld(s, "error-costs").fact.matchAll(/S\$(\d+\.\d+)/g)].map((m) => Number(m[1]));
    expect(lost).toBeGreaterThan(waste);
    for (const t of allText(s)) {
      for (const m of t.matchAll(/(\d+)-(\d+)% (?:of food cost|wastage)/g)) expect(`${m[1]}-${m[2]}`, t).toBe("8-11");
    }
  });
});

describe("withheld facts agree with the seed and the committed data", () => {
  it("churn: the repeated ids and the dictionary's missing-usage share are in the extract", async () => {
    const s = scenarios["customer-churn"];
    const rows = await csvRows(s.id, "churn_extract.csv");
    const ids = new Map<string, number>();
    for (const r of rows) ids.set(r.subscriber_id, (ids.get(r.subscriber_id) ?? 0) + 1);
    expect([...ids.values()].some((n) => n === 2)).toBe(true);
    const share = rows.filter((r) => r.data_usage_gb === "").length / rows.length;
    const stated = Number(s.datasets[0].dictionary.match(/missing \(~(\d+)% of rows\)/)![1]) / 100;
    expect(Math.abs(share - stated)).toBeLessThan(0.005);
  });

  it("segmentation: the test accounts and the dictionary's blank ages are in the extract", async () => {
    const s = scenarios["customer-segmentation"];
    const rows = await csvRows(s.id, "loyalty_extract.csv");
    expect(rows.some((r) => r.member_id.startsWith("T"))).toBe(true);
    const blank = rows.filter((r) => r.age === "").length / rows.length;
    const stated = Number(s.datasets[0].dictionary.match(/not\s+given \(~(\d+)%\)/)![1]) / 100;
    expect(Math.abs(blank - stated)).toBeLessThan(0.01);
    expect(rows.some((r) => r.age === "0" || r.age === "999")).toBe(true);
  });

  it("forecasting: the migration month has the doubled Jurong days, inside the extract's range", async () => {
    const s = scenarios["demand-forecasting"];
    const rows = await csvRows(s.id, "daily_sales.csv");
    const fact = withheld(s, "pos-migration").fact;
    const [, month, year] = fact.match(/in (\w+) (\d{4})/)!;
    const mm = String(new Date(`${month} 1, ${year}`).getMonth() + 1).padStart(2, "0");
    const toast = rows.filter((r) => r.outlet_id === "K05" && r.category === "toast").map((r) => Number(r.units_sold));
    const median = toast.sort((a, b) => a - b)[Math.floor(toast.length / 2)];
    const doubled = rows.filter(
      (r) => r.outlet_id === "K05" && r.category === "toast" && r.date.startsWith(`${year}-${mm}`) && Number(r.units_sold) > 1.7 * median,
    );
    const days = Number(fact.match(/double-posted (\w+) days/)![1] === "eight" ? 8 : NaN);
    expect(doubled).toHaveLength(days);
    // The Tampines opening and the promo cut-off in the dictionary match the data.
    const tampines = rows.filter((r) => r.outlet_id === "K06").map((r) => r.date).sort()[0];
    expect(tampines.startsWith("2025-08")).toBe(true);
    expect(s.datasets[0].dictionary).toContain("K06 Tampines opened in August 2025");
  });
});

describe("one undocumented defect per scenario", () => {
  // Words that would give the withheld defect away in learner-facing text.
  const TELLS: Record<string, RegExp> = {
    "duplicate-rows": /appear twice|double-count|duplicate|plan changes|changed plans|more than once/i,
    "test-accounts": /test account|staff|beginning with "T"|"T" id/i,
    "pos-migration": /migrat|double-post|doubled|level shift|cutover/i,
  };

  for (const id of IDS) {
    it(`${id}: exactly one withheld defect is left out of the dictionary, notes and learner text`, () => {
      const s = scenarios[id];
      const undocumented = s.datasets.flatMap((d) => d.undocumentedDefects);
      expect(undocumented).toHaveLength(1);
      const [factId] = undocumented;
      // It is a data owner's withheld fact, so a precise question reveals it.
      const owner = s.personas.find((p) => p.role === "data-owner")!;
      expect(owner.withheld.map((w) => w.id)).toContain(factId);
      const tell = TELLS[factId];
      expect(tell, factId).toBeDefined();
      for (const d of s.datasets) {
        expect(d.dictionary, `${id} dictionary`).not.toMatch(tell);
        expect(d.notes ?? "", `${id} notes`).not.toMatch(tell);
      }
      for (const t of learnerText(s)) expect(t, id).not.toMatch(tell);
      // The data owner's card (outside the withheld list) does not state it
      // either, so the one-issue answer to a broad question cannot pick it.
      expect(owner.card.split("Facts you know about the extract")[1] ?? "", id).not.toMatch(tell);
    });
  }
});

describe("learner-facing wording", () => {
  const FACTS: Record<string, RegExp> = {
    "customer-churn": /6,000|S\$30|540|480,000|involuntar|total_charges|May|6 more months|postpaid-only|upsell/i,
    "customer-segmentation": /4-8|0\/999|999|refund|'T'|test account|two months|23|credit-card|lapsed/i,
    "demand-forecasting": /2\.60|4\.80|asymmetr|migrat|Jurong|June 2025|August 2025|weather|blame|accountable|promotion timing|long-weekend|long weekend/i,
  };

  for (const id of IDS) {
    it(`${id}: every criterion has a fact-free learner wording`, () => {
      const s = scenarios[id];
      for (const st of s.stages) {
        for (const c of st.gate.rubric) {
          expect(c.learnerText.length, `${id}/${c.id}`).toBeGreaterThan(20);
          expect(c.learnerText, `${id}/${c.id}`).not.toMatch(/\d/);
          expect(c.learnerText, `${id}/${c.id}`).not.toMatch(FACTS[id]);
          // A third-person verb first, so the wording reads as a sentence
          // about the work ("States ...").
          expect(c.learnerText, `${id}/${c.id}`).toMatch(/^[A-Z][a-z]+s\b/);
          expect(c.learnerText).not.toBe(c.criterion);
        }
      }
    });

    it(`${id}: stage guidance and gate instructions name no seeded defect or withheld fact`, () => {
      const s = scenarios[id];
      const withheldTells = s.personas.flatMap((p) => p.withheld.map((w) => w.id));
      expect(withheldTells.length).toBeGreaterThan(0);
      for (const st of s.stages) {
        for (const text of [st.guidance, st.gate.instructions]) {
          expect(text, `${id}/${st.id}`).not.toMatch(
            /duplicate|appear more than once|involuntary|test account|sentinel|0\/999|negative spend|migration|double-post|Jurong|asymmetric|segment-hopping|accountable|long-weekend|reason codes|credit-card|upsell|6,000|S\$30/i,
          );
        }
      }
    });
  }
});

describe("withheld facts are not already given to the learner", () => {
  // A fact the learner can read in the dictionary or the release profile is
  // not elicitation; counting its reveal measures nothing. No withheld fact
  // may state a figure or phrase that the dictionary, the notes, the brief or
  // the stage guidance already gives, and none of its keys may appear there.
  for (const id of IDS) {
    it(`${id}: no withheld key appears in the dictionary, notes, brief or guidance`, async () => {
      const { findKey } = await import("@/lib/engagement/elicitation");
      const s = scenarios[id];
      const given = [s.brief, ...s.worldFactsSeed, ...s.datasets.flatMap((d) => [d.dictionary, d.notes ?? "", d.description])];
      for (const w of s.personas.flatMap((p) => p.withheld)) {
        expect(w.keys.length, w.id).toBeGreaterThan(0);
        for (const t of given) expect(findKey(t, w.keys), `${id}/${w.id}`).toBeNull();
        // The fact itself states a key, so a reply that repeats it verifies.
        expect(findKey(w.fact, w.keys), `${id}/${w.id} states none of its keys`).not.toBeNull();
      }
    });
  }

  it("the facts the dictionary gives are no longer withheld", () => {
    const ids = IDS.flatMap((id) => scenarios[id].personas.flatMap((p) => p.withheld.map((w) => w.id)));
    expect(ids).not.toContain("usage-outage");
    expect(ids).not.toContain("age-field");
  });
});

describe("end users, constraints and owners", () => {
  for (const id of IDS) {
    it(`${id}: the end user is reachable from data collection`, () => {
      const endUser = scenarios[id].personas.find((p) => p.role === "end-user")!;
      expect(endUser.unlockedAtStage).toBe("data-collection");
    });

    it(`${id}: a criterion names constraints to elicit, and every owner is a persona reachable at its stage`, () => {
      const s = scenarios[id];
      const withConstraints = s.stages.flatMap((st) => st.gate.rubric).filter((c) => c.constraints.length > 0);
      expect(withConstraints.length).toBeGreaterThanOrEqual(1);
      for (const st of s.stages) {
        for (const c of st.gate.rubric) {
          if (!c.owner) continue;
          const owner = s.personas.find((p) => p.id === c.owner);
          expect(owner, `${id}/${c.id}`).toBeDefined();
          expect(stageReached(st.id, owner!.unlockedAtStage), `${id}/${c.id}`).toBe(true);
        }
      }
      // The constraints the formulation criterion lists are the sponsor's
      // withheld facts, so eliciting them is possible at formulation.
      const formulation = s.stages[0].gate.rubric.filter((c) => c.constraints.length > 0);
      expect(formulation.length, id).toBe(1);
      expect(formulation[0].owner).toBe("client");
    });

    it(`${id}: the scope-change criterion is not applicable when no change was raised, and the friction has keys and a ledger line`, () => {
      const s = scenarios[id];
      const modelling = s.stages.find((st) => st.id === "modelling")!;
      const scope = modelling.gate.rubric.find((c) => c.id === "scope-discipline")!;
      expect(scope.criterion).toContain("Not applicable when the engagement record shows that the client raised no scope change");
      const client = s.personas.find((p) => p.role === "client-sponsor")!;
      for (const f of client.frictions) {
        expect(f.keys.length).toBeGreaterThan(0);
        expect(f.ledger.length).toBeGreaterThan(20);
      }
    });
  }
});

describe("withheld ids, frictions and ownership", () => {
  for (const id of IDS) {
    it(`${id}: ids are unique, frictions are staged, and every persona owns some questions`, () => {
      const s = scenarios[id];
      const ids = s.personas.flatMap((p) => p.withheld.map((w) => w.id));
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of s.personas) expect(p.owns.length, `${id}/${p.id}`).toBeGreaterThan(0);
      const client = s.personas.find((p) => p.role === "client-sponsor")!;
      expect(client.frictions.map((f) => f.stage)).toEqual(["modelling"]);
      // The scope request lives in the staged friction, not the card, so it
      // cannot surface at the first gate.
      expect(client.card).not.toMatch(/upsell|credit-card partnership|when to run promotions/);
    });
  }
});
