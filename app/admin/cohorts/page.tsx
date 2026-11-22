import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth/config";
import { requireWriter } from "@/lib/auth/guard";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { NEW_COHORT_CONFIG } from "@/lib/cohort/defaults";
import { NewCohortForm, type NewCohortState } from "@/components/admin/new-cohort-form";
import { PageHeader } from "@/components/ui/page-header";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

export default async function NewCohortPage() {
  // The session is read once, here, and the instructor id travels with the
  // action closure below. Reading it again inside the action risked losing a
  // filled-in cohort to a transient session read: the action redirected to
  // the login page and the cohort was silently discarded.
  const session = await auth();
  const instructorId = (session?.user as { id?: string } | undefined)?.id;
  if (!instructorId) redirect("/admin/login?callbackUrl=/admin/cohorts");
  if (isReviewer(session)) redirect("/admin");

  async function createCohort(
    _state: NewCohortState,
    formData: FormData,
  ): Promise<NewCohortState> {
    "use server";
    await requireWriter({ allowMissingSession: true });
    const raw = (formData.get("name") as string | null) ?? "";
    const name = raw.trim();
    if (!name) {
      return { error: "Enter a cohort name (spaces alone are not a name).", name: raw };
    }
    if (name.length < 2) {
      return { error: "Use at least two characters for the cohort name.", name };
    }
    if (name.length > 120) {
      return { error: "Keep the cohort name under 120 characters.", name };
    }

    const base = slugify(name) || "cohort";
    let createdId: string | null = null;
    // The random suffix makes a slug clash unlikely rather than impossible,
    // so retry a couple of times before reporting failure.
    for (let attempt = 0; attempt < 3 && !createdId; attempt++) {
      try {
        const [created] = await db
          .insert(cohorts)
          .values({
            slug: `${base}-${randomSuffix()}`,
            name,
            instructorId: instructorId as string,
            configJson: NEW_COHORT_CONFIG,
          })
          .returning({ id: cohorts.id });
        createdId = created.id;
      } catch {
        // Fall through to another attempt; the last failure is reported below.
      }
    }
    if (!createdId) {
      return {
        error: "The cohort could not be saved. Your name is still here; try again.",
        name,
      };
    }
    redirect(`/admin/cohorts/${createdId}`);
  }

  return (
    <section className="mx-auto max-w-xl">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> Back to cohorts
      </Link>
      <PageHeader
        className="mt-2"
        title="Create a cohort"
        description="A cohort is a class with its own scenarios, stage-gate policy and settings. Learners join through a one-time invite link."
      />
      <NewCohortForm action={createCohort} />
    </section>
  );
}
