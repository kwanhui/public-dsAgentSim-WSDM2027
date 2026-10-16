// Key hygiene for the elicitation trace. Every withheld fact's keys must
// match the ways a stakeholder would state the fact (figures as digits and
// as words, "S$30" and "S$ 30", "six-month", "6 months" and "six months"),
// and must not match text that does not state it: the persona's own card,
// the brief and seed facts, the dictionaries, the other facts of the
// scenario, and a set of ordinary replies. A key that is too broad makes
// the trace record a reveal that did not happen; a key that is too narrow
// misses one that did.

import { describe, expect, it } from "vitest";
import { findKey, normaliseForKeys } from "@/lib/engagement/elicitation";
import { loadScenario } from "@/lib/scenarios/load";
import type { Scenario } from "@/lib/scenarios/types";

const IDS = ["customer-churn", "customer-segmentation", "demand-forecasting"] as const;
const scenarios: Record<string, Scenario> = Object.fromEntries(
  await Promise.all(IDS.map(async (id) => [id, await loadScenario(id)] as const)),
);

// How a stakeholder might state each fact. Each line must match a key.
const PARAPHRASES: Record<string, string[]> = {
  "offer-cost": [
    "An offer costs us about S$30 to serve.",
    "Each offer is roughly S$ 30.",
    "It is about thirty dollars per offer.",
    "Budget around SGD 30 an offer.",
    "Serving one costs 30 SGD.",
    "We spend $30 a head on the offer.",
  ],
  "save-definition": [
    "Finance counts a save only if the subscriber stays 6 more months.",
    "They have to stay six more months to count.",
    "A save means they stay with us for a further 6 months.",
    "The customer has to remain for six months after the offer.",
    "It only counts if they are still here at least six months after the offer.",
    "Finance uses a six-month save rule.",
    "We apply a 6-month save definition.",
    "They need to stay for six months.",
    "The subscriber stays another six months or it is not a save.",
  ],
  "duplicate-rows": [
    "Subscribers who changed plans mid-month get two rows.",
    "A plan change in the month writes a second row.",
    "The extract writes one row per plan held in the month.",
    "People who switch plans partway through the month appear twice.",
    "If someone switched plan during the month, they show up twice.",
  ],
  "offer-levers": [
    "We can give 10 to 20% loyalty discounts on a recontract.",
    "We have handset upgrade vouchers.",
    "Data top-ups are the other lever.",
    "A data top up is the cheapest thing we offer.",
    "We cannot touch base plan pricing.",
    "Discounts of 10-20% are what we have.",
  ],
  "first-use-timeline": [
    "I want the first campaign out within two months.",
    "We need it in use in 2 months.",
    "Eight weeks from now at the latest.",
    "The first campaign goes out in 8 weeks.",
    "I need them live in two months' time.",
  ],
  "past-vendor": [
    "A previous vendor gave us 23 micro-segments and nobody used them.",
    "We had twenty-three micro-segments from a black-box tool.",
    "The last vendor sold us a black box.",
    "We paid for micro segments once and used none of them.",
  ],
  "test-accounts": [
    "Staff use test accounts in production.",
    "There are staff test rows in there.",
    "Member ids that start with T are ours.",
    "Look for ids beginning with 'T'.",
    "The T-prefixed ids are test accounts.",
    "Any member_id starting with “T” is a staff account.",
  ],
  "segment-hopping": [
    "Members hopping segments every week would wreck my measurement.",
    "If people hop between segments week to week I cannot measure anything.",
    "Members switching segments every week is my worry.",
    "I cannot have members moving between segments every week.",
  ],
  "error-costs": [
    "A wasted loaf costs about S$2.60.",
    "A lost toast sale is about S$4.80.",
    "Waste is S$2.6 a loaf, a lost sale S$4.8.",
  ],
  "weather-adjustment": [
    "Managers adjust for weather informally.",
    "Our managers adjust for the weather by feel.",
    "Rain kills the CBD lunch walk-ins.",
    "On a rainy day we bake less.",
    "When it rains the lunch crowd drops.",
    "We make a guess for the weather each morning.",
  ],
  "pos-migration": [
    "We migrated POS vendors in March 2025.",
    "Jurong double-posted eight days during the cutover.",
    "Those days were posted twice when we moved to the new POS system.",
    "We switched POS in March.",
    "The POS migration in March 2025 did that.",
  ],
  "manager-blame": [
    "Head office must not blame the manager who followed it.",
    "I don't want to be blamed if the forecast is wrong.",
    "If it goes wrong it must not be my fault.",
    "Who is responsible when food is wasted?",
    "I will not be held responsible for the model's mistakes.",
  ],
};

// Ordinary replies that state none of the withheld facts. No key may match.
const NEUTRAL = [
  "We have about 6,000 offers a month of capacity.",
  "The CFO wants a result this quarter.",
  "Prepaid is out of scope for this work.",
  "The team is training new staff on scripts this month.",
  "The drain outside the Raffles Place outlet was fixed last week.",
  "Churn rose over the last 12 months.",
  "The last 6 months of tickets are in the file.",
  "Promotions run on the marketing calendar and promo_flag records them.",
  "We ran a promotion on eggs last week, and the promo days are flagged.",
  "Our handsets are sold in store.",
  "This is responsible use of the data, and nobody is at fault for the outage.",
  "The extract starts with the subscriber key.",
  "Rows start with the date.",
  "We serve 23 stores across the island.",
  "Weather is not in the extract.",
  "Ask me about gaps or migrations if you see something odd.",
  "We had a vendor meeting on Monday.",
  "Open rates fell for six consecutive months.",
  "Membership refreshes monthly.",
  "Our contracts are 12 or 24 months long.",
];

function corpusFor(s: Scenario, factId: string): string[] {
  const owner = s.personas.find((p) => p.withheld.some((w) => w.id === factId))!;
  return [
    owner.card,
    s.brief,
    ...s.worldFactsSeed,
    ...s.datasets.flatMap((d) => [d.dictionary, d.description, d.notes ?? ""]),
    ...s.personas.flatMap((p) => p.withheld.filter((w) => w.id !== factId).flatMap((w) => [w.fact, w.statement])),
    ...owner.frictions.map((f) => f.text),
    ...s.stages.flatMap((st) => [st.guidance, st.gate.instructions]),
  ].filter(Boolean);
}

describe("normaliseForKeys", () => {
  it("writes figures as digits, joins currency, and turns hyphens between words into spaces", () => {
    expect(normaliseForKeys("Six-month save, S$ 30, SGD 30, twenty-three micro-segments, 6,000")).toBe(
      "6 month save, s$30, s$30, 23 micro segments, 6000",
    );
    expect(normaliseForKeys("10 to 20% off, 10% to 20% off, 10-20%")).toBe("10-20% off, 10-20% off, 10-20%");
    expect(normaliseForKeys("mid-month, top-up, T-prefixed")).toBe("mid month, top up, t prefixed");
  });

  it("does not turn a word that contains a number word into a digit", () => {
    expect(normaliseForKeys("often someone gets tension")).toBe("often someone gets tension");
  });
});

describe("findKey single-letter endings", () => {
  it("does not let a key that ends in one letter run on into a word", () => {
    expect(findKey("ids that start with T", ["start with T"])).toBe("start with T");
    expect(findKey("rows start with the date", ["start with T"])).toBeNull();
  });
});

describe.each(IDS)("%s withheld keys", (id) => {
  const s = scenarios[id];
  const facts = s.personas.flatMap((p) => p.withheld);

  it("has a paraphrase set for every withheld fact", () => {
    for (const w of facts) expect(PARAPHRASES[w.id], w.id).toBeDefined();
  });

  it.each(facts.map((w) => [w.id, w] as const))("%s: every paraphrase matches a key", (_fid, w) => {
    for (const line of PARAPHRASES[w.id]) expect(findKey(line, w.keys), `${w.id}: ${line}`).not.toBeNull();
    // The fact and its ledger statement state it too.
    expect(findKey(w.fact, w.keys), w.id).not.toBeNull();
    expect(findKey(w.statement, w.keys), w.id).not.toBeNull();
  });

  it.each(facts.map((w) => [w.id, w] as const))("%s: no key matches the other texts of the scenario", (_fid, w) => {
    for (const text of corpusFor(s, w.id)) {
      expect(findKey(text, w.keys), `${w.id} key ${findKey(text, w.keys)} in: ${text.slice(0, 80)}`).toBeNull();
    }
  });

  it.each(facts.map((w) => [w.id, w] as const))("%s: no key matches an ordinary reply", (_fid, w) => {
    for (const line of NEUTRAL) expect(findKey(line, w.keys), `${w.id}: ${line}`).toBeNull();
  });

  it("names no bare number or single broad word as a key", () => {
    for (const w of facts) {
      for (const k of w.keys) {
        expect(/^\d+$/.test(k.trim()), `${w.id}: ${k}`).toBe(false);
        expect(["rain", "weather", "handset", "voucher", "fault", "responsib", "promotion"]).not.toContain(k.trim().toLowerCase());
      }
    }
  });
});

describe.each(IDS)("%s friction keys", (id) => {
  const sponsor = scenarios[id].personas.find((p) => p.role === "client-sponsor")!;

  it("do not match ordinary talk about the data", () => {
    for (const f of sponsor.frictions) {
      for (const line of NEUTRAL) expect(findKey(line, f.keys), `${f.id}: ${line}`).toBeNull();
      for (const d of scenarios[id].datasets) expect(findKey(d.dictionary, f.keys), f.id).toBeNull();
    }
  });
});
