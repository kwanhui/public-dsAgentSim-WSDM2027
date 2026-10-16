// Validates every shipped scenario config against the schema and the
// invariants the agent layer relies on. Catching a malformed YAML here is
// much cheaper than catching it mid-engagement.

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listScenarios, loadScenario } from "@/lib/scenarios/load";
import { STAGE_IDS, stageIndex } from "@/lib/scenarios/types";
import { toPublicScenario } from "@/lib/scenarios/public";

const scenarioIds = (await readdir(resolve(process.cwd(), "configs/scenarios")))
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""));

describe("scenario configs", () => {
  it("ships the three scenarios", () => {
    expect(scenarioIds.sort()).toEqual([
      "customer-churn",
      "customer-segmentation",
      "demand-forecasting",
    ]);
  });

  it("lists all scenarios (none skipped as malformed)", async () => {
    const listed = await listScenarios();
    expect(listed.map((s) => s.id).sort()).toEqual(scenarioIds.sort());
  });

  for (const id of scenarioIds) {
    describe(id, () => {
      it("parses and matches its filename", async () => {
        const s = await loadScenario(id);
        expect(s.id).toBe(id);
      });

      it("covers all six stages in pipeline order", async () => {
        const s = await loadScenario(id);
        expect(s.stages.map((st) => st.id)).toEqual([...STAGE_IDS]);
      });

      it("has exactly one client sponsor and one data owner, plus end-users", async () => {
        const s = await loadScenario(id);
        expect(s.personas.filter((p) => p.role === "client-sponsor")).toHaveLength(1);
        expect(s.personas.filter((p) => p.role === "data-owner")).toHaveLength(1);
        expect(s.personas.filter((p) => p.role === "end-user").length).toBeGreaterThanOrEqual(1);
      });

      it("unlocks the client at the first stage so the engagement can start", async () => {
        const s = await loadScenario(id);
        const client = s.personas.find((p) => p.role === "client-sponsor")!;
        expect(client.unlockedAtStage).toBe(STAGE_IDS[0]);
      });

      it("never releases a dataset before its owner's channel unlocks", async () => {
        const s = await loadScenario(id);
        const owner = s.personas.find((p) => p.role === "data-owner")!;
        for (const d of s.datasets) {
          expect(stageIndex(d.releasedAtStage)).toBeGreaterThanOrEqual(
            stageIndex(owner.unlockedAtStage),
          );
        }
      });

      it("has every referenced dataset file committed under datasets/", async () => {
        const s = await loadScenario(id);
        for (const d of s.datasets) {
          const st = await stat(resolve(process.cwd(), "datasets", s.id, d.file));
          expect(st.size).toBeGreaterThan(1000);
        }
      });

      it("keeps persona cards and dictionaries out of the learner projection", async () => {
        const s = await loadScenario(id);
        const pub = JSON.stringify(toPublicScenario(s));
        for (const p of s.personas) {
          // Sample a distinctive line from each card; it must not leak.
          const line = p.card.trim().split("\n").at(-1)!.trim();
          if (line.length > 20) expect(pub).not.toContain(JSON.stringify(line).slice(1, -1));
        }
        for (const d of s.datasets) {
          expect(pub).not.toContain(d.dictionary.trim().slice(0, 40));
          if (d.notes) expect(pub).not.toContain(d.notes.trim().slice(0, 40));
        }
      });
    });
  }
});
