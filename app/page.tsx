import { Briefcase, Database, UserRound } from "lucide-react";
import Link from "next/link";
import { StageStrip } from "@/components/ui/stage-strip";
import { findOpenJoinCohort, SANDBOX_JOINS_PER_IP_PER_DAY } from "@/lib/cohort/sandbox";
import { externalLinks } from "@/lib/landing-links";
import { listScenarios } from "@/lib/scenarios/load";
import { STAGE_IDS, STAGE_TITLES } from "@/lib/scenarios/types";

// The "Try as a learner" link depends on the database (whether any cohort is
// open for sandbox joins), so the page renders per request.
export const dynamic = "force-dynamic";

// The configured sandbox cohort's own /try/<slug> link, so the link names
// its cohort and does not move when another cohort opens (lib/cohort/sandbox),
// and the scenarios that cohort offers, so the line names what a visitor gets.
async function sandboxLink(): Promise<{ href: string; scenarios: string[] } | null> {
  try {
    const cohort = await findOpenJoinCohort();
    if (!cohort) return null;
    const allowed = cohort.config.scenarios.allowed;
    const titles = (await listScenarios()).filter((s) => allowed.includes(s.id)).map((s) => s.title);
    return { href: `/try/${encodeURIComponent(cohort.slug)}`, scenarios: titles };
  } catch {
    // An unreachable database hides the link rather than breaking the page.
    return null;
  }
}

// The seat limit is the one the join route applies (per network, per UTC day).
const NO_INVITE = `No invite needed; up to ${SANDBOX_JOINS_PER_IP_PER_DAY} seats per network each day.`;

function sandboxLine(scenarios: string[]): string {
  if (scenarios.length === 1) return `: opens a sandbox seat in one scenario, ${scenarios[0]}. ${NO_INVITE}`;
  if (scenarios.length > 1) return `: opens a sandbox seat where you choose one of ${scenarios.length} scenarios. ${NO_INVITE}`;
  return `: opens a sandbox seat. ${NO_INVITE}`;
}

const roles = [
  { role: "Client sponsor", does: "Owns the business problem and sets the scope.", Icon: Briefcase },
  { role: "Data owner", does: "Releases the data extract once the scope of use is agreed.", Icon: Database },
  { role: "End user", does: "Works with the results and says whether they are usable.", Icon: UserRound },
];

const stages = STAGE_IDS.map((id) => ({ id, title: STAGE_TITLES[id] }));

export default async function Home() {
  const trySandbox = await sandboxLink();
  const links = externalLinks(process.env);
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">AgenticPracticum</h1>
      <p className="mt-3 text-muted-foreground">
        A course tool for practising a data-science engagement from scoping to handover: learners work
        with three simulated stakeholders and submit an artifact at each of six stage gates.
      </p>

      <ul className="mt-6 space-y-2 text-sm">
        {trySandbox ? (
          <li>
            {/* A plain anchor, not next/link: /try is a route handler that
                creates a learner and sets a cookie, so it needs a full
                navigation and must never be prefetched. */}
            <a href={trySandbox.href} rel="nofollow" className="font-medium text-primary underline-offset-4 hover:underline">
              Try as a learner
            </a>
            <span className="text-muted-foreground">{sandboxLine(trySandbox.scenarios)}</span>
          </li>
        ) : null}
        <li>
          <Link href="/admin" className="font-medium text-primary underline-offset-4 hover:underline">
            Instructor or reviewer sign-in
          </Link>
        </li>
        <li>
          <Link href="/workspace" className="text-primary underline-offset-4 hover:underline">
            Continue your engagement
          </Link>
          <span className="text-muted-foreground">: learners join through an invite link from their instructor.</span>
        </li>
        {links.map((l) => (
          <li key={l.href}>
            <a href={l.href} className="text-primary underline-offset-4 hover:underline">
              {l.label}
            </a>
          </li>
        ))}
        <li>
          <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
            Privacy
          </Link>
          <span className="text-muted-foreground">: what is stored, for how long, and how to have it deleted.</span>
        </li>
      </ul>

      <h2 className="mt-10 text-sm font-medium">Stakeholder roles</h2>
      <p className="mt-1 text-xs text-muted-foreground">Each one is played by a language model.</p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-3">
        {roles.map(({ role, does, Icon }) => (
          <li key={role} className="rounded-lg border p-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              {role}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{does}</p>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-sm font-medium">Stage gates</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        A language-model judge scores each artifact against a rubric and returns feedback.
      </p>
      <StageStrip className="mt-4" stages={stages} blurbs wrap />
    </main>
  );
}
