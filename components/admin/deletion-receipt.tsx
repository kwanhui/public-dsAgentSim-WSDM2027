// The line an admin page shows after a deletion redirected to it: the row
// counts the deletion removed (carried in ?deleted=, counts only) and where
// the record of it is kept.
import Link from "next/link";

export function DeletionReceipt({ rows }: { rows?: string }) {
  if (!rows) return null;
  // Only the "table n, table n" shape deletionRowsLine writes is shown.
  if (!/^(no rows|[a-z ]+ \d+(, [a-z ]+ \d+)*)$/.test(rows)) return null;
  return (
    <p role="status" className="mb-6 rounded-md border bg-muted/40 px-4 py-3 text-sm">
      Deleted. Rows removed: {rows}. The deletion is recorded under{" "}
      <Link href="/admin/deletions" className="text-primary underline-offset-4 hover:underline">
        Deletions
      </Link>
      .
    </p>
  );
}
