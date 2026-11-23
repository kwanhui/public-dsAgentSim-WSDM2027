// The compare view states the two differences between an analyst-agent run
// and a learner's run that hold whatever the settings: what the agent sees,
// and the scoring cap that applies to agent runs only.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {} }));

const { MODE_NOTE } = await import("@/app/admin/compare/summary");
const { UNVERIFIED_CLAIM_CAP_RATIO } = await import("@/lib/agents/prompt-provenance");

describe("compare view mode note", () => {
  it("says the agent sees file profiles and does no computation", () => {
    expect(MODE_NOTE).toMatch(/profiles of the released files/);
    expect(MODE_NOTE).toMatch(/does no computation/);
  });

  it("states the unverified-result cap as the platform applies it, to agent runs only", () => {
    expect(UNVERIFIED_CLAIM_CAP_RATIO * 5).toBe(2);
    expect(MODE_NOTE).toMatch(/\(2 of 5 points\) applies only to agent runs/);
  });
});
