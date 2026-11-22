// The engagement's in-world clock. Personas had no way to place the data in
// time: without a stated "today", the data owner treated her own extract's
// end date as a suspicious cutoff, a doubt no stakeholder could resolve
// in-world. One seeded fact fixes the current date shortly after the newest
// date in the scenario's data, so the coverage window is something she can
// vouch for. Derived deterministically from the committed dataset files, and
// seeded into the ledger when the engagement is created.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { profileCsv, type DatasetProfile } from "@/lib/agents/dataset-profile";
import type { Scenario } from "@/lib/scenarios/types";

// How far the in-world "today" sits after the newest date in the data: close
// enough that the extract reads as fresh, far enough that "pulled shortly
// before today" is a natural answer.
export const WORLD_DATE_OFFSET_DAYS = 14;

export function worldDateFromCoverage(maxDate: string): string {
  const d = new Date(`${maxDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + WORLD_DATE_OFFSET_DAYS);
  return d.toISOString().slice(0, 10);
}

// The seed fact, or none when no dataset carries a date column (a
// cross-sectional extract needs no clock to be internally consistent).
export function worldClockFacts(profiles: DatasetProfile[]): string[] {
  const ranges = profiles.flatMap((p) => {
    const col = p.columns.find((c) => c.dateMin !== undefined && c.dateMax !== undefined);
    return col ? [{ file: p.file, min: col.dateMin as string, max: col.dateMax as string }] : [];
  });
  if (ranges.length === 0) return [];
  const latest = ranges
    .map((r) => r.max)
    .sort()
    .at(-1) as string;
  const coverage = ranges.map((r) => `${r.file} covers ${r.min} to ${r.max}`).join("; ");
  return [
    `Today's date in this engagement is ${worldDateFromCoverage(latest)}. The data extract ${coverage}; it was pulled shortly before today, so the end date is the extract cutoff, not a sign of missing data.`,
  ];
}

// Profiles the scenario's dataset files straight from disk. This runs at
// engagement creation, before any release, so it cannot go through the
// release-gated read path; the file list comes from the validated scenario
// config, never from user input. Unreadable files are skipped so a missing
// dataset degrades to no clock fact rather than a failed engagement start.
export async function scenarioWorldClockFacts(scenario: Scenario): Promise<string[]> {
  const profiles: DatasetProfile[] = [];
  for (const d of scenario.datasets) {
    try {
      const raw = await readFile(resolve(process.cwd(), "datasets", scenario.id, d.file), "utf8");
      profiles.push(profileCsv(d.file, raw));
    } catch {
      // Skipped: the scenario tests assert the committed files exist.
    }
  }
  return worldClockFacts(profiles);
}
