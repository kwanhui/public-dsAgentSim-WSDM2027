import Link from "next/link";
import { DeleteConfirm } from "@/components/admin/delete-confirm";
import { confirmationPhrase } from "@/lib/admin/deletion-phrase";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { requireWriter } from "@/lib/auth/guard";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { parseCohortConfig } from "@/lib/cohort/defaults";
import { configVersion } from "@/lib/cohort/config-version";
import {
  activeProvider,
  personaModelName,
  providerAcceptsTemperature,
  rubricModelName,
} from "@/lib/llm/client";
import { CONSISTENCY_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "@/lib/agents/prompt-provenance";
import { listScenarios } from "@/lib/scenarios/load";
import { listOpenJoinCohorts, openJoinWarning } from "@/lib/cohort/sandbox";
import { CohortConfigForm } from "@/components/admin/cohort-config-form";
import { CohortRenameForm, type RenameState } from "@/components/admin/cohort-rename-form";
import { ActionSubmitButton } from "@/components/admin/mint-invite-button";

export default async function CohortConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return null;
  const readOnly = isReviewer(session);

  const [cohort] = await db
    .select({
      id: cohorts.id,
      name: cohorts.name,
      slug: cohorts.slug,
      configJson: cohorts.configJson,
      archivedAt: cohorts.archivedAt,
    })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) notFound();

  const initialConfig = parseCohortConfig(cohort.configJson);
  const scenarios = await listScenarios();
  const archived = cohort.archivedAt !== null;
  // Warn when this cohort is one of several with open join: the bare /try
  // link and the landing page then need SANDBOX_COHORT_SLUG to pick one.
  const openCohorts = readOnly ? [] : await listOpenJoinCohorts();
  const joinWarning = openCohorts.some((c) => c.id === cohort.id)
    ? openJoinWarning(openCohorts, process.env.SANDBOX_COHORT_SLUG)
    : null;

  async function rename(_state: RenameState, formData: FormData): Promise<RenameState> {
    "use server";
    await requireWriter();
    const raw = (formData.get("name") as string | null) ?? "";
    const name = raw.trim();
    if (!name) return { error: "Enter a cohort name (spaces alone are not a name)." };
    if (name.length < 2) return { error: "Use at least two characters for the cohort name." };
    if (name.length > 120) return { error: "Keep the cohort name under 120 characters." };
    await db.update(cohorts).set({ name }).where(eq(cohorts.id, id));
    revalidatePath(`/admin/cohorts/${id}`);
    revalidatePath("/admin");
    return { renamed: name };
  }

  async function setArchived(formData: FormData) {
    "use server";
    await requireWriter();
    const archive = formData.get("archive") === "1";
    await db
      .update(cohorts)
      .set({ archivedAt: archive ? new Date() : null })
      .where(eq(cohorts.id, id));
    revalidatePath(`/admin/cohorts/${id}`);
    revalidatePath("/admin");
  }

  return (
    <div>
      <section className="rounded-lg border p-5">
        <h2 className="text-base font-medium">Cohort</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The name is what you see in the cohort list. The join slug{" "}
          <code className="font-mono text-xs">/{cohort.slug}</code> never changes, so invite
          URLs already handed out keep working.
        </p>
        {readOnly ? null : <CohortRenameForm currentName={cohort.name} action={rename} />}

        <div className="mt-5 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            {archived
              ? "This cohort is archived: hidden from the cohort list and left out of cross-cohort views. Every engagement, score, and export is still here."
              : "Archiving a finished class hides it from the cohort list and leaves it out of cross-cohort views. Nothing is deleted, and you can unarchive it at any time. To remove the data, delete the cohort below."}
          </p>
          {readOnly ? null : (
            <form action={setArchived} className="mt-3">
              <input type="hidden" name="archive" value={archived ? "0" : "1"} />
              <ActionSubmitButton variant="outline">
                {archived ? "Unarchive cohort" : "Archive cohort"}
              </ActionSubmitButton>
            </form>
          )}
        </div>

        {readOnly ? null : (
          <div className="mt-5 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Deleting the cohort removes its invites, learners and every engagement in it, at once.
              A record that the deletion happened is kept, with row counts and no content.
            </p>
            <div className="mt-3">
              <DeleteConfirm
                kind="cohort"
                id={cohort.id}
                phrase={confirmationPhrase("cohort", cohort)}
                buttonLabel="Delete cohort"
                redirectTo="/admin"
              />
            </div>
          </div>
        )}
      </section>

      <p className="mb-2 mt-8 text-sm text-muted-foreground">
        Changes apply on save and take effect from the learner&apos;s next action.
      </p>
      <p className="mb-6 text-sm text-muted-foreground">
        The models below run the versioned assessment prompts{" "}
        <code className="text-xs">{RUBRIC_PROMPT_VERSION}</code> and{" "}
        <code className="text-xs">{CONSISTENCY_PROMPT_VERSION}</code>; their literal text is
        viewable under{" "}
        <Link href="/admin/scenarios#prompt-provenance" className="text-primary hover:underline">
          Prompt provenance
        </Link>{" "}
        in the scenario library.
      </p>
      <CohortConfigForm
        cohortId={cohort.id}
        initialConfig={initialConfig}
        initialVersion={configVersion(cohort.configJson)}
        availableScenarios={scenarios.map((s) => ({ id: s.id, title: s.title }))}
        readOnly={readOnly}
        openJoinWarning={joinWarning}
        models={{
          provider: activeProvider(),
          personaModel: personaModelName(),
          rubricModel: rubricModelName(),
          acceptsTemperature: providerAcceptsTemperature(activeProvider()),
        }}
      />
    </div>
  );
}
