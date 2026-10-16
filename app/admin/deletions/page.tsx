import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import { cohortScope, sessionInstructorId } from "@/lib/auth/cohort-scope";
import { isReviewer } from "@/lib/auth/roles";
import { db } from "@/lib/db/client";
import { cohorts, users } from "@/lib/db/schema";
import { allDeletions } from "@/lib/admin/deletion";
import { RETENTION_ACTOR } from "@/lib/logging/retention";
import { deletionRowsLine } from "@/lib/admin/deletion-phrase";
import { formatUtc } from "@/lib/admin/format";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

// The deletion log (lib/admin/deletion.ts): what was deleted, when, by whom,
// and how many rows each table lost. It holds no content, so it answers "was
// this erasure request carried out" without keeping what was erased.
// Instructor only; the reviewer account gets a 404.
export default async function DeletionsPage() {
  const session = await auth();
  if (!session?.user) return null;
  if (isReviewer(session)) notFound();

  // Deletions this instructor made, and deletions in cohorts they own.
  const me = sessionInstructorId(session);
  const owned = new Set(
    (await db.select({ id: cohorts.id }).from(cohorts).where(cohortScope(session))).map((c) => c.id),
  );
  const rows = (await allDeletions()).filter(
    (r) => (me !== null && r.actorId === me) || (r.cohortId !== null && owned.has(r.cohortId)),
  );
  const cohortIds = [...new Set(rows.map((r) => r.cohortId).filter((id): id is string => !!id))].filter((id) =>
    owned.has(id),
  );
  const actorIds = [
    ...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id && id !== RETENTION_ACTOR)),
  ];
  const [cohortRows, actorRows] = await Promise.all([
    cohortIds.length === 0
      ? []
      : db.select({ id: cohorts.id, name: cohorts.name }).from(cohorts).where(inArray(cohorts.id, cohortIds)),
    actorIds.length === 0
      ? []
      : db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(inArray(users.id, actorIds)),
  ]);
  const cohortName = new Map(cohortRows.map((c) => [c.id, c.name]));
  const actorName = new Map(actorRows.map((u) => [u.id, u.email ?? u.name ?? u.id.slice(0, 8)]));

  return (
    <section>
      <PageHeader
        title="Deletions"
        description="Every learner, engagement and cohort deleted on this deployment, with the rows each table lost. No content is kept. Times are UTC."
      />
      {rows.length === 0 ? (
        <EmptyState variant="muted" className="mt-8" title="Nothing has been deleted" description="Deletions made from a cohort's learner list, an engagement monitor or a cohort's configuration are listed here." />
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="pb-2 pr-4 font-medium">When</th>
                <th scope="col" className="pb-2 pr-4 font-medium">What</th>
                <th scope="col" className="pb-2 pr-4 font-medium">Cohort</th>
                <th scope="col" className="pb-2 pr-4 font-medium">By</th>
                <th scope="col" className="pb-2 font-medium">Rows removed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b align-top last:border-0">
                  <td className="whitespace-nowrap py-2 pr-4 text-xs">{formatUtc(r.deletedAt)}</td>
                  <td className="py-2 pr-4 text-xs">
                    {r.kind} <span className="font-mono text-muted-foreground">{r.targetId.slice(0, 8)}</span>
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {r.cohortId ? (cohortName.get(r.cohortId) ?? (
                      <span className="text-muted-foreground">deleted cohort {r.cohortId.slice(0, 8)}</span>
                    )) : "none"}
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {r.actorId === RETENTION_ACTOR
                      ? "retention purge"
                      : r.actorId
                        ? (actorName.get(r.actorId) ?? r.actorId.slice(0, 8))
                        : "not recorded"}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">{deletionRowsLine(r.rowsJson)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
