import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";
import { phaseLabel, STAGE_PHASES, stageLead } from "@/lib/scenarios/phases";
import { STAGE_IDS, STAGE_TITLES } from "@/lib/scenarios/types";

describe("stage phases", () => {
  it("gives every stage a phase", () => {
    expect(Object.keys(STAGE_PHASES).sort()).toEqual([...STAGE_IDS].sort());
    expect(STAGE_IDS.map((id) => STAGE_PHASES[id].phase)).toEqual([
      "Understand",
      "Collect",
      "Prepare",
      "Model",
      "Validate",
      "Deliver",
    ]);
  });

  it("keeps each blurb to eight words or fewer", () => {
    for (const id of STAGE_IDS) {
      expect(STAGE_PHASES[id].blurb.trim().split(/\s+/).length, id).toBeLessThanOrEqual(8);
    }
  });

  it("keeps each lead to 22 words or fewer, naming roles rather than personas", () => {
    for (const id of STAGE_IDS) {
      const lead = STAGE_PHASES[id].lead;
      expect(lead.trim().split(/\s+/).length, id).toBeLessThanOrEqual(22);
      expect(lead, id).not.toMatch(/Sarah|Marcus|Priya|David|Farah|Grace|Adrian|Siti|Beng/);
    }
  });

  it("does not use a tick icon for a stage, since a done stage shows one", () => {
    for (const id of STAGE_IDS) {
      expect(["Check", "CheckCircle", "CheckCircle2", "CircleCheck"], id).not.toContain(STAGE_PHASES[id].icon);
    }
  });

  it("falls back to the guidance for an unknown stage id", () => {
    expect(stageLead("data-collection", "x")).toBe(STAGE_PHASES["data-collection"].lead);
    expect(stageLead("unknown", "Given guidance.")).toBe("Given guidance.");
  });

  it("names icons that lucide-react exports", () => {
    for (const id of STAGE_IDS) {
      expect((lucide as Record<string, unknown>)[STAGE_PHASES[id].icon], id).toBeDefined();
    }
  });

  it("labels a stage with its phase and title", () => {
    expect(phaseLabel("formulation", STAGE_TITLES.formulation)).toBe("Understand · Problem formulation");
    expect(phaseLabel("unknown", "Other")).toBe("Other");
  });
});
