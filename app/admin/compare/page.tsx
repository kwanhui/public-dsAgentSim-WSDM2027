import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { db } from "@/lib/db/client";
import { cohorts, engagements, students } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { STAGE_IDS, STAGE_TITLES, type StageId } from "@/lib/scenarios/types";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { compareArchivedToggleHref, type PinnedPair } from "@/lib/admin/compare-link";
import { formatUtc, plural } from "@/lib/admin/format";
import { isReviewer } from "@/lib/auth/roles";
import { spendReadout } from "@/lib/llm/budget";
import { labelPrefix, showcaseLabel } from "@/lib/admin/showcase-labels";
import { runKind, type RunKind } from "@/lib/admin/run-kind";
import {
  defaultHuman,
  findEngagement,
  loadSide,
  rowsForCohort,
  rubricTotalsFor,
  type CohortRow,
  type Row,
} from "./side-data";
import { DeltaStrip, HeldConstant } from "./summary";
import { RunCard, StageRow } from "./rows";
import { StageStrip } from "@/components/ui/stage-strip";
import { ChannelComparison } from "./transcripts";

// Side-by-side engagement comparison: typically one human learner and one
// analyst-agent run on the same scenario. The view is stage-aligned (one row
// per pipeline stage holding both runs' work at that stage, one row per
// criterion inside a gate, one row per persona in the transcripts), so the
// two runs stay comparable even after they diverge. A summary strip states
// what the runs held constant and the gap in score, effort, and time.

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string; cohort?: string; archived?: string }>;
}) {
  const { a, b, cohort, archived } = await searchParams;
  const session = await auth();
  if (!session?.user) return null;
  const scope = cohortScope(session);

  const ownCohorts: CohortRow[] = await db
    .select({
      id: cohorts.id,
      name: cohorts.name,
      configJson: cohorts.configJson,
      archivedAt: cohorts.archivedAt,
    })
    .from(cohorts)
    .where(scope);
  const cohortById = new Map(ownCohorts.map((c) => [c.id, c]));

  // Archiving a cohort takes it out of the cross-cohort views, so its
  // engagements are left out of the pickers by default. ?archived=1 adds them
  // back under their "(archived)" labels. A link that names an archived run
  // still opens either way: the run card then says the cohort is archived.
  const includeArchived = archived === "1";
  const activeCohortIds = ownCohorts.filter((c) => c.archivedAt === null).map((c) => c.id);
  const archivedCount = ownCohorts.length - activeCohortIds.length;
  const pickerCohortIds = includeArchived ? ownCohorts.map((c) => c.id) : activeCohortIds;

  // Optional ?cohort= filter for the pickers. An id that is not one of this
  // instructor's cohorts in the pickers falls back to "All cohorts".
  const cohortFilter = cohort && pickerCohortIds.includes(cohort) ? cohort : null;

  const all: Row[] =
    pickerCohortIds.length === 0
      ? []
      : await db
          .select({ engagement: engagements, learnerHash: students.learnerHash })
          .from(engagements)
          .innerJoin(students, eq(students.id, engagements.studentId))
          .where(inArray(engagements.cohortId, pickerCohortIds))
          .orderBy(desc(engagements.createdAt));

  const byId = new Map(all.map((r) => [r.engagement.id, r]));

  // With no run named in the link, open on a cohort's pinned showcase pair
  // (showcase.comparePair in the cohort configuration): the filtered cohort's
  // pair, or else the first active cohort that pins one.
  const pinned = !a && !b ? pinnedDefault(ownCohorts, cohortFilter, byId) : null;
  const leftId = a ?? pinned?.agent;
  const rightId = b ?? pinned?.human;

  const left = leftId ? byId.get(leftId) ?? (await findEngagement(leftId, scope)) : null;
  const chosenRight = rightId
    ? byId.get(rightId) ?? (await findEngagement(rightId, scope))
    : null;
  // A deep link from the analyst-agent page arrives with only ?a= set. Fill
  // the other column with the furthest-advanced human engagement in the same
  // cohort so the comparison is on screen without a second selection.
  const pool = left && !byId.has(left.engagement.id) ? await rowsForCohort(left.engagement.cohortId) : all;
  const pinnedHuman = left
    ? parseCohortConfig(cohortById.get(left.engagement.cohortId)?.configJson).showcase.comparePair?.human ?? null
    : null;
  const autoRight = !rightId && left ? defaultHuman(pool, left, pinnedHuman) : null;
  const right = rightId ? chosenRight : autoRight;

  const missing: string[] = [];
  if (a && !left) missing.push("left");
  if (b && !chosenRight) missing.push("right");

  // Engagements that are on screen but not in the pickers (archived cohorts)
  // are added as their own group, so the selects still show what is displayed.
  const selectRows = new Map(all.map((r) => [r.engagement.id, r]));
  for (const row of [left, right]) {
    if (row) selectRows.set(row.engagement.id, row);
  }
  const rows = [...selectRows.values()].filter(
    (r) => cohortFilter === null || r.engagement.cohortId === cohortFilter,
  );
  const usedCohortIds = new Set(rows.map((r) => r.engagement.cohortId));
  const groups = ownCohorts
    .filter((c) => usedCohortIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.archivedAt ? `${c.name} (archived)` : c.name }));
  const totals = await rubricTotalsFor(rows.map((r) => r.engagement.id));
  // Showcase run labels (A1, H1, exhibit) from each cohort's config.
  const labels = new Map(
    rows.map((r) => [r.engagement.id, showcaseLabel(cohortById.get(r.engagement.cohortId)?.configJson, r.engagement.id)]),
  );
  const kinds = new Map<string, RunKind>(
    rows.map((r) => [
      r.engagement.id,
      runKind(parseCohortConfig(cohortById.get(r.engagement.cohortId)?.configJson).showcase, r.engagement),
    ]),
  );

  // USD per run for the instructor, priced as the daily spend guard prices
  // it; the reviewer sees no spend.
  const spend =
    isReviewer(session) || (!left && !right)
      ? null
      : await spendReadout({
          engagementIds: [left, right].filter((r): r is Row => r !== null).map((r) => r.engagement.id),
        }).catch(() => null);
  const usdFor = (row: Row | null) => (row && spend ? (spend.byEngagement.get(row.engagement.id) ?? 0) : null);
  const leftData = left ? await loadSide(left, cohortById, { usd: usdFor(left) }) : null;
  const rightData = right ? await loadSide(right, cohortById, { usd: usdFor(right) }) : null;

  return (
    <div>
      <PageHeader
        title="Compare engagements"
        description="Two runs of the same scenario, stage by stage, usually a reference or learner run beside an analyst-agent run. Times are UTC."
        back={{ href: "/admin", label: "Back to cohorts" }}
      />

      <form method="get" className="mt-5 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        {includeArchived ? <input type="hidden" name="archived" value="1" /> : null}
        <label className="block text-sm md:col-span-3">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Cohort
          </span>
          <select
            name="cohort"
            defaultValue={cohortFilter ?? ""}
            className="w-full rounded-md border bg-background px-2 py-2 text-sm md:max-w-xs"
          >
            <option value="">All cohorts</option>
            {ownCohorts
              .filter((c) => includeArchived || c.archivedAt === null)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.archivedAt ? `${c.name} (archived)` : c.name}
                </option>
              ))}
          </select>
        </label>
        <EngagementSelect
          name="a"
          label="Left engagement"
          value={left?.engagement.id ?? ""}
          rows={rows}
          groups={groups}
          totals={totals}
          labels={labels}
          kinds={kinds}
        />
        <EngagementSelect
          name="b"
          label="Right engagement"
          value={right?.engagement.id ?? ""}
          rows={rows}
          groups={groups}
          totals={totals}
          labels={labels}
          kinds={kinds}
        />
        <div className="self-end">
          <Button type="submit" variant="outline">
            Compare
          </Button>
        </div>
      </form>

      {archivedCount > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {includeArchived ? (
            <>
              {plural(archivedCount, "archived cohort")} included in these lists, marked
              (archived).{" "}
              <Link
                href={compareArchivedToggleHref({ cohort, a, b }, false)}
                className="text-primary underline underline-offset-2"
              >
                Back to active cohorts only
              </Link>
              .
            </>
          ) : (
            <>
              {plural(archivedCount, "archived cohort")} left out of these lists.{" "}
              <Link
                href={compareArchivedToggleHref({ cohort, a, b }, true)}
                className="text-primary underline underline-offset-2"
              >
                Include archived cohorts&apos; runs
              </Link>
              . A link to an engagement in an archived cohort still opens.
            </>
          )}
        </p>
      ) : null}

      {missing.length > 0 ? (
        <p
          role="status"
          className="mt-4 rounded-md border border-flag/40 bg-flag/5 p-3 text-sm text-flag"
        >
          The {missing.join(" and ")} engagement id in this link matched nothing: that engagement no
          longer exists or belongs to another instructor. Pick one from the list above.
        </p>
      ) : null}

      {pinned ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing the pair pinned in the configuration of {pinned.cohortName}.
        </p>
      ) : autoRight && !rightId ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {autoRight.engagement.id === pinnedHuman
            ? "The right column shows the reference run pinned in the configuration of "
            : "The right column shows the furthest-advanced human engagement in "}
          {cohortById.get(autoRight.engagement.cohortId)?.name ?? "this cohort"}. Choose another
          above to change it.
        </p>
      ) : null}

      {leftData && rightData ? (
        <>
          <HeldConstant left={leftData} right={rightData} />
          <DeltaStrip left={leftData} right={rightData} />
        </>
      ) : null}

      <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
        <RunCard side="Left" data={leftData} />
        <RunCard side="Right" data={rightData} />
      </div>

      {leftData || rightData ? (
        <section className="mt-8" aria-label="Stage-by-stage comparison">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Stage by stage
          </h2>
          <StageStrip
            className="mt-3"
            size="compact"
            wrap
            stages={STAGE_IDS.map((id) => ({ id, title: STAGE_TITLES[id] }))}
            note={
              reachDiffers(leftData, rightData)
                ? (id) => (
                    <ReachedMarks
                      left={leftData?.stages[id as StageId]?.reached}
                      right={rightData?.stages[id as StageId]?.reached}
                    />
                  )
                : undefined
            }
          />
          {reachDiffers(leftData, rightData) ? (
            <p className="mt-2 text-xs text-muted-foreground">L: left run reached, R: right run reached.</p>
          ) : null}
          <div className="mt-3 space-y-3">
            {STAGE_IDS.map((stage) => (
              <StageRow key={stage} stage={stage} left={leftData} right={rightData} />
            ))}
          </div>
        </section>
      ) : null}

      {leftData || rightData ? (
        <section className="mt-8" aria-label="Channel transcripts">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Channel transcripts
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            One row per stakeholder channel; opening a row shows both runs side by side.
          </p>
          <ChannelComparison left={leftData} right={rightData} />
        </section>
      ) : null}
    </div>
  );
}

function pinnedDefault(
  ownCohorts: CohortRow[],
  cohortFilter: string | null,
  byId: Map<string, Row>,
): (PinnedPair & { cohortName: string }) | null {
  const candidates = cohortFilter
    ? ownCohorts.filter((c) => c.id === cohortFilter)
    : ownCohorts.filter((c) => c.archivedAt === null);
  for (const c of candidates) {
    const pair = parseCohortConfig(c.configJson).showcase.comparePair;
    // Both runs must still exist in this cohort for the pin to apply.
    if (
      pair &&
      byId.get(pair.human)?.engagement.cohortId === c.id &&
      byId.get(pair.agent)?.engagement.cohortId === c.id
    ) {
      return { ...pair, cohortName: c.name };
    }
  }
  return null;
}

function EngagementSelect({
  name,
  label,
  value,
  rows,
  groups,
  totals,
  labels,
  kinds,
}: {
  name: string;
  label: string;
  value: string;
  rows: Row[];
  groups: { id: string; name: string }[];
  totals: Map<string, { score: number; max: number }>;
  labels: Map<string, string | null>;
  kinds: Map<string, RunKind>;
}) {
  // With one scenario in the lists the scenario name would only cut the
  // labels short, so it is left out.
  const oneScenario = new Set(rows.map((r) => r.engagement.scenarioId)).size <= 1;
  return (
    <label className="block min-w-0 text-sm">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value}
        className="w-full rounded-md border bg-background px-2 py-2 text-sm"
      >
        <option value="">Choose…</option>
        {groups.map((cohort) => {
          const inCohort = rows.filter((r) => r.engagement.cohortId === cohort.id);
          if (inCohort.length === 0) return null;
          return (
            <optgroup key={cohort.id} label={cohort.name}>
              {inCohort.map((r) => (
                <option key={r.engagement.id} value={r.engagement.id}>
                  {labelPrefix(labels.get(r.engagement.id) ?? null)}
                  {optionLabel(r, totals.get(r.engagement.id) ?? null, kinds.get(r.engagement.id) ?? "learner", oneScenario)}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

// Who, the run's rubric total, and when it started lead the label, so two
// runs can be told apart before the label is cut off at narrow widths. The
// short run id or learner hash identifies each one, as on the run cards.
// Scenario ids read as words in the pickers ("Customer churn").
function humanizeScenario(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function optionLabel(
  row: Row,
  total: { score: number; max: number } | null,
  kind: RunKind,
  oneScenario = false,
): string {
  const e = row.engagement;
  const who =
    kind === "agent"
      ? `Agent ${e.id.slice(0, 8)}`
      : kind === "scripted"
        ? `Scripted replay ${row.learnerHash.slice(0, 8)}`
        : `Learner ${row.learnerHash.slice(0, 8)}`;
  const score = total && total.max > 0 ? `${total.score}/${total.max}` : "unscored";
  const progress =
    e.status === "completed" ? "completed" : (STAGE_TITLES[e.currentStage as StageId] ?? e.currentStage);
  const base = `${who} · ${score} · ${formatUtc(e.createdAt)} · ${progress}`;
  return oneScenario ? base : `${base} · ${humanizeScenario(e.scenarioId)}`;
}

// The L and R marks under the strip carry information only when the two
// runs stopped at different stages, so they are shown only then.
function reachDiffers(
  left: { stages: Partial<Record<StageId, { reached?: boolean }>> } | null | undefined,
  right: { stages: Partial<Record<StageId, { reached?: boolean }>> } | null | undefined,
): boolean {
  return STAGE_IDS.some((id) => left?.stages[id]?.reached !== right?.stages[id]?.reached);
}

// Which side reached a stage, under its node in the strip: "L" and "R",
// struck through in a mid grey (about 3:1 on white) for a side that did not
// reach it.
function ReachedMarks({ left, right }: { left?: boolean; right?: boolean }) {
  const mark = (side: string, on?: boolean) =>
    on === undefined ? null : (
      <span className={on ? "text-primary" : "text-muted-foreground/70 line-through"}>
        {side}
        <span className="sr-only">{on ? " reached" : " not reached"}</span>
      </span>
    );
  return (
    <span className="mt-1 flex gap-1.5 font-mono text-[11px]">
      {mark("L", left)}
      {mark("R", right)}
    </span>
  );
}
