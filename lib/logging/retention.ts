import { and, desc, eq, inArray, isNotNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { cohorts, dataReleases, engagements, events, messages, purgeRuns, students } from "@/lib/db/schema";
import { syncGradeRecord } from "@/lib/logging/grade-record";
import { deleteForRetention, findDeletionTarget } from "@/lib/admin/deletion";

// Retention window for engagement transcripts and event logs, in days, from
// the RETENTION_DAYS env var. Transcripts hold pseudonymised learner ids but
// raw conversation text, so they are purged once the teaching term (plus
// marking time) is over. Default 180 days.
//
// What the daily purge does, in order:
//   1. Copies the grade record (attempt, gate result, assessor-directed quote,
//      unverified note) from the events onto the submission and score rows
//      (lib/logging/grade-record.ts). If this fails nothing is deleted.
//   2. Deletes messages and events older than the window.
//   3. Blanks the learner's own words on data releases older than the window
//      (data_releases.scope_text), keeping the release row with the text's
//      length and sha256.
//   4. Deletes sandbox seats (learners who joined through Try as a learner)
//      older than SANDBOX_RETENTION_DAYS, with everything under them, and
//      records each deletion in deletion_log.
//   5. Removes the IP address hash from sandbox seats older than
//      ADDRESS_HASH_RETENTION_DAYS.
//
// Kept beyond the window, until an instructor deletes the learner, the
// engagement or the cohort (lib/admin/deletion.ts): submissions with their
// rubric scores and grade record, the world-fact ledger, fact_elicitations
// rows, and data_releases rows without their text.
//
// Reviewer-visible showcase cohorts (showcase.reviewerVisible) are exempt
// from steps 2 to 4: they hold the curated runs a paper points reviewers at,
// restored from demo/showcase-snapshot.json with their original timestamps,
// and hold no learner's own work.
const DEFAULT_RETENTION_DAYS = 180;

// A sandbox seat stores a salted hash of the visitor's IP address in its
// profile, only to limit how many seats one address takes in a day
// (lib/cohort/sandbox.ts). The daily purge removes it once the seat is this
// many days old.
export const ADDRESS_HASH_RETENTION_DAYS = 30;

// A sandbox seat has no instructor to ask for deletion, so the purge deletes
// the seat, its engagements and everything stored under them once the seat
// is this many days old.
export const SANDBOX_RETENTION_DAYS = 30;

// The actor recorded in deletion_log for a deletion the purge made.
export const RETENTION_ACTOR = "retention-purge";

const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionDays(): number {
  const raw = process.env.RETENTION_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

export interface PurgeResult {
  cutoffIso: string;
  messagesDeleted: number;
  eventsDeleted: number;
  /** Data releases whose learner-written scope text was blanked. */
  scopeTextsCleared?: number;
  /** Sandbox seats deleted with everything under them. */
  sandboxSeatsDeleted?: number;
  /** Sandbox seats whose IP address hash was removed. */
  addressHashesCleared?: number;
  /** Reviewer-visible showcase cohorts left out of the purge. */
  exemptCohorts?: number;
}

/** Whether a stored cohort config marks a reviewer-visible showcase cohort.
 * Read directly rather than through parseCohortConfig, whose fallback on a
 * bad config would drop the flag. Pure. */
export function isPurgeExempt(configJson: unknown): boolean {
  const showcase = (configJson as { showcase?: { reviewerVisible?: unknown } } | null)?.showcase;
  return showcase?.reviewerVisible === true;
}

/** Ids of the cohorts the purge leaves alone. */
export async function purgeExemptCohortIds(): Promise<string[]> {
  const rows = await db.select({ id: cohorts.id, configJson: cohorts.configJson }).from(cohorts);
  return rows.filter((r) => isPurgeExempt(r.configJson)).map((r) => r.id);
}

// Rows whose engagement is not in an exempt cohort.
function outsideExempt(column: PgColumn, exempt: string[]): SQL | undefined {
  if (exempt.length === 0) return undefined;
  return notInArray(
    column,
    db.select({ id: engagements.id }).from(engagements).where(inArray(engagements.cohortId, exempt)),
  );
}

/** Removes the IP address hash from sandbox seats created more than
 * ADDRESS_HASH_RETENTION_DAYS ago. Returns how many seats changed. */
export async function clearOldAddressHashes(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ADDRESS_HASH_RETENTION_DAYS * DAY_MS);
  const cleared = await db
    .update(students)
    .set({ profileJson: sql`${students.profileJson} - 'addressHash'` })
    .where(and(lt(students.createdAt, cutoff), sql`(${students.profileJson} ->> 'addressHash') is not null`))
    .returning({ id: students.id });
  return cleared.length;
}

/** Blanks data_releases.scope_text on releases created before the cutoff,
 * keeping the character count and the sha256 of the text. */
export async function clearOldScopeTexts(cutoff: Date, exempt: string[] = []): Promise<number> {
  const cleared = await db
    .update(dataReleases)
    .set({
      scopeTextChars: sql`char_length(${dataReleases.scopeText})`,
      scopeTextSha256: sql`encode(sha256(convert_to(${dataReleases.scopeText}, 'UTF8')), 'hex')`,
      scopeText: null,
      scopeTextPurgedAt: new Date(),
    })
    .where(and(lt(dataReleases.createdAt, cutoff), isNotNull(dataReleases.scopeText), outsideExempt(dataReleases.engagementId, exempt)))
    .returning({ id: dataReleases.id });
  return cleared.length;
}

/** Deletes sandbox seats created more than SANDBOX_RETENTION_DAYS ago, with
 * their engagements and every row under them. Returns how many seats went. */
export async function deleteOldSandboxSeats(now: Date = new Date(), exempt: string[] = []): Promise<number> {
  const cutoff = new Date(now.getTime() - SANDBOX_RETENTION_DAYS * DAY_MS);
  const seats = await db
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        lt(students.createdAt, cutoff),
        eq(sql`${students.profileJson} ->> 'kind'`, "sandbox"),
        exempt.length > 0 ? notInArray(students.cohortId, exempt) : undefined,
      ),
    );
  let deleted = 0;
  for (const seat of seats) {
    const target = await findDeletionTarget("learner", seat.id);
    if (!target) continue;
    if (await deleteForRetention(target, RETENTION_ACTOR)) deleted++;
  }
  return deleted;
}

// The daily purge; see the steps at the top of this file.
export async function purgeExpiredLogs(now: Date = new Date()): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - retentionDays() * DAY_MS);
  const cutoffIso = cutoff.toISOString();

  // If this fails the purge stops here, before anything is deleted.
  await syncGradeRecord();

  const exempt = await purgeExemptCohortIds();

  const deletedMessages = await db
    .delete(messages)
    .where(and(lt(messages.timestampIso, cutoffIso), outsideExempt(messages.engagementId, exempt)))
    .returning({ id: messages.id });

  const deletedEvents = await db
    .delete(events)
    .where(and(lt(events.timestampIso, cutoffIso), outsideExempt(events.engagementId, exempt)))
    .returning({ id: events.id });

  const scopeTextsCleared = await clearOldScopeTexts(cutoff, exempt);
  const sandboxSeatsDeleted = await deleteOldSandboxSeats(now, exempt);
  const addressHashesCleared = await clearOldAddressHashes(now);

  const result = {
    cutoffIso,
    messagesDeleted: deletedMessages.length,
    eventsDeleted: deletedEvents.length,
  };
  // Recorded after the deletes succeed, so lastPurgeAt means a purge that
  // completed.
  await db.insert(purgeRuns).values(result);
  return { ...result, scopeTextsCleared, sandboxSeatsDeleted, addressHashesCleared, exemptCohorts: exempt.length };
}

/** When the last successful purge ran, or null if none has. */
export async function lastPurgeAt(): Promise<Date | null> {
  const [row] = await db
    .select({ ranAt: purgeRuns.ranAt })
    .from(purgeRuns)
    .orderBy(desc(purgeRuns.ranAt))
    .limit(1);
  return row?.ranAt ?? null;
}
