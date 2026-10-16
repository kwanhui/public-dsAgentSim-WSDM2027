// A drizzle stand-in for unit tests of the persona turn and gate paths that
// mock the state module: enough of the query builder for the reads and
// writes of the elicitation trace (lib/engagement/elicitation.ts), with the
// rows written kept in memory so a test can inspect them.

export interface ElicitationDbStub {
  db: unknown;
  rows: Record<string, unknown>[];
  reset: () => void;
}

const created: ElicitationDbStub[] = [];

/** Empties every stub made in this test file, for a beforeEach. Since the
 * key scan records a reveal the persona did not report, an earlier test's
 * reply can leave rows that a later test would read as already obtained. */
export function resetElicitationDbStubs(): void {
  for (const s of created) s.reset();
}

export function createElicitationDbStub(): ElicitationDbStub {
  const rows: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [...rows] }) }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        const done = Promise.resolve().then(() => {
          rows.push(value);
        });
        return Object.assign(done, {
          onConflictDoNothing: async () => {
            await done;
          },
          returning: async () => {
            await done;
            return [value];
          },
        });
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  const stub = { db, rows, reset: () => void rows.splice(0, rows.length) };
  created.push(stub);
  return stub;
}
