import Link from "next/link";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts, engagements, events } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { isScriptedReplay } from "@/lib/admin/run-kind";
import { BUDGET_REFUSED_EVENT, cohortSpendTodayUsd, sandboxLimitUsd, todaysSpendUsd, utcDayStart } from "@/lib/llm/budget";
import { dailyBudgetUsd } from "@/lib/llm/budget-config";
import { formatUsd } from "@/lib/llm/budget-format";
import { activeProvider } from "@/lib/llm/model-names";
import { plural } from "@/lib/admin/format";
import { formatUtc } from "@/lib/admin/format";
import { listOpenJoinCohorts, openJoinWarning } from "@/lib/cohort/sandbox";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DeletionReceipt } from "@/components/admin/deletion-receipt";

// Learner counts exclude the analyst agent, whose student rows carry an
// `agent:` learner hash, and author replays (lib/admin/run-kind.ts), which
// join through an invite like a learner. Both are counted on their own, as
// the cohort page and the analytics count them, so a demo run never reads
// as a class member.
const AGENT_HASH_PREFIX = "agent:%";

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; deleted?: string }>;
}) {
  const { archived, deleted } = await searchParams;
  const showArchived = archived === "1";

  const session = await auth();
  if (!session?.user) return null;
  const readOnly = isReviewer(session);

  // One query for the whole list: per-cohort counts and last activity come
  // from correlated subqueries rather than a follow-up query per row.
  const rows = await db
    .select({
      id: cohorts.id,
      slug: cohorts.slug,
      name: cohorts.name,
      createdAt: cohorts.createdAt,
      archivedAt: cohorts.archivedAt,
      configJson: cohorts.configJson,
      // The outer column is spelled out rather than interpolated: inside a
      // subquery drizzle renders `cohorts.id` unqualified, where it binds to
      // the subquery's own table instead of this row.
      learners: sql<number>`(
        select count(*) from students s
        where s.cohort_id = "cohorts"."id" and s.learner_hash not like ${AGENT_HASH_PREFIX}
      )`.mapWith(Number),
      engagementCount: sql<number>`(
        select count(*) from engagements e where e.cohort_id = "cohorts"."id" and e.mode = 'human'
      )`.mapWith(Number),
      agentRuns: sql<number>`(
        select count(*) from engagements e where e.cohort_id = "cohorts"."id" and e.mode = 'agent'
      )`.mapWith(Number),
      lastActivityEpoch: sql<number | null>`extract(epoch from greatest(
        (select max(e.created_at) from engagements e where e.cohort_id = "cohorts"."id"),
        (select max(s.last_active_at) from students s where s.cohort_id = "cohorts"."id"),
        (select max(m.timestamp_iso::timestamptz) from messages m
           join engagements e2 on e2.id = m.engagement_id
          where e2.cohort_id = "cohorts"."id")
      ))`,
    })
    .from(cohorts)
    .where(cohortScope(session))
    .orderBy(desc(cohorts.createdAt));

  // Author replays per cohort: their seats and engagements come off the
  // learner counts. Only showcase cohorts can hold them.
  const replayCohorts = rows.filter((r) => {
    const { showcase } = parseCohortConfig(r.configJson);
    return showcase.scriptedReplays.length > 0 || Object.keys(showcase.labels).length > 0;
  });
  const humanRuns =
    replayCohorts.length === 0
      ? []
      : await db
          .select({
            id: engagements.id,
            mode: engagements.mode,
            cohortId: engagements.cohortId,
            studentId: engagements.studentId,
          })
          .from(engagements)
          .where(and(inArray(engagements.cohortId, replayCohorts.map((r) => r.id)), eq(engagements.mode, "human")));
  const replaysBy = new Map<string, { seats: Set<string>; runs: number }>();
  for (const r of replayCohorts) {
    const { showcase } = parseCohortConfig(r.configJson);
    const entry = { seats: new Set<string>(), runs: 0 };
    for (const e of humanRuns) {
      if (e.cohortId !== r.id || !isScriptedReplay(showcase, e)) continue;
      entry.seats.add(e.studentId);
      entry.runs++;
    }
    replaysBy.set(r.id, entry);
  }
  const counted = rows.map((r) => {
    const replays = replaysBy.get(r.id);
    return {
      ...r,
      learners: r.learners - (replays?.seats.size ?? 0),
      engagementCount: r.engagementCount - (replays?.runs ?? 0),
      authorReplays: replays?.runs ?? 0,
    };
  });

  const archivedCount = rows.filter((c) => c.archivedAt !== null).length;
  // Two cohorts with open join leave /try and the landing page without a
  // sandbox cohort unless SANDBOX_COHORT_SLUG names one (lib/cohort/sandbox).
  const joinWarning = readOnly
    ? null
    : openJoinWarning(await listOpenJoinCohorts(), process.env.SANDBOX_COHORT_SLUG);
  const myCohorts = showArchived ? counted : counted.filter((c) => c.archivedAt === null);
  const spend = readOnly ? null : await todaysSpendReadout(rows.map((r) => r.id)).catch(() => null);

  return (
    <section>
      <PageHeader
        title={readOnly ? "Showcase cohort (read-only)" : "Your cohorts"}
        description={
          readOnly
            ? "You can read the transcripts, scores and event logs of the runs in the paper, and set runs side by side in the compare view."
            : "Each cohort is a class with its own scenario set and gate settings. Learners join through one-time invite links."
        }
        action={
          rows.length > 0 && !readOnly ? (
            <Link href="/admin/cohorts">
              <Button variant="primary" size="md">
                + New cohort
              </Button>
            </Link>
          ) : null
        }
      />

      {readOnly && rows.length > 0 ? (
        <p className="mt-4 text-sm">
          Start with{" "}
          <Link href="/admin/compare" className="font-medium text-primary underline-offset-4 hover:underline">
            Compare engagements
          </Link>
          : A1 beside H1.
        </p>
      ) : null}

      {deleted ? (
        <div className="mt-4">
          <DeletionReceipt rows={deleted} />
        </div>
      ) : null}

      {spend ? <TodaysSpend spend={spend} /> : null}

      {joinWarning ? (
        <p role="status" className="mt-4 rounded-md border border-flag/40 bg-flag/5 p-3 text-sm text-flag">
          {joinWarning}
        </p>
      ) : null}

      {archivedCount > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          <Link
            href={showArchived ? "/admin" : "/admin?archived=1"}
            className="text-primary underline-offset-4 hover:underline"
          >
            {showArchived
              ? "Hide archived cohorts"
              : `Show archived cohorts (${archivedCount})`}
          </Link>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          variant="muted"
          className="mt-8"
          title={readOnly ? "No cohorts are shared with the reviewer account" : "No cohorts yet"}
          description={
            readOnly
              ? "The instructor shares a showcase cohort by turning on reviewer access in its configuration."
              : "Create your first cohort to generate learner invite URLs and start running engagements."
          }
          action={
            readOnly ? undefined : (
              <Link href="/admin/cohorts">
                <Button variant="primary" size="md">
                  Create your first cohort
                </Button>
              </Link>
            )
          }
        />
      ) : myCohorts.length === 0 ? (
        <EmptyState
          variant="muted"
          className="mt-8"
          title="Every cohort is archived"
          description="Show archived cohorts to reopen one, or create a new cohort for the coming class."
          action={
            <Link href="/admin?archived=1">
              <Button variant="outline" size="md">
                Show archived cohorts
              </Button>
            </Link>
          }
        />
      ) : (
        <ul className="mt-6 divide-y rounded-lg border">
          {myCohorts.map((c) => (
            <li key={c.id}>
              <Link
                href={`/admin/cohorts/${c.id}`}
                // The row keeps the global focus outline (the muted fill alone
                // is about 1.02:1 against the page, which is not a visible
                // indicator). The outline is drawn inside the row's own box so
                // it does not sit on top of the list border above and below.
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-4 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-offset-[-2px]"
              >
                <div className="min-w-0">
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    /{c.slug}
                  </span>
                  {c.archivedAt ? (
                    <span className="ml-2 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      Archived
                    </span>
                  ) : null}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {c.learners} {c.learners === 1 ? "learner" : "learners"} ·{" "}
                    {c.engagementCount}{" "}
                    {c.engagementCount === 1 ? "learner engagement" : "learner engagements"}
                    {c.authorReplays > 0 ? (
                      <>
                        {" · "}
                        {c.authorReplays} author {c.authorReplays === 1 ? "replay" : "replays"}
                      </>
                    ) : null}
                    {c.agentRuns > 0 ? (
                      <>
                        {" · "}
                        {c.agentRuns} agent {c.agentRuns === 1 ? "run" : "runs"}
                      </>
                    ) : null}
                  </div>
                </div>
                <span className="shrink-0 text-right text-xs text-muted-foreground">
                  <span className="block">
                    {c.lastActivityEpoch
                      ? `Last activity ${formatUtc(new Date(Number(c.lastActivityEpoch) * 1000))}`
                      : "No activity yet"}
                  </span>
                  <span className="block">Created {formatUtc(c.createdAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface SpendToday {
  /** What the day's calls cost at list prices; zero on the offline mock. */
  globalUsd: number;
  /** What the spend guard counts against the limit. The same as globalUsd
   * on a real provider; on the mock it prices tokens as Sonnet 5 so that
   * the limit can be tested. */
  guardUsd: number;
  globalLimit: number | null;
  sandboxes: { id: string; name: string; usd: number; limit: number | null }[];
  refusals: number;
  mock: boolean;
}

// Today's spend against the deployment's daily budget and each sandbox
// cohort's own limit, priced exactly as the spend guard prices it, with the
// number of calls the guard refused today (budget_refused events).
async function todaysSpendReadout(cohortIds: string[]): Promise<SpendToday> {
  const since = utcDayStart();
  const open = (await listOpenJoinCohorts()).filter((c) => cohortIds.includes(c.id));
  const sandboxes = await Promise.all(
    open.map(async (c) => ({
      id: c.id,
      name: c.name,
      usd: await cohortSpendTodayUsd(c.id),
      limit: sandboxLimitUsd(c),
    })),
  );
  const [refused] =
    cohortIds.length === 0
      ? [{ n: 0 }]
      : await db
          .select({ n: sql<number>`count(*)::int` })
          .from(events)
          .where(
            and(
              eq(events.type, BUDGET_REFUSED_EVENT),
              inArray(events.cohortId, cohortIds),
              gte(events.timestampIso, since.toISOString()),
            ),
          );
  const guardUsd = await todaysSpendUsd();
  const mock = activeProvider() === "mock";
  return {
    globalUsd: mock ? 0 : guardUsd,
    guardUsd,
    globalLimit: dailyBudgetUsd(),
    sandboxes,
    refusals: Number(refused?.n ?? 0),
    mock,
  };
}

function TodaysSpend({ spend }: { spend: SpendToday }) {
  const of = (usd: number, limit: number | null) =>
    limit === null ? `${formatUsd(usd)}, no daily limit set` : `${formatUsd(usd)} of ${formatUsd(limit)}`;
  return (
    <section aria-label="Model spend today" className="mt-4 rounded-md border p-3 text-sm">
      <p>
        <span className="font-medium">Model spend today:</span>{" "}
        {spend.mock
          ? `${formatUsd(0)} for the whole deployment (offline mock, which costs nothing).`
          : `${of(spend.globalUsd, spend.globalLimit)} for the whole deployment.`}{" "}
        It resets at 00:00 UTC (08:00 Singapore time).
      </p>
      {spend.mock ? (
        <p className="mt-1 text-muted-foreground">
          To let the limits be tested, the spend guard counts mock tokens at Sonnet 5 list prices:{" "}
          {spend.globalLimit === null
            ? `${formatUsd(spend.guardUsd)} counted today, with no daily limit set.`
            : `${formatUsd(spend.guardUsd)} of ${formatUsd(spend.globalLimit)} counted today.`}{" "}
          Cohort pages and exports price the mock at {formatUsd(0)}.
        </p>
      ) : null}
      {spend.sandboxes.map((s) => (
        <p key={s.id} className="mt-1 text-muted-foreground">
          Sandbox {s.name}: {of(s.usd, s.limit)}, counted apart so visitors cannot use up the course budget.
        </p>
      ))}
      <p className="mt-1 text-xs text-muted-foreground">
        {spend.refusals > 0
          ? `${plural(spend.refusals, "request")} refused today because a limit was reached; each is logged on its engagement.`
          : "No request has been refused today."}

      </p>
    </section>
  );
}
