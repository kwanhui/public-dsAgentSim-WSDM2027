import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope } from "@/lib/auth/cohort-scope";
import { db } from "@/lib/db/client";
import { cohorts } from "@/lib/db/schema";
import { CohortTabs } from "@/components/admin/cohort-tabs";
import { PageHeader } from "@/components/ui/page-header";

export default async function CohortLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return null;

  const [cohort] = await db
    .select({ id: cohorts.id, name: cohorts.name, slug: cohorts.slug })
    .from(cohorts)
    .where(and(eq(cohorts.id, id), cohortScope(session)))
    .limit(1);
  if (!cohort) notFound();

  return (
    <div>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> Back to cohorts
      </Link>
      <PageHeader className="mt-2" title={cohort.name} description={`/${cohort.slug}`} />
      <CohortTabs cohortId={cohort.id} />
      <div className="mt-6">{children}</div>
    </div>
  );
}
