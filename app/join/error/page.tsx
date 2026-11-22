import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { joinErrorCopy, SHOWCASE_HINT } from "./copy";

export default async function JoinErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const { title, description, showcaseHint } = joinErrorCopy(reason);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-16">
      <EmptyState
        variant="muted"
        className="mt-16"
        title={title}
        description={description}
        action={
          <Link href="/">
            <Button variant="outline" size="md">
              Return home
            </Button>
          </Link>
        }
      />
      {showcaseHint ? (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {SHOWCASE_HINT.before}
          <Link href={SHOWCASE_HINT.href} className="font-medium text-primary underline underline-offset-4">
            {SHOWCASE_HINT.linkText}
          </Link>
          {SHOWCASE_HINT.after}
        </p>
      ) : null}
    </main>
  );
}
