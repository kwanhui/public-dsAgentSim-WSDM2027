// Every scripted request for data must pass the data owner's release check
// (a dictionary column and a purpose; lib/agents/release-scope.ts), or the
// script stalls waiting for a file that is never released. The probes that
// are meant to be refused must still be refused.
//
// The demo recorder (demo/record/) and the baseline harness (scripts/
// baseline/) stay out of the public snapshot, so their cases run only where
// those files exist.

import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { checkReleaseScope } from "@/lib/agents/release-scope";
import { loadScenario } from "@/lib/scenarios/load";
import type { Scenario } from "@/lib/scenarios/types";
import { CAPTURE_PANEL_DATA_REQUEST } from "@/scripts/data-requests";

const RECORDER = "demo/record/record-demo.ts";
const BASELINE_TURNS = "scripts/baseline/fixtures/learner-turns.churn.json";
const BASELINE_PROBES = "scripts/baseline/fixtures/learner-turns.churn-probes.json";

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

interface TurnsFixture {
  turns: { personaId: string; stage: string; probe?: string; text: string }[];
}

beforeAll(async () => {
  scenario = await loadScenario("customer-churn");
});

describe("scripted data requests meet the release scope check", () => {
  it("capture-panel", () => {
    expect(passes([CAPTURE_PANEL_DATA_REQUEST])).toBe(true);
  });

  it.runIf(existsSync(RECORDER))("the demo recorder's scoped ask, after its broad ask is refused", () => {
    const source = readFileSync(RECORDER, "utf8");
    const broad = /const ASK_DATA_BROAD =\s*"([^"]+)"/.exec(source)?.[1];
    const scoped = /const ASK_DATA_SCOPED =\s*"([^"]+)"/.exec(source)?.[1];
    expect(broad && scoped).toBeTruthy();
    expect(passes([broad!])).toBe(false);
    expect(passes([broad!, scoped!])).toBe(true);
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

  it.runIf(existsSync(BASELINE_TURNS))("baseline recorded turns: the first data-owner turn releases", () => {
    const fixture = json<TurnsFixture>(BASELINE_TURNS);
    const first = fixture.turns.find((t) => t.personaId === "data-owner");
    expect(passes([first!.text])).toBe(true);
  });

  it.runIf(existsSync(BASELINE_PROBES))("baseline probes: release-before-scope is refused and scoped-request releases", () => {
    const fixture = json<TurnsFixture>(BASELINE_PROBES);
    const toOwner = fixture.turns.filter((t) => t.personaId === "data-owner");
    const upTo = (probe: string) => toOwner.slice(0, toOwner.findIndex((t) => t.probe === probe) + 1).map((t) => t.text);
    expect(passes(upTo("release-before-scope"))).toBe(false);
    expect(passes(upTo("release-before-scope-open-channel"))).toBe(false);
    expect(passes(upTo("scoped-request"))).toBe(true);
  });
});
