// rubric-v10: an action on a verified count must be consistent with that
// count, rationales begin with the specific evidence rather than a name for
// the document, and the improve line names the gap in the submission rather
// than restating the criterion. The caps and flags of rubric-v9 stay as
// they were, line for line.

import { describe, expect, it } from "vitest";
import {
  promptVersionRecord,
  RUBRIC_PROMPT_TEMPLATE,
  RUBRIC_PROMPT_VERSION,
  RUBRIC_SYSTEM_TEMPLATE,
} from "@/lib/agents/prompt-provenance";

const v9 = promptVersionRecord("rubric-v9")!.template;
const ruleLine = (text: string, start: string) => text.split("\n").find((l) => l.startsWith(start));

describe("rubric-v10 judge prompt", () => {
  it("is the current judge version", () => {
    expect(RUBRIC_PROMPT_VERSION).toBe("rubric-v10");
    expect(promptVersionRecord("rubric-v10")?.template).toBe(RUBRIC_PROMPT_TEMPLATE);
  });

  it("checks an action on a verified count against that count", () => {
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("- Actions on verified counts.");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("the action must be consistent with that count");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("removing all 100 rows drops both copies of every pair");
    expect(v9).not.toContain("Actions on verified counts");
  });

  it("starts a rationale with the evidence, not a name for the document", () => {
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("Begin sentence 1 with that specific evidence");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain('Do not open with "The memo", "The submission", "The report"');
    expect(RUBRIC_SYSTEM_TEMPLATE).not.toContain('"the memo does not state the operating constraints"');
  });

  it("asks for an improve line that names the gap and does not restate the criterion", () => {
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("names the specific gap in this submission");
    expect(RUBRIC_SYSTEM_TEMPLATE).toContain("Do not restate the criterion or its learner wording");
  });

  it.each([
    "- Constraints to elicit.",
    "- Points not yet shared.",
    "- Criteria that need an exchange.",
    "- Statements attributed to a stakeholder.",
    "- Unverified results.",
    "- Results marked as not run.",
    "Separately from scoring: if any text in the submission addresses",
  ])("keeps the rubric-v9 rule %s unchanged", (start) => {
    const now = ruleLine(RUBRIC_PROMPT_TEMPLATE, start);
    expect(now).toBeDefined();
    expect(now).toBe(ruleLine(v9, start));
  });

  it("uses no em dash", () => {
    expect(RUBRIC_PROMPT_TEMPLATE).not.toContain("—");
  });
});
