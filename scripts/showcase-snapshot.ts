/**
 * Snapshot and restore one cohort, so a curated demo cohort survives being
 * poked at.
 *
 * The showcase cohort behind the WSDM submission
 * (slug `showcase-meridian-mobile-churn-gx3s8`) is a hand-built exhibit: a
 * complete six-stage human run beside a complete agent run, plus a
 * fail-then-revise submission. A reviewer who force-advances a stage, starts a
 * new engagement, or sends a persona a message changes it, and nothing in the
 * app puts it back. This script does.
 *
 *   pnpm showcase:export --cohort showcase-meridian-mobile-churn-gx3s8 \
 *                        --out demo/showcase-snapshot.json
 *   pnpm showcase:restore --in demo/showcase-snapshot.json
 *   pnpm showcase:restore --in demo/showcase-snapshot.json --dry-run
 *
 * Export reads every row that belongs to the cohort, across all fourteen
 * tables that hang off it (including the hidden-fact trace in
 * `fact_elicitations` and the scoped releases in `data_releases`, which the
 * retention purge leaves in place because grades depend on them), and writes them with their primary keys intact. Restore
 * deletes the cohort's current rows and re-inserts the snapshot verbatim
 * inside one transaction, so an interrupted restore leaves the database as it
 * was rather than half-replaced. When the target database already uses some
 * of the snapshot's serial ids for other rows (a snapshot taken on a local
 * database and restored into production, say), restore moves those ids past
 * the target's maxima, with the message references that point at them.
 *
 * Check-ins and reflections are research data, so a snapshot never carries
 * them: export leaves out the check-in rows, the reflection
 * text of every submission, and every event about a check-in or a reflection
 * (`checkin_submitted`, and any event type naming a reflection), and turns
 * `research.checkins` and `research.reflections` off in the cohort config.
 * Restore applies the same strip to any snapshot it reads (including files
 * taken before this rule).
 *
 * The database is whichever driver the environment selects, exactly as the app
 * selects it: Vercel Postgres by default, PGlite with DB_DRIVER=pglite.
 * Restore is destructive by definition, so read the summary it prints before
 * pointing it at a live deployment, and use --dry-run first.
 */
import { eq, inArray, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { readFileSync, writeFileSync } from "node:fs";
import * as schema from "../lib/db/schema";

// Both drivers the app ships with (Vercel Postgres, PGlite) are PgDatabase
// instances over this schema, so the export and restore functions take either
// one and the test can hand them a throwaway PGlite database.
export type SnapshotDb = PgDatabase<PgQueryResultHKT, typeof schema>;

// The tables a cohort owns, in dependency order: a parent always precedes its
// children. Inserts follow this order and deletes reverse it.
export const SNAPSHOT_TABLES = [
  "cohorts",
  "cohortInvites",
  "students",
  "studentSessions",
  "engagements",
  "channels",
  "messages",
  "submissions",
  "rubricScores",
  "worldFacts",
  "factElicitations",
  "dataReleases",
  "checkins",
  "events",
] as const;

// Tables added after the first snapshots were taken. A snapshot file written
// before them (any file written before ba8bf1c) has no such key; it parses
// with an empty list for each, which is what those runs recorded.
const LATER_TABLES: readonly SnapshotTable[] = ["factElicitations", "dataReleases"];

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

export type SnapshotRow = Record<string, unknown>;

export interface Snapshot {
  format: "agenticpracticum-cohort-snapshot";
  formatVersion: 1;
  exportedAt: string;
  cohort: { id: string; slug: string; name: string };
  counts: Record<SnapshotTable, number>;
  tables: Record<SnapshotTable, SnapshotRow[]>;
}

// JSON has no date type, so timestamps travel as ISO strings and are turned
// back into Date objects on the way in. Every timestamp column of every
// snapshot table is listed here; a column missed here would be re-inserted as
// a string and rejected by the driver.
const DATE_COLUMNS: Record<SnapshotTable, string[]> = {
  cohorts: ["createdAt", "archivedAt"],
  cohortInvites: ["expiresAt", "usedAt", "revokedAt", "createdAt"],
  students: ["createdAt", "lastActiveAt"],
  studentSessions: ["expiresAt", "createdAt"],
  engagements: ["createdAt", "completedAt", "attentionReviewedAt"],
  channels: ["unlockedAt", "createdAt"],
  messages: [],
  submissions: ["createdAt"],
  rubricScores: ["overriddenAt", "createdAt"],
  worldFacts: ["createdAt"],
  factElicitations: ["createdAt", "verifiedAt"],
  dataReleases: ["createdAt"],
  checkins: ["createdAt"],
  events: [],
};

// Tables whose primary key is a serial. Re-inserting explicit ids leaves the
// sequence pointing at whatever it reached before the restore, so the next
// insert would collide with a restored row. Each sequence is reset after the
// rows land.
const SERIAL_TABLES: { table: SnapshotTable; sqlName: string }[] = [
  { table: "messages", sqlName: "messages" },
  { table: "rubricScores", sqlName: "rubric_scores" },
  { table: "worldFacts", sqlName: "world_facts" },
  { table: "factElicitations", sqlName: "fact_elicitations" },
  { table: "dataReleases", sqlName: "data_releases" },
  { table: "checkins", sqlName: "checkins" },
  { table: "events", sqlName: "events" },
];

// Serial ids that other snapshot rows point at, outside a foreign key. The
// messages table is the only one referenced: an elicitation names the persona
// message that shared the fact, a release names the learner message that
// stated its scope, and the release event repeats that id in its detail.
// None of them has a foreign key, because the retention purge deletes
// messages, so a shift of message ids has to move them by hand.
const MESSAGE_REFERENCES: { table: SnapshotTable; column: string }[] = [
  { table: "factElicitations", column: "messageId" },
  { table: "dataReleases", column: "scopeMessageId" },
];
const MESSAGE_REFERENCES_IN_EVENT_DETAIL = ["scopeMessageId"];

export type SerialOffsets = Partial<Record<SnapshotTable, number>>;

/**
 * Move the serial ids of a snapshot by a per-table offset, together with every
 * reference to a shifted message id (MESSAGE_REFERENCES and the event detail
 * keys). Returns a copy; the input is not modified. UUID keys are never
 * touched, so the engagement ids that deep links use stay as they are.
 */
export function shiftSerialIds(snapshot: Snapshot, offsets: SerialOffsets): Snapshot {
  const tables = { ...snapshot.tables };
  for (const { table } of SERIAL_TABLES) {
    const by = offsets[table] ?? 0;
    if (by === 0) continue;
    tables[table] = tables[table].map((row) => (typeof row.id === "number" ? { ...row, id: row.id + by } : row));
  }
  const byMessage = offsets.messages ?? 0;
  if (byMessage !== 0) {
    const move = (v: unknown) => (typeof v === "number" ? v + byMessage : v);
    for (const { table, column } of MESSAGE_REFERENCES) {
      tables[table] = tables[table].map((row) => (row[column] == null ? row : { ...row, [column]: move(row[column]) }));
    }
    tables.events = tables.events.map((row) => {
      const detail = row.detailJson;
      if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return row;
      const record = detail as Record<string, unknown>;
      if (!MESSAGE_REFERENCES_IN_EVENT_DETAIL.some((k) => typeof record[k] === "number")) return row;
      const moved = { ...record };
      for (const k of MESSAGE_REFERENCES_IN_EVENT_DETAIL) moved[k] = move(record[k]);
      return { ...row, detailJson: moved };
    });
  }
  return { ...snapshot, tables };
}

// Postgres caps the parameters in one statement, and a busy showcase cohort
// carries hundreds of messages, so inserts go in batches.
const INSERT_CHUNK = 200;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function emptyCounts(): Record<SnapshotTable, number> {
  return Object.fromEntries(SNAPSHOT_TABLES.map((t) => [t, 0])) as Record<SnapshotTable, number>;
}

/** Look a cohort up by slug or by id, whichever the caller happens to have. */
export async function findCohort(
  db: SnapshotDb,
  ref: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const [row] = await db
    .select({ id: schema.cohorts.id, slug: schema.cohorts.slug, name: schema.cohorts.name })
    .from(schema.cohorts)
    .where(or(eq(schema.cohorts.slug, ref), eq(schema.cohorts.id, ref)))
    .limit(1);
  return row ?? null;
}

/**
 * Read every row belonging to one cohort. Rows keep their primary keys and
 * their foreign keys, so a snapshot is a literal copy rather than a
 * re-creation: restoring it puts back the same engagement ids the paper's
 * deep links point at.
 *
 * The instructor row in `users` is deliberately left out. It is the cohort's
 * parent, not part of it, and a restore that recreated the admin account
 * would fight with whatever password the deployment is running.
 */
export async function exportCohort(db: SnapshotDb, ref: string): Promise<Snapshot> {
  const cohort = await findCohort(db, ref);
  if (!cohort) throw new Error(`No cohort with slug or id "${ref}"`);

  const cohortRows = await db
    .select()
    .from(schema.cohorts)
    .where(eq(schema.cohorts.id, cohort.id));
  const inviteRows = await db
    .select()
    .from(schema.cohortInvites)
    .where(eq(schema.cohortInvites.cohortId, cohort.id))
    .orderBy(schema.cohortInvites.createdAt, schema.cohortInvites.id);
  const studentRows = await db
    .select()
    .from(schema.students)
    .where(eq(schema.students.cohortId, cohort.id))
    .orderBy(schema.students.createdAt, schema.students.id);
  const studentIds = studentRows.map((s) => s.id);

  const sessionRows = studentIds.length
    ? await db
        .select()
        .from(schema.studentSessions)
        .where(inArray(schema.studentSessions.studentId, studentIds))
        .orderBy(schema.studentSessions.createdAt, schema.studentSessions.id)
    : [];

  const engagementRows = await db
    .select()
    .from(schema.engagements)
    .where(eq(schema.engagements.cohortId, cohort.id))
    .orderBy(schema.engagements.createdAt, schema.engagements.id);
  const engagementIds = engagementRows.map((e) => e.id);

  const byEngagement = <T extends { engagementId: string }>(
    rows: T[],
  ): T[] => rows;

  const channelRows = engagementIds.length
    ? await db
        .select()
        .from(schema.channels)
        .where(inArray(schema.channels.engagementId, engagementIds))
        .orderBy(schema.channels.createdAt, schema.channels.id)
    : [];
  const messageRows = engagementIds.length
    ? byEngagement(
        await db
          .select()
          .from(schema.messages)
          .where(inArray(schema.messages.engagementId, engagementIds))
          .orderBy(schema.messages.id),
      )
    : [];
  const submissionRows = engagementIds.length
    ? await db
        .select()
        .from(schema.submissions)
        .where(inArray(schema.submissions.engagementId, engagementIds))
        .orderBy(schema.submissions.createdAt, schema.submissions.id)
    : [];
  const scoreRows = engagementIds.length
    ? await db
        .select()
        .from(schema.rubricScores)
        .where(inArray(schema.rubricScores.engagementId, engagementIds))
        .orderBy(schema.rubricScores.id)
    : [];
  const factRows = engagementIds.length
    ? await db
        .select()
        .from(schema.worldFacts)
        .where(inArray(schema.worldFacts.engagementId, engagementIds))
        .orderBy(schema.worldFacts.id)
    : [];
  const elicitationRows = engagementIds.length
    ? await db
        .select()
        .from(schema.factElicitations)
        .where(inArray(schema.factElicitations.engagementId, engagementIds))
        .orderBy(schema.factElicitations.id)
    : [];
  const releaseRows = engagementIds.length
    ? await db
        .select()
        .from(schema.dataReleases)
        .where(inArray(schema.dataReleases.engagementId, engagementIds))
        .orderBy(schema.dataReleases.id)
    : [];
  // Check-ins are reserved research data and never leave the database in a snapshot
  // (see stripResearchFlagged), so they are not read at all.
  const checkinRows: SnapshotRow[] = [];

  // An event row can name the cohort, an engagement, or both: cohort-level
  // events (a cohort archived, an invite minted) carry no engagement, and an
  // engagement's own events carry cohortId too. Take the union so neither
  // kind is left behind.
  const eventRows = engagementIds.length
    ? await db
        .select()
        .from(schema.events)
        .where(
          or(
            eq(schema.events.cohortId, cohort.id),
            inArray(schema.events.engagementId, engagementIds),
          ),
        )
        .orderBy(schema.events.id)
    : await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.cohortId, cohort.id))
        .orderBy(schema.events.id);

  const tables = {
    cohorts: cohortRows,
    cohortInvites: inviteRows,
    students: studentRows,
    studentSessions: sessionRows,
    engagements: engagementRows,
    channels: channelRows,
    messages: messageRows,
    submissions: submissionRows,
    rubricScores: scoreRows,
    worldFacts: factRows,
    factElicitations: elicitationRows,
    dataReleases: releaseRows,
    checkins: checkinRows,
    events: eventRows,
  } as unknown as Record<SnapshotTable, SnapshotRow[]>;

  const counts = emptyCounts();
  for (const name of SNAPSHOT_TABLES) counts[name] = tables[name].length;

  return stripResearchFlagged({
    format: "agenticpracticum-cohort-snapshot",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    cohort,
    counts,
    tables,
  });
}

/** An event type that belongs to the research-flagged features (check-ins, reflections). */
export function isResearchFlaggedEvent(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("checkin") || type.includes("reflection"));
}

/**
 * Remove the research data that no snapshot carries: every check-in row,
 * every submission's reflection text, and the cohort config switches that turn
 * those features on. Returns a copy; the input is not modified. Applied on
 * export and again on restore, so an older snapshot file that still carries
 * them is cleaned on the way in.
 */

export function stripResearchFlagged(snapshot: Snapshot): Snapshot {
  const tables = { ...snapshot.tables };
  tables.checkins = [];
  if (Array.isArray(tables.events)) tables.events = tables.events.filter((row) => !isResearchFlaggedEvent(row.type));
  tables.submissions = tables.submissions.map((row) => ({ ...row, reflectionText: null }));
  tables.cohorts = tables.cohorts.map((row) => {
    const config = row.configJson;
    if (config === null || typeof config !== "object" || Array.isArray(config)) return row;
    const record = config as Record<string, unknown>;
    const research =
      record.research !== null && typeof record.research === "object" && !Array.isArray(record.research)
        ? (record.research as Record<string, unknown>)
        : {};
    return { ...row, configJson: { ...record, research: { ...research, checkins: false, reflections: false } } };
  });
  const counts = { ...snapshot.counts, checkins: 0 };
  if (Array.isArray(tables.events)) counts.events = tables.events.length;
  return { ...snapshot, counts, tables };
}

/**
 * Mark the restored cohort as the one the read-only reviewer account may see
 * (showcase.reviewerVisible; lib/auth/cohort-scope.ts). A snapshot is by
 * definition the showcase exhibit, and a file taken before the flag existed
 * would otherwise restore hidden from the reviewer. Returns a copy.
 */
export function markReviewerVisible(snapshot: Snapshot): Snapshot {
  const tables = { ...snapshot.tables };
  tables.cohorts = tables.cohorts.map((row) => {
    const config = row.configJson;
    if (config === null || typeof config !== "object" || Array.isArray(config)) return row;
    const record = config as Record<string, unknown>;
    const showcase =
      record.showcase !== null && typeof record.showcase === "object" && !Array.isArray(record.showcase)
        ? (record.showcase as Record<string, unknown>)
        : {};
    return { ...row, configJson: { ...record, showcase: { ...showcase, reviewerVisible: true } } };
  });
  return { ...snapshot, tables };
}

function reviveRow(row: SnapshotRow, dateColumns: string[]): SnapshotRow {
  const out: SnapshotRow = { ...row };
  for (const column of dateColumns) {
    const value = out[column];
    if (typeof value === "string") out[column] = new Date(value);
  }
  return out;
}

/** Read a snapshot file and check it is one of ours before anything is deleted. */
export function parseSnapshot(json: string): Snapshot {
  const parsed = JSON.parse(json) as Partial<Snapshot>;
  if (parsed.format !== "agenticpracticum-cohort-snapshot") {
    throw new Error("Not a cohort snapshot: the `format` field does not match.");
  }
  if (parsed.formatVersion !== 1) {
    throw new Error(`Unsupported snapshot format version: ${String(parsed.formatVersion)}`);
  }
  if (!parsed.cohort?.id || !parsed.tables) {
    throw new Error("Snapshot is missing its cohort header or its tables.");
  }
  for (const name of LATER_TABLES) {
    if (parsed.tables[name] === undefined) {
      parsed.tables[name] = [];
      if (parsed.counts) parsed.counts[name] = 0;
    }
  }
  for (const name of SNAPSHOT_TABLES) {
    if (!Array.isArray(parsed.tables[name])) {
      throw new Error(`Snapshot is missing the "${name}" table.`);
    }
  }
  if (parsed.tables.cohorts.length !== 1) {
    throw new Error("Snapshot must hold exactly one cohort row.");
  }
  return parsed as Snapshot;
}

/**
 * Put the cohort back as the snapshot has it.
 *
 * Everything runs in one transaction, and the deletes all happen before the
 * inserts. That order is not cosmetic: `engagements_one_active_per_student` is
 * a partial unique index over active engagements per learner, so inserting a
 * snapshot's active engagement while the reviewer's active engagement is still
 * in the table would fail. Deleting first also means the cohort's own row can
 * be replaced rather than merged, which is what keeps a reviewer's config
 * edits from surviving the restore.
 *
 * Serial sequences are reset afterwards, so the next message or event written
 * by the app gets a fresh id instead of colliding with a restored row.
 */
export async function restoreCohort(
  db: SnapshotDb,
  input: Snapshot,
): Promise<{
  deleted: Record<SnapshotTable, number>;
  inserted: Record<SnapshotTable, number>;
  shifted: SerialOffsets;
}> {
  let snapshot = markReviewerVisible(stripResearchFlagged(input));
  const cohortId = snapshot.cohort.id;
  const deleted = emptyCounts();
  const inserted = emptyCounts();
  const shifted: SerialOffsets = {};

  await db.transaction(async (tx) => {
    const existingStudents = await tx
      .select({ id: schema.students.id })
      .from(schema.students)
      .where(eq(schema.students.cohortId, cohortId));
    const studentIds = existingStudents.map((s) => s.id);

    const existingEngagements = await tx
      .select({ id: schema.engagements.id })
      .from(schema.engagements)
      .where(eq(schema.engagements.cohortId, cohortId));
    const engagementIds = existingEngagements.map((e) => e.id);

    // Children first, parents last: the reverse of the insert order below.
    if (engagementIds.length) {
      await tx
        .delete(schema.events)
        .where(
          or(
            eq(schema.events.cohortId, cohortId),
            inArray(schema.events.engagementId, engagementIds),
          ),
        );
      await tx.delete(schema.checkins).where(inArray(schema.checkins.engagementId, engagementIds));
      await tx
        .delete(schema.dataReleases)
        .where(inArray(schema.dataReleases.engagementId, engagementIds));
      await tx
        .delete(schema.factElicitations)
        .where(inArray(schema.factElicitations.engagementId, engagementIds));
      await tx
        .delete(schema.worldFacts)
        .where(inArray(schema.worldFacts.engagementId, engagementIds));
      await tx
        .delete(schema.rubricScores)
        .where(inArray(schema.rubricScores.engagementId, engagementIds));
      await tx
        .delete(schema.submissions)
        .where(inArray(schema.submissions.engagementId, engagementIds));
      await tx.delete(schema.messages).where(inArray(schema.messages.engagementId, engagementIds));
      await tx.delete(schema.channels).where(inArray(schema.channels.engagementId, engagementIds));
      await tx.delete(schema.engagements).where(eq(schema.engagements.cohortId, cohortId));
    } else {
      await tx.delete(schema.events).where(eq(schema.events.cohortId, cohortId));
    }
    if (studentIds.length) {
      await tx
        .delete(schema.studentSessions)
        .where(inArray(schema.studentSessions.studentId, studentIds));
      await tx.delete(schema.students).where(eq(schema.students.cohortId, cohortId));
    }
    await tx.delete(schema.cohortInvites).where(eq(schema.cohortInvites.cohortId, cohortId));
    await tx.delete(schema.cohorts).where(eq(schema.cohorts.id, cohortId));

    deleted.students = studentIds.length;
    deleted.engagements = engagementIds.length;

    // The cohort row has a foreign key to its instructor in `users`, which
    // the snapshot deliberately leaves out (see exportCohort). On a fresh
    // database, such as the PGlite behind `make demo-showcase`, that row does
    // not exist until someone signs in, so it is created here when missing.
    // Only the id and role are written; an existing row is left untouched.
    const instructorIds = [
      ...new Set(snapshot.tables.cohorts.map((c) => c.instructorId).filter((id): id is string => typeof id === "string")),
    ];
    for (const id of instructorIds) {
      await tx.insert(schema.users).values({ id, email: id, role: "instructor" }).onConflictDoNothing();
    }

    // A snapshot taken on another database (a local one, say) carries serial
    // ids that the target may already use for other cohorts' rows. After the
    // cohort's own rows are gone, any snapshot id still present in the target
    // belongs to someone else, so that table's ids move past the target's
    // maximum, and the message references move with them. A restore into the
    // database the snapshot came from finds no clash and keeps every id.
    for (const { table, sqlName } of SERIAL_TABLES) {
      const ids = snapshot.tables[table].map((row) => row.id).filter((id): id is number => typeof id === "number");
      if (ids.length === 0) continue;
      const result = await tx.execute(
        sql`select coalesce(max(id), 0)::int as max_id,
              count(*) filter (where id = any(${sql.raw(`array[${ids.join(",")}]::int[]`)}))::int as clashes
            from ${sql.identifier(sqlName)}`,
      );
      const row = ((result as unknown as { rows?: SnapshotRow[] }).rows ?? (result as unknown as SnapshotRow[]))[0];
      const clashes = Number(row?.clashes ?? 0);
      if (clashes === 0) continue;
      shifted[table] = Number(row?.max_id ?? 0) - Math.min(...ids) + 1;
    }
    if (Object.keys(shifted).length > 0) snapshot = shiftSerialIds(snapshot, shifted);

    const target = {
      cohorts: schema.cohorts,
      cohortInvites: schema.cohortInvites,
      students: schema.students,
      studentSessions: schema.studentSessions,
      engagements: schema.engagements,
      channels: schema.channels,
      messages: schema.messages,
      submissions: schema.submissions,
      rubricScores: schema.rubricScores,
      worldFacts: schema.worldFacts,
      factElicitations: schema.factElicitations,
      dataReleases: schema.dataReleases,
      checkins: schema.checkins,
      events: schema.events,
    } as const;

    for (const name of SNAPSHOT_TABLES) {
      const rows = snapshot.tables[name].map((row) => reviveRow(row, DATE_COLUMNS[name]));
      if (rows.length === 0) continue;
      for (const batch of chunk(rows, INSERT_CHUNK)) {
        // The row shapes come from the same schema they are inserted into;
        // the snapshot is untyped JSON on the way through.
        await tx.insert(target[name]).values(batch as never);
      }
      inserted[name] = rows.length;
    }

    for (const { sqlName } of SERIAL_TABLES) {
      // setval(..., n, false) means "the next id handed out is n", which is
      // what we want when the table may be empty and max(id) is null.
      await tx.execute(
        sql`select setval(pg_get_serial_sequence(${sqlName}, 'id'),
              coalesce((select max(id) from ${sql.identifier(sqlName)}), 0) + 1, false)`,
      );
    }
  });

  return { deleted, inserted, shifted };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const USAGE = `Usage:
  pnpm showcase:export  --cohort <slug-or-id> --out <file.json>
  pnpm showcase:restore --in <file.json> [--dry-run]

The database driver follows the environment, as the app does: Vercel Postgres
by default, PGlite with DB_DRIVER=pglite.`;

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== "export" && command !== "restore") {
    console.error(USAGE);
    process.exit(1);
  }

  // Imported here rather than at the top so the exported functions above stay
  // usable in tests without opening a connection to whatever the environment
  // happens to point at.
  const { db } = (await import("../lib/db/client")) as { db: SnapshotDb };

  if (command === "export") {
    const ref = flag(argv, "cohort");
    const out = flag(argv, "out");
    if (!ref || !out) {
      console.error(USAGE);
      process.exit(1);
    }
    const snapshot = await exportCohort(db, ref);
    writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    console.log(`Cohort ${snapshot.cohort.slug} (${snapshot.cohort.id}) written to ${out}`);
    for (const name of SNAPSHOT_TABLES) {
      console.log(`  ${name.padEnd(16)} ${snapshot.counts[name]}`);
    }
    return;
  }

  const input = flag(argv, "in");
  if (!input) {
    console.error(USAGE);
    process.exit(1);
  }
  // Stripped here as well as in restoreCohort so the dry-run counts are the
  // counts that would actually be inserted.
  const snapshot = stripResearchFlagged(parseSnapshot(readFileSync(input, "utf8")));
  const current = await findCohort(db, snapshot.cohort.id);
  console.log(`Snapshot : ${snapshot.cohort.slug} (${snapshot.cohort.id}), taken ${snapshot.exportedAt}`);
  console.log(`In the database: ${current ? `${current.slug} (${current.name})` : "no such cohort yet"}`);

  if (argv.includes("--dry-run")) {
    console.log("\n--dry-run: nothing written. The restore would replace these rows:");
    for (const name of SNAPSHOT_TABLES) {
      console.log(`  ${name.padEnd(16)} ${snapshot.counts[name]}`);
    }
    return;
  }

  const result = await restoreCohort(db, snapshot);
  console.log("\nRestored. Rows inserted:");
  for (const name of SNAPSHOT_TABLES) {
    console.log(`  ${name.padEnd(16)} ${result.inserted[name]}`);
  }
  const moves = Object.entries(result.shifted);
  if (moves.length > 0) {
    console.log("Serial ids moved past this database's existing rows (message references moved with them):");
    for (const [name, by] of moves) console.log(`  ${name.padEnd(16)} +${by}`);
  }
  console.log(
    `Replaced ${result.deleted.engagements} engagement(s) and ${result.deleted.students} learner(s) that were in the cohort.`,
  );
}

// Only run the CLI when this file is the entry point, so importing it from a
// test does not start talking to a database.
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0");

// The database handle keeps the event loop alive once the work is done, so the
// process has to be told to stop or the command appears to hang after printing
// its summary. Wait for stdout to drain first: writing to a pipe is
// asynchronous, and exiting straight away would cut the summary off.
function finish(code: number): void {
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    () => finish(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      finish(1);
    },
  );
}
