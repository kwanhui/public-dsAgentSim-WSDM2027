import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminNotFound() {
  return (
    <EmptyState
      variant="muted"
      className="mt-8"
      title="Not found"
      description="That cohort or engagement does not exist, or it belongs to another instructor account. It may have been deleted since the link was made."
      action={
        <Link href="/admin">
          <Button variant="outline" size="md">
            Back to cohorts
          </Button>
        </Link>
      }
    />
  );
}
