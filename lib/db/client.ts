import { drizzle } from "drizzle-orm/vercel-postgres";
import { sql } from "@vercel/postgres";
import type { PGlite as PGliteClient } from "@electric-sql/pglite";
import * as schema from "./schema";
import { isNextWorkerProcess, makePgliteCloser, registerPgliteShutdown } from "./pglite-lifecycle";

type Db = ReturnType<typeof drizzle<typeof schema>>;

interface DbState {
  db: Db;
  pglite?: PGliteClient;
  close: () => Promise<void>;
}

// Production driver is Vercel Postgres (Neon). Setting DB_DRIVER=pglite
// swaps in an embedded Postgres (PGlite, file-backed under .pglite/) so the
// demo and local development run without any cloud database; see
// `pnpm demo`. Both drivers expose the same drizzle query API.
function createDb(): DbState {
  if (process.env.DB_DRIVER === "pglite") {
    if (isNextWorkerProcess()) {
      // Fail loudly rather than put a second process on the data directory,
      // which corrupts it. Nothing should reach this: the db is opened on
      // first use, and module evaluation alone does not use it.
      throw new Error("PGlite must not be opened from a Next.js worker process (static paths or build worker).");
    }
    // Required lazily so @electric-sql/pglite never enters the production
    // bundle path.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } =
      require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const client = new PGlite(process.env.PGLITE_DIR ?? ".pglite");
    const close = makePgliteCloser(client);
    registerPgliteShutdown(close);
    return {
      db: drizzlePglite(client, { schema }) as unknown as Db,
      pglite: client,
      close,
    };
  }
  if (process.env.DB_DRIVER === "direct") {
    // Operator scripts run from a laptop (showcase snapshot, metrics pulls)
    // reach Neon over a direct connection, because the pooled WebSocket path
    // the app uses is not always reachable outside Vercel. pg queues queries
    // issued before the connection completes, so connect() need not be awaited.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@vercel/postgres") as typeof import("@vercel/postgres");
    const client = createClient({ connectionString: process.env.POSTGRES_URL_NON_POOLING });
    void client.connect();
    return { db: drizzle(client, { schema }) as unknown as Db, close: () => client.end() };
  }
  return { db: drizzle(sql, { schema }), close: async () => {} };
}

// One instance per process, kept on globalThis. The dev server bundles this
// module once per route chunk and re-evaluates it on hot reload, so a bare
// module-level instance would open several PGlite handles on the same data
// directory. For PGlite this holds in production too, since the directory
// admits a single open handle per process.
const globalForDb = globalThis as unknown as { __dsagentsimDbState?: DbState };

function state(): DbState {
  let s = globalForDb.__dsagentsimDbState;
  if (!s) {
    // Cached for every driver: in production this is the one drizzle
    // instance per process that the module-level export used to be.
    s = createDb();
    globalForDb.__dsagentsimDbState = s;
  }
  return s;
}

// The database is opened on first use, not on import. Next's dev server forks
// a short-lived worker process for requests to dynamic routes (the
// static-paths worker) and evaluates the route's module graph there; an eager
// open put a second PGlite process on the data directory, which logged
// "Unhandled Rejection: RuntimeError: Aborted()" when the worker was torn
// down and could corrupt the directory's checkpoint.
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = state().db;
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  has(_target, prop) {
    return Reflect.has(state().db, prop);
  },
});

/** The raw PGlite client when DB_DRIVER=pglite and the db has been opened. */
export function getPgliteClient(): PGliteClient | undefined {
  return globalForDb.__dsagentsimDbState?.pglite;
}

/**
 * Closes the database if it was opened (CHECKPOINT then close for PGlite).
 * Idempotent; a later use of `db` in the same process fails, as PGlite
 * rejects queries after close.
 */
export async function closeDb(): Promise<void> {
  await globalForDb.__dsagentsimDbState?.close();
}
