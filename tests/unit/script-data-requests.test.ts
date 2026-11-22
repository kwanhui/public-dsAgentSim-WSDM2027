// Every scripted request for data must pass the data owner's release check
// (a dictionary column and a purpose; lib/agents/release-scope.ts), or the
// script stalls waiting for a file that is never released. The probes that
// are meant to be refused must still be refused.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { checkReleaseScope } from "@/lib/agents/release-scope";
import { loadScenario } from "@/lib/scenarios/load";
import type { Scenario } from "@/lib/scenarios/types";
import { SCRIPTED_DATA_REQUEST } from "@/scripts/data-requests";

let scenario: Scenario;

function passes(messages: string[]): boolean {
  const dataset = scenario.datasets[0];
  return checkReleaseScope({ scenario, dataset, learnerMessages: messages }).ok;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface ReplayFixture {
  timeline: { kind: string; personaId?: string; text?: string }[];
  dataRequest?: { personaId: string; text: string };
}

beforeAll(async () => {
  scenario = await loadScenario("customer-churn");
});

describe("scripted data requests meet the release scope check", () => {
  it("the shared scripted request", () => {
    expect(passes([SCRIPTED_DATA_REQUEST])).toBe(true);
  });

  it("the e2e walkthrough", () => {
    const source = readFileSync("tests/e2e/engagement-walkthrough.spec.ts", "utf8");
    const ask = /"(Hi Marcus\.[^"]+)"/.exec(source)?.[1];
    expect(ask).toBeTruthy();
    expect(passes([ask!])).toBe(true);
  });

  for (const name of ["human-reference", "fail-then-revise"]) {
    it(`replay fixture ${name}: the stated data request passes on its own`, () => {
      const fixture = json<ReplayFixture>(`scripts/replay/fixtures/${name}.json`);
      expect(fixture.dataRequest?.personaId).toBe("data-owner");
      expect(passes([fixture.dataRequest!.text])).toBe(true);
    });
  }

  it("replay fixture human-reference: the recorded first message already releases", () => {
    const fixture = json<ReplayFixture>("scripts/replay/fixtures/human-reference.json");
    const first = fixture.timeline.find((s) => s.kind === "message" && s.personaId === "data-owner");
    expect(passes([first!.text!])).toBe(true);
  });
});
