// Instructor deletion of a learner, an engagement or a cohort. Each is one
// DELETE on the parent row; the foreign keys cascade to everything under it
// (sessions, engagements, channels, messages, submissions, rubric scores,
// the fact ledger, check-ins, events and fact_elicitations; for a cohort,
// also its invites and learners). The rows each table loses are counted
// first and written to deletion_log, which has no foreign keys and holds no
// content, so the record of the deletion outlives what it deleted.
//
// The count, the delete and the log row run in one transaction, so a failed
// log insert rolls the delete back rather than leaving rows gone with no
// record.
//
// The caller has already checked that the session may write and owns the
// cohort (app/api/admin/deletions/route.ts). The typed confirmation phrase is
// checked here as well as in the form, so a request that skips the form is
// still refused.

import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import {
  channels,
  checkins,
  cohortInvites,
  dataReleases,
  cohorts,
  deletionLog,
  engagements,
  events,
  factElicitations,
  messages,
  rubricScores,
  studentSessions,
  students,
  submissions,
  worldFacts,
} from "@/lib/db/schema";
import { confirmationPhrase, type DeletionKind } from "@/lib/admin/deletion-phrase";
import {
  SHOWCASE_PROTECTED_ERROR,
  protectedShowcaseLabels,
  showcaseDeletionRefusal,
  showcaseLabelsOf,
} from "@/lib/admin/showcase-protection";

export { confirmationPhrase, type DeletionKind };

export const DATA_DELETED_EVENT = "data_deleted";

export interface DeletionTarget {
  kind: DeletionKind;
  id: string;
  cohortId: string;
  /** What the instructor must type: see confirmationPhrase. */
  phrase: string;
}

export type DeletionResult =
  | { ok: true; rows: Record<string, number> }
  | { ok: false; status: number; error: string; message: string };

/** The target and the cohort it belongs to, or null when it does not exist. */
export async function findDeletionTarget(kind: DeletionKind, id: string): Promise<DeletionTarget | null> {
  if (kind === "cohort") {
    const [row] = await db.select({ id: cohorts.id, slug: cohorts.slug }).from(cohorts).where(eq(cohorts.id, id)).limit(1);
    return row ? { kind, id: row.id, cohortId: row.id, phrase: confirmationPhrase(kind, row) } : null;
  }
  if (kind === "learner") {
    const [row] = await db
      .select({ id: students.id, cohortId: students.cohortId, learnerHash: students.learnerHash })
      .from(students)
      .where(eq(students.id, id))
      .limit(1);
    return row ? { kind, id: row.id, cohortId: row.cohortId, phrase: confirmationPhrase(kind, row) } : null;
  }
  const [row] = await db
    .select({ id: engagements.id, cohortId: engagements.cohortId })
    .from(engagements)
    .where(eq(engagements.id, id))
    .limit(1);
  return row ? { kind, id: row.id, cohortId: row.cohortId, phrase: confirmationPhrase(kind, row) } : null;
}

// The database or an open transaction: both expose the same query builder.
type Executor = Pick<typeof db, "select" | "delete" | "insert">;

async function engagementIdsFor(target: DeletionTarget, ex: Executor = db): Promise<string[]> {
  const where =
    target.kind === "cohort"
      ? eq(engagements.cohortId, target.id)
      : target.kind === "learner"
        ? eq(engagements.studentId, target.id)
        : eq(engagements.id, target.id);
  const rows = await ex.select({ id: engagements.id }).from(engagements).where(where);
  return rows.map((r) => r.id);
}

async function countIn(table: PgTable, where: SQL, ex: Executor = db): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return Number(row?.n ?? 0);
}

/** Rows each table will lose. */
export async function countDeletion(target: DeletionTarget, ex: Executor = db): Promise<Record<string, number>> {
  const countWhere = (table: PgTable, where: SQL) => countIn(table, where, ex);
  const ids = await engagementIdsFor(target, ex);
  const inEngagements = (column: PgColumn) =>
    ids.length === 0 ? sql`false` : inArray(column, ids);
  const rows: Record<string, number> = {
    engagements: ids.length,
    channels: await countWhere(channels, inEngagements(channels.engagementId)),
    messages: await countWhere(messages, inEngagements(messages.engagementId)),
    submissions: await countWhere(submissions, inEngagements(submissions.engagementId)),
    rubric_scores: await countWhere(rubricScores, inEngagements(rubricScores.engagementId)),
    world_facts: await countWhere(worldFacts, inEngagements(worldFacts.engagementId)),
    checkins: await countWhere(checkins, inEngagements(checkins.engagementId)),
    events: await countWhere(events, inEngagements(events.engagementId)),
    fact_elicitations: await countWhere(factElicitations, inEngagements(factElicitations.engagementId)),
    data_releases: await countWhere(dataReleases, inEngagements(dataReleases.engagementId)),
  };
  if (target.kind === "learner") {
    rows.students = 1;
    rows.student_sessions = await countWhere(studentSessions, eq(studentSessions.studentId, target.id));
  }
  if (target.kind === "cohort") {
    rows.cohorts = 1;
    rows.students = await countWhere(students, eq(students.cohortId, target.id));
    rows.student_sessions = await countWhere(
      studentSessions,
      sql`${studentSessions.studentId} in (select ${students.id} from ${students} where ${students.cohortId} = ${target.id})`,
    );
    rows.cohort_invites = await countWhere(cohortInvites, eq(cohortInvites.cohortId, target.id));
  }
  return rows;
}

/** The showcase labels (H1, A1, exhibit...) of the runs a learner or an
 * engagement deletion would remove; empty for a cohort deletion, which
 * stays allowed behind its typed confirmation. */
export async function showcaseRunsInTarget(target: DeletionTarget, ex: Executor = db): Promise<string[]> {
  if (target.kind === "cohort") return [];
  const [cohort] = await ex
    .select({ configJson: cohorts.configJson })
    .from(cohorts)
    .where(eq(cohorts.id, target.cohortId))
    .limit(1);
  if (!cohort) return [];
  const labels = showcaseLabelsOf(cohort.configJson);
  if (Object.keys(labels).length === 0) return [];
  return protectedShowcaseLabels(labels, await engagementIdsFor(target, ex));
}

/**
 * Deletes the target after checking the typed phrase, and records the
 * deletion. Returns the row counts, or why it refused. A learner or an
 * engagement that holds a labelled showcase run is refused
 * (lib/admin/showcase-protection.ts).
 */
export async function deleteTarget(
  target: DeletionTarget,
  typed: string,
  actorId: string | null,
): Promise<DeletionResult> {
  if (target.kind !== "cohort") {
    const showcase = await showcaseRunsInTarget(target);
    if (showcase.length > 0) {
      return {
        ok: false,
        status: 409,
        error: SHOWCASE_PROTECTED_ERROR,
        message: showcaseDeletionRefusal(target.kind, showcase),
      };
    }
  }
  if (typed.trim() !== target.phrase) {
    return {
      ok: false,
      status: 400,
      error: "confirmation-mismatch",
      message: `Type ${target.phrase} exactly to confirm.`,
    };
  }
  return { ok: true, rows: await deleteAndLog(target, actorId) };
}

/** Deletes a learner or an engagement for the retention purge: no typed
 * phrase, and recorded in deletion_log with the purge as the actor. Returns
 * null, deleting nothing, when the target holds a labelled showcase run. */
export async function deleteForRetention(
  target: DeletionTarget,
  actorId: string,
): Promise<Record<string, number> | null> {
  if (target.kind === "cohort") return null;
  if ((await showcaseRunsInTarget(target)).length > 0) return null;
  return deleteAndLog(target, actorId);
}

async function deleteAndLog(target: DeletionTarget, actorId: string | null): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const counted = await countDeletion(target, tx);
    if (target.kind === "cohort") {
      await tx.delete(cohorts).where(eq(cohorts.id, target.id));
    } else if (target.kind === "learner") {
      await tx.delete(students).where(eq(students.id, target.id));
    } else {
      await tx.delete(engagements).where(eq(engagements.id, target.id));
    }
    await tx.insert(deletionLog).values({
      type: DATA_DELETED_EVENT,
      kind: target.kind,
      targetId: target.id,
      cohortId: target.cohortId,
      actorId,
      rowsJson: counted,
    });
    return counted;
  });
}

/** Recent deletions in the given cohorts, newest first, for the admin pages. */
export async function recentDeletions(cohortIds: string[], limit = 20) {
  if (cohortIds.length === 0) return [];
  return db
    .select()
    .from(deletionLog)
    .where(inArray(deletionLog.cohortId, cohortIds))
    .orderBy(sql`${deletionLog.id} desc`)
    .limit(limit);
}

/** Every recorded deletion, newest first, for the Deletions page. A deleted
 * cohort's rows no longer match any cohort, so this is not filtered by
 * cohort; it holds no content. */
export async function allDeletions(limit = 200) {
  return db.select().from(deletionLog).orderBy(sql`${deletionLog.id} desc`).limit(limit);
}
