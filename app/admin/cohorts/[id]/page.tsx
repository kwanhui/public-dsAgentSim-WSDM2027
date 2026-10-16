import Link from "next/link";
import { headers } from "next/headers";
import { storedElicitationEvents } from "@/lib/admin/elicitation-rows";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { requireWriter } from "@/lib/auth/guard";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts, cohortInvites, engagements, events, rubricScores, students, submissions } from "@/lib/db/schema";
import { attentionLine, engagementAttention, type EngagementAttention } from "@/lib/admin/attention";
import { markAttentionReviewed, reviewedLine } from "@/lib/admin/attention-review";
import { elicitationRecorded, hiddenFactsLine } from "@/lib/admin/elicitation-recorded";
import { reviewerVisibleInviteRefusal } from "@/lib/cohort/showcase-invites";
import { PendingButton } from "@/components/admin/pending-button";
import { confirmationPhrase } from "@/lib/admin/deletion-phrase";
import { joinRouteOf, JOIN_ROUTE_LABELS } from "@/lib/cohort/join-route";
import { summariseElicitation, FACT_ELICITED_EVENT } from "@/lib/engagement/elicitation";
import { formatUsd, spendReadout } from "@/lib/llm/budget";
import { loadScenario } from "@/lib/scenarios/load";
import { STAGE_TITLES, stageIndex, type StageId } from "@/lib/scenarios/types";
import { createInvite, InviteRefusedError } from "@/lib/cohort/invite";
import { createResumeLink, ResumeRefusedError } from "@/lib/cohort/resume";
import { resolveBaseUrl } from "@/lib/cohort/base-url";
import { formatUtc, plural } from "@/lib/admin/format";
import { cohortCompareHref } from "@/lib/admin/compare-link";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { showcaseLabelsOf } from "@/lib/admin/showcase-protection";
import { isScriptedReplay, RUN_KIND_LABELS } from "@/lib/admin/run-kind";
import { InviteList } from "@/components/admin/invite-list";
import { LearnerList, type ResumeLinkResult } from "@/components/admin/learner-list";
import { MintInviteButton } from "@/components/admin/mint-invite-button";
import { Disclosure } from "@/components/ui/disclosure";
import { StageChip } from "@/components/ui/stage-strip";
import { DeletionReceipt } from "@/components/admin/deletion-receipt";

// Analyst-agent runs create a student row whose learner hash carries this
// prefix. They are demo provenance, not class members.
const AGENT_PREFIX = "agent:";

// Invite and resume URLs have to be absolute, and they are handed to learners
// outside the app, so a wrong origin is a dead link rather than a visible
// error. The rules live in lib/cohort/base-url.ts: AUTH_URL is the override
// for a rewriting proxy, except when it points at localhost and the request
// did not, where the request's own host is the one that works.
async function requestBaseUrl(): Promise<string | null> {
  const h = await headers();
  return resolveBaseUrl({
    configured: process.env.AUTH_URL,
    host: h.get("x-forwarded-host") ?? h.get("host"),
    forwardedProto: h.get("x-forwarded-proto"),
  });
}

export default async function CohortOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ unverified?: string; attention?: string; deleted?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const onlyUnverified = query.unverified === "1";
  const onlyAttention = query.attention === "1";
  const session = await auth();
  if (!session?.user) return null;
  const readOnly = isReviewer(session);

  const [cohort] = await db
    .select({
      id: cohorts.id,
      slug: cohorts.slug,
      name: cohorts.name,
      archivedAt: cohorts.archivedAt,
      configJson: cohorts.configJson,
    })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) notFound();

  const inviteRows = await db
    .select({
      id: cohortInvites.id,
      token: cohortInvites.token,
      expiresAt: cohortInvites.expiresAt,
      usedAt: cohortInvites.usedAt,
      revokedAt: cohortInvites.revokedAt,
      createdAt: cohortInvites.createdAt,
    })
    .from(cohortInvites)
    .where(eq(cohortInvites.cohortId, id))
    .orderBy(desc(cohortInvites.createdAt));

  const studentRows = await db
    .select({
      id: students.id,
      learnerHash: students.learnerHash,
      profileJson: students.profileJson,
      createdAt: students.createdAt,
      lastActiveAt: students.lastActiveAt,
    })
    .from(students)
    .where(eq(students.cohortId, id))
    .orderBy(desc(students.createdAt));

  const engagementRows = await db
    .select({
      id: engagements.id,
      studentId: engagements.studentId,
      scenarioId: engagements.scenarioId,
      currentStage: engagements.currentStage,
      status: engagements.status,
      mode: engagements.mode,
      createdAt: engagements.createdAt,
      elicitationTrace: engagements.elicitationTrace,
      attentionReviewedAt: engagements.attentionReviewedAt,
      attentionReviewedBy: engagements.attentionReviewedBy,
      // Spelled out rather than interpolated: inside the subquery drizzle
      // renders `engagements.id` unqualified, where it would bind to the
      // messages row instead of this engagement.
      lastMessageIso: sql<string | null>`(
        select max(m.timestamp_iso) from messages m where m.engagement_id = "engagements"."id"
      )`,
    })
    .from(engagements)
    .where(eq(engagements.cohortId, id))
    .orderBy(desc(engagements.createdAt));

  // Per-engagement flags for the table: criteria resting on an unverified
  // result (rubric-v5), hidden facts obtained (fact_elicited), and spend.
  const engagementIds = engagementRows.map((e) => e.id);
  const unverifiedRows =
    engagementIds.length === 0
      ? []
      : await db
          .select({ engagementId: rubricScores.engagementId, n: sql<number>`count(*)`.mapWith(Number) })
          .from(rubricScores)
          .where(and(inArray(rubricScores.engagementId, engagementIds), eq(rubricScores.unverifiedClaim, true)))
          .groupBy(rubricScores.engagementId);
  const unverifiedBy = new Map(unverifiedRows.map((r) => [r.engagementId, r.n]));
  const elicitedRows =
    engagementIds.length === 0
      ? []
      : await db
          .select({ engagementId: events.engagementId, type: events.type, detailJson: events.detailJson })
          .from(events)
          .where(and(inArray(events.engagementId, engagementIds), eq(events.type, FACT_ELICITED_EVENT)))
          .then(async (rows) => [...rows, ...(await storedElicitationEvents(engagementIds))]);
  // The persona prompt versions each engagement's turns ran under, which
  // tell a run from before the elicitation trace ("not recorded") from one
  // that obtained nothing (lib/admin/elicitation-recorded.ts).
  const turnVersionRows =
    engagementIds.length === 0
      ? []
      : await db
          .selectDistinct({
            engagementId: events.engagementId,
            promptVersion: sql<string | null>`${events.detailJson} ->> 'promptVersion'`,
          })
          .from(events)
          .where(and(inArray(events.engagementId, engagementIds), eq(events.type, "persona_turn")));
  const recordedFor = (e: (typeof engagementRows)[number]) =>
    elicitationRecorded({
      elicitationTrace: e.elicitationTrace,
      createdAt: e.createdAt,
      events: [
        ...elicitedRows.filter((r) => r.engagementId === e.id),
        ...turnVersionRows
          .filter((r) => r.engagementId === e.id)
          .map((r) => ({ type: "persona_turn", detailJson: { promptVersion: r.promptVersion } })),
      ],
    });
  const scenarioList = await Promise.all(
    [...new Set(engagementRows.map((e) => e.scenarioId))].map((sid) => loadScenario(sid).catch(() => null)),
  );
  const scenarioById = new Map(scenarioList.filter((sc) => sc !== null).map((sc) => [sc.id, sc]));
  const elicitationFor = (e: (typeof engagementRows)[number]) => {
    const sc = scenarioById.get(e.scenarioId);
    if (!sc) return null;
    return summariseElicitation(
      sc,
      elicitedRows.filter((r) => r.engagementId === e.id),
      e.status === "completed" ? null : (e.currentStage as StageId),
    );
  };
  const config = parseCohortConfig(cohort.configJson);
  // Spend, at list prices for the model that served each run, is for the
  // instructor, and for the reviewer account on a cohort flagged
  // reviewer-visible (the showcase), so that its cost figures can be checked.
  const spend =
    readOnly && !config.showcase.reviewerVisible ? null : await spendReadout({ cohortId: id }).catch(() => null);
  const joinRouteByStudent = new Map(studentRows.map((s) => [s.id, joinRouteOf(s.profileJson)]));

  // What needs the instructor's attention in each engagement: the standing
  // total, attempts at the current gate, and the flag events
  // (lib/admin/attention.ts).
  const submissionRows =
    engagementIds.length === 0
      ? []
      : await db
          .select({
            id: submissions.id,
            engagementId: submissions.engagementId,
            stage: submissions.stage,
            status: submissions.status,
            attempt: submissions.attempt,
            assessorDirected: submissions.assessorDirected,
            createdAt: submissions.createdAt,
          })
          .from(submissions)
          .where(inArray(submissions.engagementId, engagementIds))
          .orderBy(asc(submissions.createdAt), asc(submissions.id));
  const scoreRows =
    engagementIds.length === 0
      ? []
      : await db
          .select({
            engagementId: rubricScores.engagementId,
            submissionId: rubricScores.submissionId,
            score: rubricScores.score,
            maxScore: rubricScores.maxScore,
            overrideScore: rubricScores.overrideScore,
            unverifiedClaim: rubricScores.unverifiedClaim,
            createdAt: rubricScores.createdAt,
          })
          .from(rubricScores)
          .where(inArray(rubricScores.engagementId, engagementIds));
  const attentionEventRows =
    engagementIds.length === 0
      ? []
      : await db
          .select({
            engagementId: events.engagementId,
            type: events.type,
            detailJson: events.detailJson,
            timestampIso: events.timestampIso,
          })
          .from(events)
          .where(
            and(
              inArray(events.engagementId, engagementIds),
              inArray(events.type, [
                "persona_failed",
                "submission_scoring_failed",
                "client_reaction_failed",
                "analyst_step_failed",
                "analyst_stage_failed",
                "submission_flagged",
                "persona_consistency",
                "budget_refused",
                "message_cap_reached",
                "submission_scored",
              ]),
            ),
          );
  const attentionBy = new Map<string, EngagementAttention>(
    engagementRows.map((e) => [
      e.id,
      engagementAttention({
        currentStage: e.currentStage,
        status: e.status,
        submissions: submissionRows.filter((r) => r.engagementId === e.id),
        scores: scoreRows.filter((r) => r.engagementId === e.id),
        events: attentionEventRows.filter((r) => r.engagementId === e.id),
        reviewedAt: e.attentionReviewedAt,
      }),
    ]),
  );
  const needsAttention = (e: { id: string }) => (attentionBy.get(e.id)?.flagCount ?? 0) > 0;
  const attentionEngagements = engagementRows.filter(needsAttention).length;
  const unverifiedEngagements = engagementRows.filter((e) => (unverifiedBy.get(e.id) ?? 0) > 0).length;
  const shownEngagements = onlyAttention
    ? engagementRows.filter(needsAttention)
    : onlyUnverified
      ? engagementRows.filter((e) => (unverifiedBy.get(e.id) ?? 0) > 0)
      : engagementRows;

  const baseUrl = await requestBaseUrl();
  const archived = cohort.archivedAt !== null;
  // A cohort the reviewer account can read takes no invites or resume
  // links (lib/cohort/showcase-invites.ts).
  const inviteRefusal = reviewerVisibleInviteRefusal(config);
  // One scenario in the cohort: the Scenario column would repeat it on
  // every row, so the table leaves it out and says it once above.
  const scenarioIds = [...new Set(engagementRows.map((e) => e.scenarioId))];
  const singleScenario = scenarioIds.length === 1 ? (scenarioById.get(scenarioIds[0])?.title ?? scenarioIds[0]) : null;

  async function markReviewed(formData: FormData) {
    "use server";
    await requireWriter();
    const engagementId = String(formData.get("engagementId") ?? "");
    const [owned] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(and(eq(engagements.id, engagementId), eq(engagements.cohortId, id)))
      .limit(1);
    if (!owned) return;
    const current = await auth();
    const reviewer = (current?.user as { email?: string | null; name?: string | null } | undefined)?.email ?? null;
    await markAttentionReviewed(engagementId, reviewer);
    revalidatePath(`/admin/cohorts/${id}`);
  }
  const now = new Date();
  const learners = studentRows.filter((s) => !s.learnerHash.startsWith(AGENT_PREFIX));
  const agentRuns = engagementRows.filter((e) => e.mode === "agent").length;
  // Seats an author script used (H1, the exhibit): counted and labelled
  // apart from learners (lib/admin/run-kind.ts).
  const scriptedStudentIds = new Set(
    engagementRows.filter((e) => isScriptedReplay(config.showcase, e)).map((e) => e.studentId),
  );
  const realLearners = learners.filter((s) => !scriptedStudentIds.has(s.id));
  // Counted as runs, as the cohort list and the analytics count them.
  const replayRuns = engagementRows.filter((e) => isScriptedReplay(config.showcase, e)).length;

  const usableInvites = inviteRows.filter(
    (i) => !i.usedAt && !i.revokedAt && i.expiresAt > now,
  );
  const redeemed = inviteRows.filter((i) => i.usedAt);
  const revoked = inviteRows.filter((i) => !i.usedAt && i.revokedAt);
  const expired = inviteRows.filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt <= now);
  const history = [...redeemed, ...revoked, ...expired].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  async function mintResumeLink(studentId: string): Promise<ResumeLinkResult> {
    "use server";
    await requireWriter();
    const [row] = await db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.cohortId, id)))
      .limit(1);
    if (!row) return { error: "That learner is no longer in this cohort." };
    try {
      return { url: await createResumeLink(studentId, baseUrl) };
    } catch (err) {
      if (err instanceof ResumeRefusedError) return { error: err.message };
      return {
        error: "Could not sign a resume link because the server has no signing secret. See the deployment guide.",
      };
    }
  }

  return (
    <div>
      <DeletionReceipt rows={query.deleted} />
      {cohort.archivedAt ? (
        <p className="mb-6 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          This cohort is archived. Its data is intact and still exportable; it is hidden from
          the cohort list and left out of cross-cohort views. No new invites can be issued and
          outstanding invite links no longer let anyone join, while learners who already joined
          keep their access. Unarchive it under{" "}
          <Link
            href={`/admin/cohorts/${id}/config`}
            className="text-primary underline-offset-4 hover:underline"
          >
            Configuration
          </Link>
          .
        </p>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border p-5">
          <h2 className="text-base font-medium">Learners</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {realLearners.length === 0
              ? replayRuns > 0 || agentRuns > 0
                ? "No learners have joined."
                : "No learners have joined yet."
              : `${plural(realLearners.length, "learner")} joined (pseudonymous).`}
            {replayRuns > 0 || agentRuns > 0
              ? ` Counted apart from learners: ${[
                  replayRuns > 0 ? plural(replayRuns, "author replay") : null,
                  agentRuns > 0 ? plural(agentRuns, "agent run") : null,
                ]
                  .filter(Boolean)
                  .join(", ")}.`
              : ""}
          </p>
          {learners.length > 0 ? (
            <LearnerList
              learners={learners.map((s) => ({
                id: s.id,
                hash: s.learnerHash,
                // A learner who holds a labelled showcase run gets no Delete
                // control; the server refuses it too (lib/admin/deletion.ts).
                deletePhrase: engagementRows.some((e) => e.studentId === s.id && showcaseLabelsOf(cohort.configJson)[e.id])
                  ? undefined
                  : confirmationPhrase("learner", { id: s.id, learnerHash: s.learnerHash }),
                joinedAtIso: s.createdAt.toISOString(),
                lastActiveAtIso: s.lastActiveAt ? s.lastActiveAt.toISOString() : null,
                joinRoute: joinRouteOf(s.profileJson),
                routeLabel: scriptedStudentIds.has(s.id) ? RUN_KIND_LABELS.scripted : undefined,
              }))}
              createResumeLinkAction={readOnly || inviteRefusal ? undefined : mintResumeLink}
              canDelete={!readOnly}
            />
          ) : null}
        </section>

        {/* The read-only reviewer can mint nothing, so the card is left out. */}
        {readOnly ? null : (
        <section className="rounded-lg border p-5">
          <h2 className="text-base font-medium">Invite a learner</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {archived
              ? "This cohort is archived, so no new invite can be issued and the links already out no longer let anyone join."
              : "One-time URL, expires in 30 days. Each link can be redeemed once."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {plural(inviteRows.length, "invite")} issued · {redeemed.length} redeemed ·{" "}
            {archived
              ? `${usableInvites.length} unused (no longer redeemable)`
              : `${usableInvites.length} outstanding`}
            {revoked.length > 0 ? ` · ${revoked.length} revoked` : ""}
            {expired.length > 0 ? ` · ${expired.length} expired` : ""}
          </p>

          {readOnly ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Invite links are not shown to the reviewer account.
            </p>
          ) : inviteRefusal ? (
            <p className="mt-4 text-xs text-muted-foreground">{inviteRefusal}</p>
          ) : archived ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Unarchive this cohort under{" "}
              <Link
                href={`/admin/cohorts/${id}/config`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Configuration
              </Link>{" "}
              to invite learners again.
            </p>
          ) : (
            <>
              <form
                action={async () => {
                  "use server";
                  await requireWriter();
                  // Re-read the archive state: this page may have been sitting
                  // open since before the cohort was closed, and the copy on it
                  // promises that a closed cohort issues no more invites.
                  const [current] = await db
                    .select({ archivedAt: cohorts.archivedAt })
                    .from(cohorts)
                    .where(eq(cohorts.id, id))
                    .limit(1);
                  // createInvite also refuses a cohort the reviewer account
                  // can read; the page already hides the button there.
                  if (!current?.archivedAt) {
                    await createInvite(id).catch((err) => {
                      if (!(err instanceof InviteRefusedError)) throw err;
                    });
                  }
                  revalidatePath(`/admin/cohorts/${id}`);
                }}
                className="mt-4"
              >
                <MintInviteButton>Generate invite link</MintInviteButton>
              </form>

              {baseUrl === null ? (
                <p role="alert" className="mt-4 rounded-md border border-flag/40 bg-flag/5 p-3 text-xs text-flag">
                  Invite links cannot be built because the server does not know its public
                  address. Set the public address in the deployment settings (see the deployment
                  guide) and reload.
                </p>
              ) : (
                <InviteList
                  cohortId={cohort.id}
                  cohortSlug={cohort.slug}
                  baseUrl={baseUrl}
                  invites={usableInvites.map((i) => ({
                    id: i.id,
                    token: i.token,
                    expiresAt: i.expiresAt.toISOString(),
                  }))}
                />
              )}
            </>
          )}

          {history.length > 0 ? (
            <Disclosure
              className="mt-4"
              title={`Invite history (${history.length})`}
              bodyClassName="p-0"
            >
              <ul className="divide-y text-xs">
                {history.map((i) => {
                  const state = i.usedAt
                    ? `Redeemed ${formatUtc(i.usedAt)}`
                    : i.revokedAt
                      ? `Revoked ${formatUtc(i.revokedAt)}`
                      : `Expired ${formatUtc(i.expiresAt)}`;
                  return (
                    <li
                      key={i.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
                    >
                      <span className="truncate font-mono">{i.token.slice(0, 10)}…</span>
                      <span className="shrink-0">{state}</span>
                    </li>
                  );
                })}
              </ul>
            </Disclosure>
          ) : null}
        </section>
        )}
      </div>

      <section className="mt-6 rounded-lg border p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Engagements</h2>
          <span className="flex gap-4 text-sm">
            <Link href={`/admin/cohorts/${id}/agent`} className="text-primary underline-offset-4 hover:underline">
              Analyst agent runs
            </Link>
            {/* The link is scoped to this cohort and, once the cohort has an
                agent run and a human engagement, preselects the furthest of
                each, so the headline comparison is one click from here. */}
            <Link
              href={cohortCompareHref(id, engagementRows, {
                archived,
                pinned: config.showcase.comparePair,
              })}
              className="text-primary underline-offset-4 hover:underline"
            >
              Compare engagements
            </Link>
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {spend
            ? spend.allMock && spend.totalUsd === 0
              ? "Spend so far: USD 0.00 (offline mock). "
              : `Spend so far: ${formatUsd(spend.totalUsd)} at list prices, by the model that served each run. `
            : ""}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {onlyAttention || onlyUnverified ? (
            <Link href={`/admin/cohorts/${id}`} className="text-primary underline-offset-4 hover:underline">
              Show all engagements
            </Link>
          ) : null}
          {attentionEngagements > 0 ? (
            onlyAttention ? null : (
              <Link
                href={`/admin/cohorts/${id}?attention=1`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Show only engagements that need attention ({attentionEngagements})
              </Link>
            )
          ) : (
            <span>No engagement needs attention.</span>
          )}
          {unverifiedEngagements > 0 ? (
            onlyUnverified ? null : (
              <Link
                href={`/admin/cohorts/${id}?unverified=1`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Show only engagements with unverified results ({unverifiedEngagements})
              </Link>
            )
          ) : (
            <span>No unverified results.</span>
          )}
        </p>
        {shownEngagements.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No engagements started yet. Learners pick a scenario when they first open their workspace.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full text-sm">
            {singleScenario ? (
              <caption className="pb-1 text-left text-xs text-muted-foreground">
                Scenario: {singleScenario}. Open an engagement from the Learner column.
              </caption>
            ) : null}
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Learner</th>
                <th className="pb-2 pr-4 font-medium">Joined through</th>
                {singleScenario ? null : <th className="pb-2 pr-4 font-medium">Scenario</th>}
                <th className="pb-2 pr-4 font-medium">Stage</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Total</th>
                <th className="pb-2 pr-4 font-medium">Needs attention</th>
                <th className="pb-2 pr-4 font-medium">Hidden facts</th>
                {spend ? <th className="pb-2 pr-4 text-right font-medium">USD</th> : null}
                <th className="pb-2 pr-4 font-medium">Started</th>
                <th className="pb-2 font-medium">Last active</th>
              </tr>
            </thead>
            <tbody>
              {shownEngagements.map((e) => {
                const learner = studentRows.find((s) => s.id === e.studentId);
                const route = joinRouteByStudent.get(e.studentId) ?? "invite";
                const elicitation = elicitationFor(e);
                const attention = attentionBy.get(e.id);
                const label = config.showcase.labels[e.id];
                const reviewed = reviewedLine(e.attentionReviewedAt, e.attentionReviewedBy);
                const who =
                  e.mode === "agent"
                    ? `analyst agent ${e.id.slice(0, 8)}`
                    : learner
                      ? `${learner.learnerHash.slice(0, 12)}…`
                      : "unknown";
                return (
                  <tr key={e.id} className="border-b align-top last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">
                      {/* The learner cell opens the monitor, so the link is
                          there whether or not the Scenario column is shown. */}
                      <Link
                        href={`/admin/engagements/${e.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {label ? <span className="mr-1.5 font-sans font-medium">{label}</span> : null}
                        {who}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {isScriptedReplay(config.showcase, e) ? RUN_KIND_LABELS.scripted : JOIN_ROUTE_LABELS[route]}
                    </td>
                    {singleScenario ? null : (
                      <td className="py-2 pr-4">{scenarioById.get(e.scenarioId)?.title ?? e.scenarioId}</td>
                    )}
                    <td className="py-2 pr-4">
                      <StageChip
                        id={e.currentStage}
                        title={STAGE_TITLES[e.currentStage as StageId] ?? e.currentStage}
                        index={stageIndex(e.currentStage as StageId)}
                        completed={e.status === "completed"}
                      />
                    </td>
                    <td className="py-2 pr-4">{e.status}</td>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs">
                      {attention?.total ? `${attention.total.score} of ${attention.total.max}` : "not scored"}
                      {attention && attention.attemptsAtCurrentStage > 0 ? (
                        <span className="block font-sans text-muted-foreground">
                          {plural(attention.attemptsAtCurrentStage, "attempt")} at this gate
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {attention && attention.flagCount > 0 ? (
                        <span className="text-flag">{attentionLine(attention.flags)}</span>
                      ) : (
                        <span className="text-muted-foreground">none</span>
                      )}
                      {reviewed ? (
                        <span className="block text-muted-foreground">
                          {reviewed}
                          {attention && attention.flagCount > 0 ? "; new flags since" : ""}
                        </span>
                      ) : null}
                      {!readOnly && attention && attention.flagCount > 0 ? (
                        <form action={markReviewed} className="mt-1">
                          <input type="hidden" name="engagementId" value={e.id} />
                          <PendingButton size="sm" variant="outline">
                            Mark reviewed
                          </PendingButton>
                        </form>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs">
                      {hiddenFactsLine(elicitation, recordedFor(e))}
                    </td>
                    {spend ? (
                      <td className="whitespace-nowrap py-2 pr-4 text-right font-mono text-xs">
                        {formatUsd(spend.byEngagement.get(e.id) ?? 0)}
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap py-2 pr-4 text-xs text-muted-foreground">
                      {formatUtc(e.createdAt)}
                    </td>
                    <td className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                      {e.lastMessageIso ? formatUtc(e.lastMessageIso) : "not yet"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
