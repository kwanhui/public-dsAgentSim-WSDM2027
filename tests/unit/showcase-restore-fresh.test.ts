// `make demo-showcase` restores the committed showcase snapshot into a fresh
// PGlite database. The cohort row needs its instructor in `users`, which the
// snapshot leaves out, so the restore creates that row when it is missing.
// This runs the committed snapshot through the current migrations.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import { parseSnapshot, restoreCohort, stripResearchFlagged, type SnapshotDb } from "@/scripts/showcase-snapshot";

describe("showcase restore on a fresh database", () => {
  it("creates the missing instructor row and restores every table", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as SnapshotDb;
    await migrate(db as never, { migrationsFolder: "lib/db/migrations" });

    const snapshot = parseSnapshot(readFileSync("demo/showcase-snapshot.json", "utf8"));
    const result = await restoreCohort(db, snapshot);
    expect(result.inserted).toEqual(stripResearchFlagged(snapshot).counts);
    expect(result.inserted.checkins).toBe(0);
    expect((await db.select().from(schema.checkins)).length).toBe(0);

    const users = await db.select().from(schema.users);
    expect(users.map((u) => u.id)).toEqual([snapshot.tables.cohorts[0].instructorId]);

    // A second restore leaves the existing user row alone.
    await restoreCohort(db, snapshot);
    expect((await db.select().from(schema.users)).length).toBe(1);
    await client.close();
  }, 30_000);

  it("is committed without check-ins, reflections or check-in events", () => {
    const snapshot = parseSnapshot(readFileSync("demo/showcase-snapshot.json", "utf8"));
    expect(snapshot.tables.checkins).toEqual([]);
    expect(snapshot.tables.submissions.filter((s) => s.reflectionText)).toEqual([]);
    expect(snapshot.tables.events.filter((e) => /checkin|reflection/.test(String(e.type)))).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(/checkin_submitted/);
    expect(snapshot.tables.cohorts[0].configJson).toMatchObject({ research: { checkins: false, reflections: false } });
  });
});
