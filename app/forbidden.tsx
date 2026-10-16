import Link from "next/link";

// Rendered with HTTP 403 when a server action or page calls forbidden(),
// which the admin side does for the read-only reviewer account.
export default function Forbidden() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-xl font-semibold">Read-only account</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The reviewer account can view cohorts, engagements and exports but cannot change them.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/admin" className="text-primary underline-offset-4 hover:underline">
          Back to cohorts
        </Link>
      </p>
    </main>
  );
}
