// Shared by the paper-metrics pullers and the spend script: open a database
// named on the command line, and write CSV.
//
//   pglite:<dir>   a PGlite data directory (the offline demo, or a local copy)
//   postgres       the hosted database; POSTGRES_URL_NON_POOLING must be set
//
// PGlite is single-process: point it at a directory that no server is using.
// All access here is SELECT only.

export interface Row {
  [column: string]: unknown;
}

export interface Source {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

export async function openSource(spec: string): Promise<Source> {
  if (spec.startsWith("pglite:")) {
    const dir = spec.slice("pglite:".length);
    if (!dir) throw new Error("--source pglite:<dir> needs a directory");
    const { PGlite } = await import("@electric-sql/pglite");
    let db: InstanceType<typeof PGlite>;
    try {
      db = new PGlite(dir);
      await db.waitReady;
    } catch (err) {
      throw new Error(
        `PGlite could not open ${dir} (${err instanceof Error ? err.message : String(err)}). ` +
          `A directory left by a server that was killed instead of closed, or copied while a server was ` +
          `writing to it, can have an unreadable checkpoint (the log shows "PANIC: could not locate a valid ` +
          `checkpoint record"). Stop the server cleanly, or read the data from the running app's exports.`,
      );
    }
    return {
      query: async (sql, params) => (await db.query<Row>(sql, params)).rows,
      close: () => db.close(),
    };
  }
  if (spec === "postgres") {
    const url = process.env.POSTGRES_URL_NON_POOLING;
    if (!url) throw new Error("--source postgres needs POSTGRES_URL_NON_POOLING in the environment");
    const { createClient } = await import("@vercel/postgres");
    const client = createClient({ connectionString: url });
    await client.connect();
    return {
      query: async (sql, params) => (await client.query(sql, params)).rows as Row[],
      close: () => client.end(),
    };
  }
  throw new Error(`Unknown --source "${spec}"; use pglite:<dir> or postgres`);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function toCsvText(rows: Row[], columns?: string[]): string {
  if (rows.length === 0 && !columns) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = cell(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")}\n`;
}

/** Read `--name value` from argv; a repeated flag returns the last value. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.lastIndexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

export function flagAll(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === `--${name}`) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      out.push(v);
    }
  });
  return out;
}
