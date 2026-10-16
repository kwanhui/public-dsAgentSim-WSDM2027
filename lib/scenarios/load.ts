// Loads scenario configs from configs/scenarios/*.yaml.
// Server-only; uses node:fs.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { ScenarioSchema, type Scenario } from "./types";

const SCENARIOS_DIR = "configs/scenarios";

const cache = new Map<string, Scenario>();

export async function loadScenario(id: string): Promise<Scenario> {
  const hit = cache.get(id);
  if (hit) return hit;
  // Scenario ids come from cohort config / DB rows, not raw user input, but
  // constrain to a safe slug anyway since the id lands in a file path.
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid scenario id: ${id}`);
  const raw = await readFile(resolve(process.cwd(), SCENARIOS_DIR, `${id}.yaml`), "utf8");
  const scenario = ScenarioSchema.parse(yaml.load(raw));
  if (scenario.id !== id) {
    throw new Error(`Scenario file ${id}.yaml declares mismatched id ${scenario.id}`);
  }
  cache.set(id, scenario);
  return scenario;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  sector: string;
  task: string;
  estimatedEffort?: string;
  brief: string;
}

export async function listScenarios(): Promise<ScenarioSummary[]> {
  const dir = resolve(process.cwd(), SCENARIOS_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: ScenarioSummary[] = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const s = await loadScenario(f.replace(/\.yaml$/, ""));
      out.push({ id: s.id, title: s.title, sector: s.sector, task: s.task, estimatedEffort: s.estimatedEffort, brief: s.brief });
    } catch {
      // Skip malformed configs rather than breaking the picker.
    }
  }
  return out;
}
