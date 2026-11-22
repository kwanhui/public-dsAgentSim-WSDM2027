// Copy checks for the plain-course-tool look:
// no em dashes in the source of app/, components/ and lib/, and none in the
// scenario text a learner can see. The persona and analyst prompts, the
// persona cards and the kept-back facts are held to the same rule, because
// personas echoed the em dashes in their cards back into chat.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listScenarios, loadScenario } from "@/lib/scenarios/load";

const EM_DASH = "—";
// Every prompt builder is held to the rule; the set stays so a
// future exemption has one obvious place to go.
const PROMPT_FILES = new Set<string>();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("copy style", () => {
  it("has no em dash in app, components or lib source outside the prompt builders", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap(sourceFiles)
      .filter((p) => !PROMPT_FILES.has(p))
      .filter((p) => readFileSync(p, "utf8").includes(EM_DASH));
    expect(offenders).toEqual([]);
  });

  it("has no em dash in learner-visible scenario text", async () => {
    for (const { id } of await listScenarios()) {
      const s = await loadScenario(id);
      const visible = [
        s.title,
        s.brief,
        ...s.personas.flatMap((p) => [p.name, p.title, p.channelName]),
        ...s.stages.flatMap((st) => [
          st.title,
          st.guidance,
          st.gate.instructions,
          ...st.gate.rubric.map((c) => c.criterion),
        ]),
        ...s.datasets.flatMap((d) => [d.description, d.dictionary]),
      ];
      const hits = visible.filter((t) => t.includes(EM_DASH));
      expect(hits, id).toEqual([]);
    }
  });

  it("has no em dash in persona cards or kept-back facts", async () => {
    for (const { id } of await listScenarios()) {
      const s = await loadScenario(id);
      const text = s.personas.flatMap((p) => [p.card, ...p.withheld.flatMap((w) => [w.fact, w.revealWhen])]);
      expect(text.filter((t) => t.includes(EM_DASH)), id).toEqual([]);
    }
  });

  it("uses one role name per stakeholder in channel names", async () => {
    const labels: Record<string, string> = {
      "client-sponsor": "(Client sponsor)",
      "data-owner": "(Data owner)",
      "end-user": "(End user)",
    };
    for (const { id } of await listScenarios()) {
      const s = await loadScenario(id);
      for (const p of s.personas) {
        expect(p.channelName.endsWith(` ${labels[p.role]}`), `${id}/${p.id}: ${p.channelName}`).toBe(true);
      }
    }
  });
});
