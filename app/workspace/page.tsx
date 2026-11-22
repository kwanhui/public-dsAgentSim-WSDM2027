import Link from "next/link";
import { learnerMessageCap } from "@/lib/cohort/limits";
import { resolveCohortFromRequest } from "@/lib/cohort/resolve";
import { getActiveEngagement, getCohortArchivedAt, getCurrentEngagement } from "@/lib/engagement/state";
import { listScenarios } from "@/lib/scenarios/load";
import { EmptyState } from "@/components/ui/empty-state";
import { demoContact, noticeStorageLine } from "@/app/privacy/provider-line";
import { activeProvider } from "@/lib/llm/model-names";
import { ScenarioPicker } from "@/components/workspace/scenario-picker";
import { WorkspaceClient } from "@/components/workspace/workspace-client";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; engagement?: string }>;
}) {
  const { new: startNew, engagement: engagementId } = await searchParams;
  const cohort = await resolveCohortFromRequest();

  if (!cohort) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <EmptyState
          variant="muted"
          title="No workspace yet"
          description="You need an invite link from your instructor to join a cohort. Open the invite URL they shared with you; it signs you in automatically."
          action={
            <Link href="/" className="text-sm text-primary underline-offset-4 hover:underline">
              Back to home
            </Link>
          }
        />
      </main>
    );
  }

  // Learners see their active engagement, or their latest completed one in
  // review mode. The picker appears when they have none, or when they ask to
  // start a new engagement (?new=1) and have no active one to protect.
  const active = await getActiveEngagement(cohort.studentId);
  const current = active ?? (startNew ? null : await getCurrentEngagement(cohort.studentId));

  if (!current) {
    // A closed cohort takes no new engagements, so the chooser explains
    // rather than offering scenarios that a start attempt would only reject.
    if (await getCohortArchivedAt(cohort.cohortId)) {
      return (
        <main className="mx-auto max-w-md px-6 py-16">
          <EmptyState
            variant="muted"
            title="This cohort has been closed"
            description="This cohort has been closed by the instructor; you can no longer start a new engagement. Existing engagements stay accessible."
            action={
              startNew ? (
                <Link
                  href="/workspace"
                  className="text-sm text-primary underline-offset-4 hover:underline"
                >
                  Back to your engagement
                </Link>
              ) : undefined
            }
          />
        </main>
      );
    }
    const all = await listScenarios();
    const allowed = all.filter((s) => cohort.config.scenarios.allowed.includes(s.id));
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        {/* A sandbox visitor sees "Demo", not the internal cohort name. */}
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          {cohort.joinRoute === "sandbox" ? "Demo" : cohort.cohortName}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Choose your engagement</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          You work on it until handover and cannot switch later.
        </p>
        {cohort.joinRoute === "sandbox" ? (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A demo seat suits one sitting: it holds up to{" "}
            {learnerMessageCap(cohort.config, "sandbox")} messages to the stakeholders.
          </p>
        ) : null}
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The stakeholders in every scenario are simulated by a language model.{" "}
          {noticeStorageLine(activeProvider(), cohort.joinRoute, demoContact())}{" "}
          <Link href="/privacy" className="text-primary underline underline-offset-4">
            Privacy
          </Link>
        </p>
        {startNew ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Your previous engagements stay readable from the workspace, under Your engagements.
          </p>
        ) : null}
        {/* A course's time estimate (weeks) does not describe a demo seat. */}
        <ScenarioPicker scenarios={allowed} showEffort={cohort.joinRoute !== "sandbox"} />
      </main>
    );
  }

  // ?engagement=<id> opens one of the learner's earlier engagements,
  // read-only; the bundle route checks that it is theirs.
  return <WorkspaceClient key={engagementId ?? "current"} engagementId={engagementId} />;
}
