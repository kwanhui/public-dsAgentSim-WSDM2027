import Link from "next/link";
import { auth, signOut } from "@/lib/auth/config";
import { isReviewer, REVIEWER_READ_ONLY_LINE } from "@/lib/auth/roles";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "/admin", label: "Cohorts" },
  { href: "/admin/scenarios", label: "Scenarios" },
  { href: "/admin/compare", label: "Compare" },
];

// The deletion log is for the instructor; the reviewer account gets a 404.
const INSTRUCTOR_NAV = [{ href: "/admin/deletions", label: "Deletions" }];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const nav = session?.user && !isReviewer(session) ? [...NAV, ...INSTRUCTOR_NAV] : NAV;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-4 sm:gap-6">
            <Link
              href="/"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Home
            </Link>
            <div className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
            <Link href="/admin" className="font-semibold tracking-tight">
              {session?.user && isReviewer(session) ? "AgenticPracticum reviewer" : "AgenticPracticum instructor"}
            </Link>
            {session ? (
              <nav aria-label="Admin" className="hidden gap-4 text-sm text-muted-foreground md:flex">
                {nav.map((item) => (
                  <Link key={item.href} href={item.href} className="transition-colors hover:text-foreground">
                    {item.label}
                  </Link>
                ))}
              </nav>
            ) : null}
          </div>
          {session?.user ? (
            <div className="flex items-center gap-3 text-sm">
              {isReviewer(session) ? (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {REVIEWER_READ_ONLY_LINE}
                </span>
              ) : (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  Signed in as{" "}
                  <span className="font-medium text-foreground">{session.user.email}</span>
                </span>
              )}
              {/* Below md the nav links move into this menu, so every admin
                  screen stays reachable on a phone. A native disclosure needs
                  no client script. */}
              <details className="relative md:hidden">
                <summary className="cursor-pointer list-none rounded-md border px-2.5 py-1 text-sm">
                  Menu
                </summary>
                <nav
                  aria-label="Admin"
                  className="absolute right-0 mt-1 flex w-44 flex-col rounded-md border bg-background py-1 text-sm shadow-sm"
                >
                  {[{ href: "/", label: "Home" }, ...nav].map((item) => (
                    <Link key={item.href} href={item.href} className="px-3 py-2 hover:bg-muted">
                      {item.label}
                    </Link>
                  ))}
                </nav>
              </details>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/admin/login" });
                }}
              >
                <Button type="submit" variant="outline" size="sm">
                  Sign out
                </Button>
              </form>
            </div>
          ) : null}
          {session && isReviewer(session) ? (
            <p className="w-full text-xs text-muted-foreground sm:hidden">{REVIEWER_READ_ONLY_LINE}</p>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
