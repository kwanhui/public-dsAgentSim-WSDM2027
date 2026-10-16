import { describe, expect, it } from "vitest";
import { STAGE_IDS, nextStage, stageIndex, stageReached } from "@/lib/scenarios/types";
import {
  decideGate,
  gateExpectationCopy,
  gateOutcomeCopy,
  gateShortfallCopy,
  noReactionCopy,
} from "@/lib/engagement/gate-policy";
import { applyRubricVisibility, closedStages } from "@/lib/engagement/rubric-visibility";
import { DEFAULT_COHORT_CONFIG } from "@/lib/cohort/defaults";
import { loadScenario } from "@/lib/scenarios/load";
import { toPublicScenario } from "@/lib/scenarios/public";

describe("stage pipeline helpers", () => {
  it("orders the six stages as the pipeline", () => {
    expect(STAGE_IDS).toEqual([
      "formulation",
      "data-collection",
      "cleaning",
      "modelling",
      "testing",
      "deployment",
    ]);
  });

  it("stageIndex follows declaration order", () => {
    expect(stageIndex("formulation")).toBe(0);
    expect(stageIndex("deployment")).toBe(5);
  });

  it("stageReached is true for the current and earlier stages only", () => {
    expect(stageReached("cleaning", "formulation")).toBe(true);
    expect(stageReached("cleaning", "cleaning")).toBe(true);
    expect(stageReached("cleaning", "modelling")).toBe(false);
  });

  it("nextStage walks the pipeline and ends at deployment", () => {
    expect(nextStage("formulation")).toBe("data-collection");
    expect(nextStage("testing")).toBe("deployment");
    expect(nextStage("deployment")).toBeNull();
  });
});

describe("gate policy", () => {
  const attempt = 1;
  const maxRetries = 2;

  it("ships a threshold by default, so a cohort gates unless told otherwise", () => {
    expect(DEFAULT_COHORT_CONFIG.gates.minScoreRatio).toBe(0.6);
  });

  it("holds a submission below the threshold at the same stage", () => {
    const decision = decideGate({ scoreRatio: 0, minScoreRatio: 0.6, attempt, maxRetries });
    expect(decision).toEqual({ passed: false, advanced: false, reason: "below-threshold" });
  });

  it("passes a submission at or above the threshold", () => {
    expect(decideGate({ scoreRatio: 0.6, minScoreRatio: 0.6, attempt, maxRetries }).passed).toBe(true);
    expect(decideGate({ scoreRatio: 0.95, minScoreRatio: 0.6, attempt, maxRetries }).advanced).toBe(true);
  });

  it("opens the gate once the retries run out, without calling it a pass", () => {
    const decision = decideGate({ scoreRatio: 0.1, minScoreRatio: 0.6, attempt: 3, maxRetries: 2 });
    expect(decision).toEqual({ passed: false, advanced: true, reason: "retries-exhausted" });
  });

  it("reports no pass or failure under a formative (null) policy", () => {
    const decision = decideGate({ scoreRatio: 0, minScoreRatio: null, attempt, maxRetries });
    expect(decision).toEqual({ passed: null, advanced: true, reason: "formative" });
  });
});

describe("gate outcome copy", () => {
  const base = { attempt: 1, nextStageTitle: "Testing & user validation", engagementCompleted: false };

  it("claims a pass only when a threshold was cleared", () => {
    const copy = gateOutcomeCopy({ ...base, reason: "passed" });
    expect(copy.headline).toContain("Gate passed");
    expect(copy.tone).toBe("pass");
  });

  it("says submitted, not passed, under a formative policy", () => {
    const copy = gateOutcomeCopy({ ...base, reason: "formative" });
    expect(copy.headline).toBe("Submitted. Moving on to Testing & user validation.");
    expect(copy.headline).not.toContain("passed");
    expect(copy.tone).not.toBe("pass");
  });

  it("does not dress up a stage that opened because the retries ran out", () => {
    const copy = gateOutcomeCopy({ ...base, reason: "retries-exhausted" });
    expect(copy.headline).not.toContain("passed");
    expect(copy.tone).not.toBe("pass");
  });

  it("names the attempt when the learner has to resubmit", () => {
    const copy = gateOutcomeCopy({ ...base, attempt: 2, reason: "below-threshold" });
    expect(copy.headline).toContain("attempt 2");
    expect(copy.tone).toBe("shortfall");
  });
});

// The aside shown when the sponsor's reaction never arrived. It must agree
// with the verdict above it: the fail-flavoured reassurance ("score and stage
// are unaffected") used to appear under a pass headline too.
describe("no-reaction copy", () => {
  it("tells a passing learner their pass stands, without fail-flavoured reassurance", () => {
    const copy = noReactionCopy({ reason: "passed", engagementCompleted: false });
    expect(copy).toBe("The client sponsor did not reply this time; your pass stands.");
    expect(copy).not.toContain("unaffected");
  });

  it("keeps the score-and-stage reassurance for a submission that fell short", () => {
    expect(noReactionCopy({ reason: "below-threshold", engagementCompleted: false })).toBe(
      "The client sponsor has not replied to this one; your score and stage are unaffected.",
    );
  });

  it("does not call a formative or retries-exhausted advance a pass", () => {
    for (const reason of ["formative", "retries-exhausted"] as const) {
      const copy = noReactionCopy({ reason, engagementCompleted: false });
      expect(copy).not.toContain("pass");
      expect(copy).not.toContain("unaffected");
    }
  });

  it("speaks of the handover when the engagement just completed", () => {
    expect(noReactionCopy({ reason: "passed", engagementCompleted: true })).toContain("handover");
  });
});

describe("gate expectation copy", () => {
  it("states the bar and the attempt budget the cohort actually runs", () => {
    const lines = gateExpectationCopy({ minScoreRatio: 0.6, maxRetries: 2, attemptsUsed: 0 });
    expect(lines[0]).toBe(
      "You need 60% to pass. You have 3 attempts; after that the engagement moves on.",
    );
    expect(lines[1]).toBe("Every scored attempt is kept and shown to your instructor.");
    expect(lines).toHaveLength(2);
  });

  it("counts the attempt the learner is about to make", () => {
    const lines = gateExpectationCopy({ minScoreRatio: 0.6, maxRetries: 2, attemptsUsed: 1 });
    expect(lines[2]).toBe("This is attempt 2 of 3.");
  });

  it("says scoring is formative rather than quoting a bar that does not exist", () => {
    const lines = gateExpectationCopy({ minScoreRatio: null, maxRetries: 2, attemptsUsed: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("formative");
    expect(lines[0]).not.toContain("%");
    expect(lines[0]).not.toContain("attempt");
  });
});

describe("gate shortfall copy", () => {
  it("names the score and the bar it fell short of", () => {
    expect(gateShortfallCopy({ scoreRatio: 0.1, minScoreRatio: 0.6 })).toBe(
      "Scored 10%; the pass mark is 60%.",
    );
  });

  it("has nothing to say when the cohort has no bar", () => {
    expect(gateShortfallCopy({ scoreRatio: 0.1, minScoreRatio: null })).toBeNull();
  });
});

const scenario = toPublicScenario(await loadScenario("customer-churn"));

const fullScenario = await loadScenario("customer-churn");

describe("rubric visibility", () => {
  it("shows the learner wording of every criterion at every stage", () => {
    const learnerView = applyRubricVisibility(scenario, []);
    for (const stage of learnerView.stages) {
      const full = fullScenario.stages.find((s) => s.id === stage.id)!;
      for (const c of stage.gate.rubric) {
        const source = full.gate.rubric.find((r) => r.id === c.id)!;
        expect(c.criterion).toBe(source.learnerText);
        expect(c.criterion).not.toBe(source.criterion);
        expect(c.id).toBeTruthy();
        expect(c.maxScore).toBeGreaterThan(0);
      }
    }
  });

  it("never sends the full criterion text, before or after a stage closes", () => {
    const stageIds = scenario.stages.map((s) => s.id);
    for (const closed of [[], stageIds]) {
      const payload = JSON.stringify(applyRubricVisibility(scenario, closed));
      for (const st of fullScenario.stages) {
        for (const c of st.gate.rubric) expect(payload).not.toContain(c.criterion);
      }
    }
  });

  it("keeps the specifics the learner should elicit out of the payload", () => {
    const payload = JSON.stringify(applyRubricVisibility(scenario, []));
    expect(payload).not.toContain("6,000/month");
    expect(payload).not.toContain("duplicate rows from mid-month plan changes");
  });

  it("gives the same wording whichever stages are closed", () => {
    expect(applyRubricVisibility(scenario, ["formulation"])).toEqual(applyRubricVisibility(scenario, []));
  });
});

describe("closed stages", () => {
  const stageIds = scenario.stages.map((s) => s.id);

  it("keeps the current stage closed after a failed attempt with retries left", () => {
    // A failed non-final attempt leaves the engagement on the same stage, so
    // its criterion text stays withheld.
    expect(closedStages({ stageIds, currentStage: stageIds[0], completed: false })).toEqual([]);
    expect(closedStages({ stageIds, currentStage: stageIds[2], completed: false })).toEqual(
      stageIds.slice(0, 2),
    );
  });

  it("opens every stage once the engagement is complete", () => {
    expect(closedStages({ stageIds, currentStage: stageIds.at(-1)!, completed: true })).toEqual(
      stageIds,
    );
  });

  it("leaves the learner wording in place for passed and current stages alike", () => {
    const view = applyRubricVisibility(
      scenario,
      closedStages({ stageIds, currentStage: stageIds[1], completed: false }),
    );
    expect(view.stages[0].gate.rubric.every((c) => typeof c.criterion === "string")).toBe(true);
    expect(view.stages[1].gate.rubric.every((c) => typeof c.criterion === "string")).toBe(true);
  });
});
