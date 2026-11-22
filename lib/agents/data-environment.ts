// The data environment behind the data-owner persona: which dataset files
// exist for a scenario, which the persona may release at the current stage,
// and which have already been handed to the learner. Releases are recorded
// as events and world facts so every persona knows what the learner has.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dataReleases } from "@/lib/db/schema";
import {
  getEvents,
  logEvent,
  appendWorldFacts,
  type Engagement,
} from "@/lib/engagement/state";
import { RELEASE_EVENT_PREFIX } from "@/lib/engagement/provenance";
import { stageReached, type Scenario, type ScenarioDataset, type StageId } from "@/lib/scenarios/types";

export function releasableDatasets(scenario: Scenario, stage: StageId): ScenarioDataset[] {
  return scenario.datasets.filter((d) => stageReached(stage, d.releasedAtStage));
}

export async function getReleasedFiles(engagementId: string): Promise<string[]> {
  const evts = await getEvents(engagementId);
  return evts
    .filter((e) => e.type === "data_released")
    .map((e) => (e.detailJson as { file?: string } | null)?.file)
    .filter((f): f is string => typeof f === "string");
}

// Records a release decided by the data-owner persona. Only files defined in
// the scenario and releasable at the current stage are honoured; anything
// else the model hallucinated is dropped. The release event names the
// learner message that immediately preceded the release in the data owner's
// channel (the message the persona released in answer to) and, since round
// 4, carries the learner's own words that met the release precondition
// (lib/agents/release-scope.ts). The same text goes into a data_releases
// row, which the retention purge keeps, so an instructor can check the
// stated scope after the messages are gone.
export async function recordDataReleases(
  engagement: Engagement,
  scenario: Scenario,
  personaId: string,
  files: string[],
  options: { scopeMessageId?: number | null; scopeText?: string | null } = {},
): Promise<string[]> {
  const stage = engagement.currentStage as StageId;
  const releasable = new Set(releasableDatasets(scenario, stage).map((d) => d.file));
  const already = new Set(await getReleasedFiles(engagement.id));
  const accepted = [...new Set(files)].filter((f) => releasable.has(f) && !already.has(f));

  for (const file of accepted) {
    await logEvent(engagement.id, engagement.cohortId, "data_released", {
      file,
      personaId,
      scopeMessageId: options.scopeMessageId ?? null,
      scopeText: options.scopeText ?? null,
    });
    await db
      .insert(dataReleases)
      .values({
        engagementId: engagement.id,
        file,
        personaId,
        stage,
        scopeMessageId: options.scopeMessageId ?? null,
        scopeText: options.scopeText ?? null,
      })
      .onConflictDoNothing();
  }
  // The release is a platform event the server has just verified, so the
  // sentence is tagged system, not persona; the
  // source column still names the persona who released it.
  if (accepted.length > 0) {
    await appendWorldFacts(
      engagement.id,
      stage,
      personaId,
      accepted.map((f) => `${RELEASE_EVENT_PREFIX}${f} to the consultant.`),
      "system",
    );
  }
  return accepted;
}

// Reads a dataset file for download, but only if this engagement's data
// owner has released it. Returns null when unreleased or unknown.
export async function readReleasedDataset(
  engagement: Engagement,
  scenario: Scenario,
  file: string,
): Promise<Buffer | null> {
  const known = scenario.datasets.some((d) => d.file === file);
  if (!known) return null;
  const released = await getReleasedFiles(engagement.id);
  if (!released.includes(file)) return null;
  // File names come from the scenario config, not the URL, once validated
  // against scenario.datasets above; scenario ids are slug-validated in the
  // loader, so this path cannot escape datasets/.
  return readFile(resolve(process.cwd(), "datasets", scenario.id, file));
}

export type DataRelease = typeof dataReleases.$inferSelect;

/** The stored releases of one engagement, with the scope text that met the
 * release precondition. Survives the retention purge. */
export async function getDataReleases(engagementId: string): Promise<DataRelease[]> {
  return db.select().from(dataReleases).where(eq(dataReleases.engagementId, engagementId));
}
