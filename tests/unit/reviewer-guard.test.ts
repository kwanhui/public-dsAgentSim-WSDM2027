// Every way the admin side can change state must refuse the read-only
// reviewer. Two layers are checked here:
//
// 1. A source scan of app/: every server action ("use server") calls
//    requireWriter() first, and every route handler that exports a mutating
//    method calls rejectReadOnly(). A new action or route that forgets the
//    guard fails this test rather than shipping silently.
// 2. The known mutating route handlers, called with a reviewer session,
//    answer 403 without touching the database.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sources = walk(APP)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: relative(ROOT, f), text: readFileSync(f, "utf8") }));

// Server actions that do not change application state and are open to any
// session: signing in and signing out.
const ACTION_ALLOWLIST: Record<string, number> = {
  "app/admin/layout.tsx": 1,
  "app/admin/login/page.tsx": 1,
};

// Mutating route handlers outside the instructor's admin area. Learner
// routes authenticate by the learner cookie, not the admin session; the
// sandbox join is public by design (and guarded by the cohort flag, the
// daily cap and the spend guard).
const LEARNER_OR_PUBLIC_ROUTES = new Set([
  "app/api/chat/route.ts",
  "app/api/engagement/route.ts",
  "app/api/engagement/checkin/route.ts",
  "app/api/engagement/signout/route.ts",
  "app/api/engagement/submit/route.ts",
  "app/try/route.ts",
  "app/try/[slug]/route.ts",
]);

// The mutating admin routes this test knows about. The scan below must find
// exactly these, so adding one means adding it here (and to the 403 checks).
const EXPECTED_ADMIN_MUTATING_ROUTES = [
  "app/api/admin/cohorts/[id]/agent-runs/route.ts",
  "app/api/admin/cohorts/[id]/invites/[inviteId]/route.ts",
  "app/api/admin/cohorts/[id]/route.ts",
  "app/api/admin/deletions/route.ts",
];

describe("server actions", () => {
  const withActions = sources.filter((s) => s.text.includes('"use server"'));

  it("finds the admin server actions", () => {
    expect(withActions.length).toBeGreaterThanOrEqual(6);
  });

  it.each(withActions.map((s) => [s.file, s.text] as const))(
    "%s: every action calls requireWriter() first",
    (file, text) => {
      const lines = text.split("\n");
      let unguarded = 0;
      lines.forEach((line, i) => {
        if (!line.includes('"use server"')) return;
        // The guard must be the first statement of the action body.
        const next = lines.slice(i + 1, i + 3).join("\n");
        if (!/await requireWriter\(/.test(next)) unguarded++;
      });
      expect(unguarded).toBe(ACTION_ALLOWLIST[file] ?? 0);
    },
  );
});

describe("mutating route handlers", () => {
  const routes = sources.filter(
    (s) =>
      s.file.endsWith("route.ts") &&
      /export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(s.text),
  );
  const adminRoutes = routes.filter((s) => !LEARNER_OR_PUBLIC_ROUTES.has(s.file));

  it("are all known: learner, public, or listed admin routes", () => {
    expect(adminRoutes.map((r) => r.file).sort()).toEqual(EXPECTED_ADMIN_MUTATING_ROUTES);
  });

  it.each(adminRoutes.map((s) => [s.file, s.text] as const))(
    "%s calls rejectReadOnly()",
    (_file, text) => {
      const handlers = text.match(/export (async )?function (POST|PUT|PATCH|DELETE)\b/g) ?? [];
      const guards = text.match(/rejectReadOnly\(session\)/g) ?? [];
      expect(guards.length).toBeGreaterThanOrEqual(handlers.length);
    },
  );
});

// ---------------------------------------------------------------------------
// Behaviour: a reviewer session gets 403 and the database is never touched.
// ---------------------------------------------------------------------------

const dbTouched = vi.fn();
let session: unknown = null;

vi.mock("@/lib/auth/config", () => ({ auth: async () => session }));
vi.mock("@/lib/db/client", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        dbTouched();
        throw new Error("database touched");
      },
    },
  ),
}));
vi.mock("@/lib/scenarios/load", () => ({ listScenarios: async () => [] }));

const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

const ROUTE_CALLS: [string, () => Promise<Response>][] = [
  [
    "PATCH cohort config",
    async () => {
      const { PATCH } = await import("@/app/api/admin/cohorts/[id]/route");
      return PATCH(
        new Request("http://x/api/admin/cohorts/c1", { method: "PATCH", body: "{}" }),
        params({ id: "c1" }),
      );
    },
  ],
  [
    "POST agent run",
    async () => {
      const { POST } = await import("@/app/api/admin/cohorts/[id]/agent-runs/route");
      return POST(
        new Request("http://x/api/admin/cohorts/c1/agent-runs", {
          method: "POST",
          body: JSON.stringify({ analystModel: "claude-haiku-4-5" }),
        }),
        params({ id: "c1" }),
      );
    },
  ],
  [
    "DELETE invite",
    async () => {
      const { DELETE } = await import("@/app/api/admin/cohorts/[id]/invites/[inviteId]/route");
      return DELETE(new Request("http://x", { method: "DELETE" }), params({ id: "c1", inviteId: "i1" }));
    },
  ],
  [
    "POST deletion",
    async () => {
      const { POST } = await import("@/app/api/admin/deletions/route");
      return POST(
        new Request("http://x/api/admin/deletions", {
          method: "POST",
          body: JSON.stringify({ kind: "cohort", id: "c1", confirm: "c1" }),
        }),
      );
    },
  ],
];

describe("reviewer session on the mutating admin routes", () => {
  beforeEach(() => {
    dbTouched.mockClear();
  });

  it("covers every mutating admin route", () => {
    expect(ROUTE_CALLS.length).toBe(EXPECTED_ADMIN_MUTATING_ROUTES.length);
  });

  it.each(ROUTE_CALLS)("%s answers 403 for a reviewer", async (_name, call) => {
    session = { user: { id: "admin", role: "reviewer" } };
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "read-only" });
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it.each(ROUTE_CALLS)("%s answers 401 when signed out", async (_name, call) => {
    session = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(dbTouched).not.toHaveBeenCalled();
  });
});
