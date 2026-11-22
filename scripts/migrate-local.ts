// Applies the drizzle migrations to the local PGlite database (.pglite/).
// Used by `pnpm demo`; the cloud database is migrated with `pnpm db:migrate`.
//
// The demo database is throwaway state: if PGlite cannot reopen the directory
// (typically after an unclean shutdown leaves a stale postmaster.pid or a
// torn WAL), we wipe it and start fresh rather than failing `make demo`.

import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const DIR = process.env.PGLITE_DIR ?? ".pglite";

async function applyMigrations(): Promise<void> {
  const client = new PGlite(DIR);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  await client.close();
}

async function main() {
  try {
    await applyMigrations();
  } catch (err) {
    // A resumed regeneration (REGEN_RESUME=1) holds real work in the directory:
    // never reset it.
    if (process.env.MIGRATE_NO_RESET === "1") throw err;
    console.warn(`PGlite could not open ${DIR} (${(err as Error).message ?? err}); ` +
      "resetting the demo database and retrying.");
    rmSync(DIR, { recursive: true, force: true });
    await applyMigrations();
  }
  console.log(`PGlite migrations applied (${DIR}/)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
