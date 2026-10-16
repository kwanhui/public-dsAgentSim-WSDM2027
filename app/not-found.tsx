import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-16">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> Back to home
      </Link>
      <EmptyState
        variant="muted"
        className="mt-12"
        title="Page not found"
        description="That address does not match anything here. The link may be out of date, or the item it pointed to may have been removed."
        action={
          <Link href="/">
            <Button variant="outline" size="md">
              Return home
            </Button>
          </Link>
        }
      />
    </main>
  );
}
