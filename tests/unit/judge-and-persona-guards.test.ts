// Guards on the judge, the learner's copy of its feedback, the personas and
// the scenarios (rubric-v8, persona-v7, consistency-v6). The quoted texts are
// taken from showcase runs (captures of H1, A1, A2 and the exhibit).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "@/lib/scenarios/load";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getLLM: () => ({ personaModel: {}, rubricModel: {} }),
  RUBRIC_TEMPERATURE: 0,
  DEFAULT_TEMPERATURE: 0.4,
  samplingParams: () => ({}),
}));

import { generateObject } from "ai";
import {
  AGENT_NOT_RUN_IMPROVE,
  GENERIC_IMPROVE_LINE,
  improveFor,
  NOT_RUN_RATIONALE_NOTE,
  notRunCap,
  notRunStatements,
  scoreSubmission,
} from "@/lib/agents/rubric";
import { learnerLineLeaks, learnerRationale, withheldMention } from "@/lib/agents/rationale-filter";
import { findKey } from "@/lib/engagement/elicitation";
import {
  countExchanges,
  renderStakeholderTranscripts,
  type ConversationRecord,
} from "@/lib/engagement/conversation-record";
import { findStyleViolations } from "@/lib/agents/persona-style";
import { blockedWithheld, guardedPersona, revealConditionMet } from "@/lib/agents/withheld-guard";
import { buildPersonaSystemPrompt, buildStyleRetrySystem } from "@/lib/agents/persona";
import { CONSISTENCY_SYSTEM_TEMPLATE, RUBRIC_SYSTEM_TEMPLATE } from "@/lib/agents/prompt-provenance";
import { reactionAuditMessage, reactionExcerpt, REACTION_EXCERPT_CHARS } from "@/lib/agents/reaction-excerpt";
import { toPublicScenario } from "@/lib/scenarios/public";

const churn = await loadScenario("customer-churn");
const seg = await loadScenario("customer-segmentation");
const fc = await loadScenario("demand-forecasting");
const mockedGenerate = vi.mocked(generateObject);
const fact = (id: string) => churn.personas.flatMap((p) => p.withheld).find((w) => w.id === id)!;

// ---------------------------------------------------------------------------
// 1. the learner's copy does not list the file defects
// ---------------------------------------------------------------------------

// A2, data collection, attempt 1 (6/15): the submitted memo's risk and check
// sections, and the judge's quality-risks and planned-checks text.
const A2_AUDIT_1 = `DATA QUALITY RISKS AND OPEN QUESTIONS
No data file has been released yet. The following risks are identified from dictionary and conversation:
- Same-month churn outcome does not align with 6-month success window Finance will apply.
- Extract is a single-month snapshot with no longitudinal history.
CHECKS TO RUN ON RECEIPT
- Profile row count, missing values and duplicates from file.
- Examine missing-data patterns in account flags (late payments, complaints, service issues) and usage fields; flag columns with >5% missingness for imputation or exclusion.
Marcus Wong's extract defines churn as port-out, cancellation, or involuntary disconnection within the observation month itself. Sarah's Finance team measures a successful save as a subscriber who stays 6 or more months after an offer is made.`;

const A2_QUALITY_RISKS_1 =
  "The consultant exchanged messages with Marcus at this stage, but the memo's risks are the label-window mismatch and the single-month snapshot rather than defects tied to what was seen in the file or disclosed; it does not name the repeated subscriber_id rows, the text-typed total_charges with blanks, or the outage-driven missing usage. The risks listed are largely generic to a single-month extract rather than specific to this file.";

const A2_QUALITY_RISKS_3 =
  "The memo names only the label-window mismatch as its 'critical' risk and lists no data-quality risks tied to the file. It does not identify the repeated subscriber_id rows, the text-typed total_charges with blanks, or the ~4% missing usage.";

describe("learner copy of a failed data audit", () => {
  it("drops the sentence that lists the file defects the memo never named", () => {
    const learner = learnerRationale(A2_QUALITY_RISKS_1, churn, A2_AUDIT_1);
    expect(learner).toBe("The risks listed are largely generic to a single-month extract rather than specific to this file.");
    for (const leaked of ["subscriber_id", "total_charges", "outage", "missing usage"]) expect(learner).not.toContain(leaked);
  });

  it("drops the attempt-3 sentence too, whichever defect it names first", () => {
    const learner = learnerRationale(A2_QUALITY_RISKS_3, churn, "Check for duplicates on subscriber ID; expect zero.");
    expect(learner).toBe("The memo names only the label-window mismatch as its 'critical' risk and lists no data-quality risks tied to the file.");
  });

  it("keeps a sentence about a defect the memo names itself", () => {
    const rationale = "The memo counts the blank total_charges rows but does not say how they are coerced.";
    expect(learnerRationale(rationale, churn, "635 rows have a blank total_charges value.")).toBe(rationale);
  });

  it("replaces an improve line that names an unraised defect with the generic line", () => {
    const planned = churn.stages[1].gate.rubric.find((c) => c.id === "planned-checks")!;
    const line = improveFor({
      criterion: planned,
      score: 2,
      judgeImprove: "Match each check to a named column the released file actually holds, and add a check for a text-typed numeric field with blank handling.",
      submissionText: A2_AUDIT_1,
      scenario: churn,
    });
    expect(line).not.toContain("text-typed");
    expect(line).toBe(GENERIC_IMPROVE_LINE);
  });

  it("covers every scenario: each file lists its defects, the undocumented one included", () => {
    for (const s of [churn, seg, fc]) {
      for (const d of s.datasets) {
        const ids = d.defects.map((x) => x.id);
        expect(ids.length, `${s.id}/${d.file}`).toBeGreaterThanOrEqual(4);
        for (const u of d.undocumentedDefects) expect(ids, `${s.id}/${u}`).toContain(u);
      }
    }
    expect(learnerLineLeaks("It misses the staff test accounts.", seg, "We drop refunds.")).toBe(true);
    expect(learnerLineLeaks("It omits the doubled Jurong days.", fc, "Closed days are absent rows.")).toBe(true);
    expect(learnerLineLeaks("The memo treats sell-out days as censored demand.", fc, "units_sold is censored on sell-out days")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. a result marked as not run is scored as a plan
// ---------------------------------------------------------------------------

// A1's model report (17/20 at rubric-v7, validation 5/5).
const A1_MODEL_REPORT = `I would use a stratified train/test split (roughly 70/30) on de-duplicated subscribers.
Not run: I have no computed AUC, precision or recall to report. What I can state is the design.
Based on the file profile distributions, I expect late_payments_12m to be a leading churn indicator. Not run: no feature importances have been computed.`;

function judged(stageIndex: number, flags: Record<string, { notRun?: boolean; unverifiedClaim?: boolean }>) {
  return {
    object: {
      scores: churn.stages[stageIndex].gate.rubric.map((c) => ({
        criterionId: c.id,
        score: c.maxScore,
        rationale: "The report covers the element.",
        improve: "",
        unverifiedClaim: flags[c.id]?.unverifiedClaim ?? false,
        notRun: flags[c.id]?.notRun ?? false,
      })),
    },
    usage: { promptTokens: 1, completionTokens: 1 },
  } as never;
}

describe("not-run results (rubric-v8)", () => {
  beforeEach(() => mockedGenerate.mockReset());

  it("finds the not-run statements and hands them to the judge", async () => {
    expect(notRunStatements(A1_MODEL_REPORT)).toEqual([
      "Not run: I have no computed AUC, precision or recall to report.",
      "Not run: no feature importances have been computed.",
    ]);
    expect(notRunStatements("The label does not fit the decision, and the model was run on 8,170 rows.")).toEqual([]);
    mockedGenerate.mockResolvedValue(judged(3, {}));
    await scoreSubmission({ scenario: churn, stage: churn.stages[3], submissionText: A1_MODEL_REPORT, ledger: [] });
    const system = (mockedGenerate.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain("- Not run: I have no computed AUC, precision or recall to report.");
    expect(system).toContain("set notRun to true on that criterion");
  });

  for (const mode of ["human", "agent"] as const) {
    it(`caps the flagged criterion at 40% in a ${mode} run and says why`, async () => {
      mockedGenerate.mockResolvedValue(judged(3, { validation: { notRun: true } }));
      const result = await scoreSubmission({
        scenario: churn,
        stage: churn.stages[3],
        submissionText: A1_MODEL_REPORT,
        ledger: [],
        mode,
      });
      const validation = result.scores.find((s) => s.criterionId === "validation")!;
      expect(validation.score).toBe(notRunCap(5));
      expect(notRunCap(5)).toBe(2);
      expect(validation.rawScore).toBe(5);
      expect(validation.notRunCap).toBe(true);
      expect(validation.rationale).toContain(NOT_RUN_RATIONALE_NOTE);
      expect(validation.learnerRationale).toContain(NOT_RUN_RATIONALE_NOTE);
      // An agent is not told to run what it cannot run.
      if (mode === "agent") expect(validation.improve).toBe(AGENT_NOT_RUN_IMPROVE);
      else expect(validation.improve).not.toBe(AGENT_NOT_RUN_IMPROVE);
      expect(result.scores.find((s) => s.criterionId === "operating-point")?.score).toBe(5);
    });
  }

  it("does not cap on the judge's flag alone when the submission marks nothing as not run", async () => {
    mockedGenerate.mockResolvedValue(judged(3, { validation: { notRun: true } }));
    const result = await scoreSubmission({
      scenario: churn,
      stage: churn.stages[3],
      submissionText: "Held-out AUC 0.78 against a 0.61 logistic baseline.",
      ledger: [],
    });
    expect(result.scores.find((s) => s.criterionId === "validation")?.score).toBe(5);
  });

  it("keeps flagging, not capping, a reported executed result in a learner run", async () => {
    mockedGenerate.mockResolvedValue(judged(3, { validation: { unverifiedClaim: true } }));
    const result = await scoreSubmission({
      scenario: churn,
      stage: churn.stages[3],
      submissionText: "Held-out AUC 0.78.",
      ledger: [],
      mode: "human",
    });
    const validation = result.scores.find((s) => s.criterionId === "validation")!;
    expect(validation.score).toBe(5);
    expect(validation.unverifiedClaim).toBe(true);
    expect(validation.notRunCap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. the reaction's auditor reads the sponsor's excerpt
// ---------------------------------------------------------------------------

describe("reaction audit excerpt (consistency-v6)", () => {
  it("gives the auditor the same 4,000 characters the sponsor read", () => {
    // The A2 validation memo named the 500-subscriber pilot about 2,940
    // characters in; the rubric-v7 auditor saw only 1,500.
    const memo = `${"x".repeat(2940)} Priya's team will pilot the list with 500 subscribers in the first week. ${"y".repeat(3000)}`;
    expect(REACTION_EXCERPT_CHARS).toBe(4000);
    expect(reactionExcerpt(memo).length).toBe(4000);
    const audit = reactionAuditMessage("validation-memo", memo);
    expect(audit).toContain("pilot the list with 500 subscribers");
    expect(audit.endsWith(reactionExcerpt(memo))).toBe(true);
    expect(audit.startsWith("(The consultant delivered the validation memo for this stage. Excerpt:)")).toBe(true);
  });

  it("tells the auditor that the consultant's message may be cited", () => {
    expect(CONSISTENCY_SYSTEM_TEMPLATE).toContain("A reply may refer to anything the consultant's message states");
    expect(CONSISTENCY_SYSTEM_TEMPLATE).toContain("the same excerpt of the document that the character read");
  });
});

// ---------------------------------------------------------------------------
// 4. the no-exchange cap is visible to learners
// ---------------------------------------------------------------------------

describe("the no-exchange cap in the learner's wording", () => {
  it("names the cap in every capped criterion's learner text and in the modelling guidance", () => {
    for (const s of [churn, seg, fc]) {
      const pub = toPublicScenario(s);
      const endUser = s.personas.find((p) => p.role === "end-user")!;
      for (const st of s.stages) {
        for (const c of st.gate.rubric.filter((x) => x.requiresExchange)) {
          const shown = pub.stages.find((x) => x.id === st.id)!.gate.rubric.find((x) => x.id === c.id)!;
          expect(shown.criterion, `${s.id}/${c.id}`).toContain("capped at two of five marks unless you have exchanged messages with");
        }
      }
      const modelling = pub.stages.find((x) => x.id === "modelling")!.guidance.replace(/\s+/g, " ");
      const shortName = endUser.name.match(/\(([^)]+)\)/)?.[1] ?? endUser.name;
      expect(modelling, s.id).toContain(`Talk to ${shortName}`);
      expect(modelling, s.id).toContain("capped at two of five marks");
    }
    // The criterion the three runs lost marks on is now a capped one.
    expect(churn.stages[3].gate.rubric.find((c) => c.id === "interpretability")?.requiresExchange).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. an unobtained withheld fact is not applicable
// ---------------------------------------------------------------------------

describe("points not yet shared in the judge's text (rubric-v9)", () => {
  it("keeps the credit rule for constraints to elicit but forbids saying a point was withheld", () => {
    // rubric-v9 reverts the rubric-v8 "not applicable" rule, so asking is rewarded.
    expect(RUBRIC_SYSTEM_TEMPLATE).not.toContain("not applicable. Do not deduct for it");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("Score a constraint to elicit by the rule above whether or not the conversation record shows its kept-back point as shared");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("No credit for it when the submission leaves it out.");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("never say or imply that a stakeholder withheld, kept back or has not shared a point");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("The statement does not establish the cost of an offer; ask the client sponsor about money.");
  });

  it("lets the topic-and-owner wording through to the learner (A1) and keeps a stated value (H1)", () => {
    // A1 never obtained the offer cost: the rubric-v9 wording names the topic and owner only.
    const a1v9 = "The statement does not establish the cost of an offer; ask the client sponsor about money.";
    expect(learnerRationale(a1v9, churn, "Capacity is 6,000 offers a month.")).toBe(a1v9);
    // H1 stated the cost itself, so a sentence naming it stays in the learner's copy.
    const h1 = "The statement gives the S$30 offer cost and the six-month save rule.";
    expect(learnerRationale(h1, churn, "Each offer costs about S$30; Finance counts a save only if the subscriber stays 6 more months.")).toBe(h1);
    // The value never reaches a learner who did not state it.
    expect(learnerRationale(h1, churn, "Capacity is 6,000 offers a month.")).toBe(
      "The submission does not yet cover everything this criterion asks for; see the criterion wording and the line on what to improve.",
    );
  });

  it("drops the A1 sentences that say a point was not shared", () => {
    const a1 =
      "The statement gives the capacity, the budget and the postpaid scope. It does not state the cost of one retention offer, which Sarah has not shared with the consultant and which is not named as a to-be-confirmed item.";
    expect(learnerRationale(a1, churn, "Capacity is 6,000 offers a month.")).toBe(
      "The statement gives the capacity, the budget and the postpaid scope.",
    );
    expect(
      withheldMention("It does not use the per-offer serving cost, which was not shared with the consultant."),
    ).toBe(true);
    expect(withheldMention("The operating point is not given.")).toBe(false);
    expect(withheldMention("The report states that the model was not run on the full base.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Persona style: stock phrasing, clipped rewrites, repeated refusals
// ---------------------------------------------------------------------------

describe("persona style (persona-v7)", () => {
  it("lets a question end with a question mark, and says so in the rules and the rewrite", () => {
    const system = buildPersonaSystemPrompt({
      scenario: churn,
      persona: churn.personas[0],
      stage: "formulation",
      worldFacts: [],
    });
    expect(system).toContain("End every sentence with a full stop, or with a question mark when it asks a question.");
    const retry = buildStyleRetrySystem("SYSTEM", "draft", "rules");
    expect(retry).toContain("(or a question mark when it asks a question)");
    expect(retry).toContain('join two short sentences that belong together with "and", "so" or "because"');
  });

  it("catches the stock phrasing", () => {
    const cases: [string, string][] = [
      ["not-contrast", "Those are your cleaning decisions to make, not mine to bless."],
      ["not-contrast", "It is a random sample, not a subset picked in advance."],
      ["not-contrast", "That's their bar for a genuine retention, not just a short-term stay."],
      ["not-contrast", "I want the reason on each row not as a score but as a phrase."],
      ["pseudo-cleft", "The sample size flag is what I want addressed first."],
      ["pseudo-cleft", "That combination is what closes this out for me."],
      ["stock-closer", "I want her view before we take this further."],
      ["stock-closer", "Once I have the report I'll take the business case upstairs."],
      ["question-full-stop", "Is that realistic to fold in before we lock the scope, or does it dilute the churn work."],
      ["question-full-stop", "Can you tell me now whether that's enough, or do we need Marcus to pull more."],
      ["hint", "How Finance defines a successful save is worth asking about too."],
      ["method-words", "The extract is not one row per subscriber, so dedupe or handle that first."],
      ["method-advice", "Read the dictionary carefully before you clean."],
      ["method-advice", "State the assumption plainly and show how the save estimate moves."],
      ["method-words", "Treat it as a sensitivity rather than a fixed mapping."],
      ["enumerated", "On (1): yes, ranking risk is the idea. On (2): postpaid only."],
    ];
    for (const [id, reply] of cases) expect(findStyleViolations(reply), reply).toContain(id);
    // Plain replies stay clean.
    for (const reply of [
      "Campaign staff can handle about 6,000 offers a month. Prepaid is out of scope.",
      "Is monthly fresh enough? It is for us.",
      "Whether or not the list is long, my team calls about 300 people a day.",
      "Our call list comes from Marcus's team every month.",
    ]) {
      expect(findStyleViolations(reply), reply).toEqual([]);
    }
  });

  it("flags a repeated refusal and a phrase repeated from an earlier reply", () => {
    const previousReplies = ["That choice is yours to make. The dictionary documents the field."];
    expect(findStyleViolations("Those are your cleaning decisions to make.", { previousReplies })).toContain("repeat-refusal");
    expect(findStyleViolations("That choice is yours to make.", {})).not.toContain("repeat-refusal");
    expect(
      findStyleViolations("That states purpose, fields, and granularity clearly.", {
        previousReplies: ["That states purpose, fields, and granularity clearly. Releasing now."],
      }),
    ).toContain("repeated-phrase");
    expect(findStyleViolations("Your call list will carry the score date.", { previousReplies })).not.toContain(
      "repeat-refusal",
    );
  });

  it("states the persona rules on method advice, hints, refusals and misquotes", () => {
    const marcus = churn.personas.find((p) => p.role === "data-owner")!;
    const system = buildPersonaSystemPrompt({ scenario: churn, persona: marcus, stage: "data-collection", worldFacts: [] });
    expect(system).toContain('no advice such as "so dedupe it"');
    expect(system).toContain("do not hint that there is more to find out");
    expect(system).toContain("say so once for that topic");
    expect(system).toContain("If the consultant quotes you wrongly");
    expect(system).toContain('not even as a caution about the file\'s grain such as "it is not guaranteed one row per subscriber"');
  });

  it("keeps the data owner from volunteering the undocumented defect (exhibit Marcus)", () => {
    const marcus = churn.personas.find((p) => p.role === "data-owner")!;
    const guarded = guardedPersona(marcus, churn);
    const exhibit =
      "That states purpose and fields clearly. One flag on granularity: the extract is not guaranteed one row per subscriber, so dedupe or handle that before you treat it as one row per subscriber.";
    const scope = "I need subscriber_id, tenure, contract fields, usage and churn, one row per subscriber, to rank retention targets.";
    // The fact's own keys (the plan-change cause) miss it; the defect keys catch it.
    expect(blockedWithheld(marcus, exhibit, { obtained: [], learnerMessage: scope })).toEqual([]);
    expect(blockedWithheld(guarded, exhibit, { obtained: [], learnerMessage: scope }).map((w) => w.id)).toEqual([
      "duplicate-rows",
    ]);
    // A question about repeated ids meets the condition, so the answer stands.
    expect(
      blockedWithheld(guarded, exhibit, { obtained: [], learnerMessage: "Why do some subscriber_ids repeat?" }),
    ).toEqual([]);
    // Other personas are unchanged.
    expect(guardedPersona(churn.personas[0], churn)).toBe(churn.personas[0]);
  });
});

// ---------------------------------------------------------------------------
// 7. Ask cues need a real question
// ---------------------------------------------------------------------------

describe("ask cues", () => {
  it("are met by the H1 and A2 questions that obtained each fact", () => {
    const met: [string, string][] = [
      // H1, message 2.
      ["offer-cost", "What does a successful save look like from Finance's point of view — is there a definition they hold you to? And how much does it cost to make one retention offer?"],
      ["save-definition", "What does a successful save look like from Finance's point of view — is there a definition they hold you to? And how much does it cost to make one retention offer?"],
      // A2, message 2.
      ["save-definition", "When Finance evaluates whether a save was successful, do they count it as a successful save only if the subscriber never churns within a defined period (e.g., 12 months), or is there a different definition of what counts as a \"saved\" customer?"],
      // A2, message 4.
      ["offer-cost", "When you rank subscribers by churn risk and target the top 6,000 monthly, are you looking to maximize the number of saves, or are you optimizing for something else like campaign ROI or expected customer lifetime value impact?"],
      // H1, message 14.
      ["offer-levers", "On reasons: how would your call script differ between a NETWORK flag and a CONTRACT-END flag? And what offers can you actually put on the table for each - so I don't promise anything you can't deliver?"],
      // H1, message 9 (to Marcus).
      ["duplicate-rows", "The profile shows 170 subscriber_ids that appear twice. Is there one row per subscriber, or do plan changes create a second row?"],
    ];
    for (const [id, message] of met) expect(revealConditionMet(fact(id), message), `${id}: ${message}`).toBe(true);
  });

  it("are not met by single generic words", () => {
    const unmet: [string, string][] = [
      ["offer-cost", "How many offers can the retention team realistically make each month, and what budget do you have for the quarter?"],
      ["offer-cost", "What are your hard constraints: budget, campaign capacity, or offer rules?"],
      ["offer-cost", "Is the spend worth it to the CFO?"],
      ["save-definition", "Who is the target for the offers?"],
      ["save-definition", "Can you define the scope for me?"],
      ["offer-levers", "Once you have a prioritized list, how does your team execute offers?"],
      ["offer-levers", "Are the reasons clear enough to use in a retention call, or do they need plainer language?"],
    ];
    for (const [id, message] of unmet) expect(revealConditionMet(fact(id), message), `${id}: ${message}`).toBe(false);
  });

  it("drop the generic single words from every scenario", () => {
    const generic = ["offer", "target", "budget", "cost", "money", "worth", "spend", "success", "define", "before", "past", "date", "risk", "trust", "event", "adjust", "measure"];
    for (const s of [churn, seg, fc]) {
      for (const w of s.personas.flatMap((p) => p.withheld)) {
        for (const g of generic) expect(w.askCues, `${s.id}/${w.id}`).not.toContain(g);
      }
    }
    expect(findKey("What budget do you have?", fact("offer-cost").askCues)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. statements attributed to a stakeholder are checked
// ---------------------------------------------------------------------------

const A2_VALIDATION_MEMO = `WHAT WAS SHOWN TO PRIYA
A 15-row sample of churn risk output containing: subscriber_id, risk_score (0-100 scale), and top 4 factors.
3. No change to refresh cadence: Monthly refresh from the warehouse remains the standard. Priya confirmed this cadence is workable for her monthly planning cycle.`;

function testingRecord(): ConversationRecord {
  return {
    stage: "testing",
    personas: countExchanges(churn, [{ type: "persona_turn", detailJson: { personaId: "end-user", stage: "testing" } }], "testing"),
    traceRecorded: true,
    obtainedFactIds: [],
    transcripts: [
      {
        personaId: "end-user",
        name: "Priya Nair",
        messages: [
          { fromConsultant: true, text: "Hi Priya, I've prepared a 15-row sample of the churn risk output. Can you review this sample?" },
          {
            fromConsultant: false,
            text: "Sure, send the sample whenever you're ready. Let me know how fresh those scores would be day to day since the extract only refreshes monthly.",
          },
        ],
      },
      { personaId: "client", name: "Sarah Tan", messages: [] },
    ],
  };
}

describe("stakeholder attributions (rubric-v8)", () => {
  beforeEach(() => mockedGenerate.mockReset());

  it("renders each channel's transcript for the judge, shortening long messages", () => {
    const record = testingRecord();
    record.transcripts![1].messages.push({ fromConsultant: true, text: "word ".repeat(400) });
    const text = renderStakeholderTranscripts(record);
    expect(text).toContain("- Channel with Priya Nair:");
    expect(text).toContain("  Priya Nair: Sure, send the sample whenever you're ready.");
    expect(text).toContain("  Consultant: Hi Priya, I've prepared a 15-row sample");
    expect(text).toMatch(/Consultant: (?:word ){50,}.*\[\.\.\.\]/);
    expect(renderStakeholderTranscripts({ ...record, transcripts: undefined })).toBe("(not available)");
  });

  it("sends the transcripts and the attribution rule with the A2 memo", async () => {
    mockedGenerate.mockResolvedValue(judged(4, {}));
    await scoreSubmission({
      scenario: churn,
      stage: churn.stages[4],
      submissionText: A2_VALIDATION_MEMO,
      ledger: [],
      conversation: testingRecord(),
    });
    const system = (mockedGenerate.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain("Stakeholder transcripts:");
    expect(system).toContain("Let me know how fresh those scores would be day to day");
    expect(system).toContain("Check every statement that the submission attributes to a stakeholder");
    expect(system).toContain("An attribution that the transcript does not support is an error");
    expect(system).not.toMatch(/«[^»]+»/);
  });
});
