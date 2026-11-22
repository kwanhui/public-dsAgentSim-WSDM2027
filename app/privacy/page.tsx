import Link from "next/link";
import { activeProvider } from "@/lib/llm/model-names";
import { ADDRESS_HASH_RETENTION_DAYS, SANDBOX_RETENTION_DAYS, retentionDays } from "@/lib/logging/retention";
import { auth } from "@/lib/auth/config";
import { resolveCohortFromRequest } from "@/lib/cohort/resolve";
import { demoContact, demoContactLine, providerLine } from "./provider-line";

// The provider and the retention window come from the deployment's
// environment, so the page renders per request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Privacy · AgenticPracticum" };

// Where "Back" goes: a learner to their workspace, a signed-in instructor or
// reviewer to the admin pages, anyone else to the start page.
async function backLink(isLearner: boolean): Promise<{ href: string; label: string }> {
  if (isLearner) return { href: "/workspace", label: "Back to your workspace" };
  const session = await auth().catch(() => null);
  if (session?.user) return { href: "/admin", label: "Back to the admin pages" };
  return { href: "/", label: "Back to the start page" };
}

export default async function PrivacyPage() {
  const days = retentionDays();
  const learner = await resolveCohortFromRequest().catch(() => null);
  const back = await backLink(learner !== null);
  const contact = demoContactLine(demoContact());
  // Research questions are described only to a learner whose cohort has
  // turned them on; they are off everywhere else.
  const research = learner?.config.research;
  const researchOn = Boolean(research?.checkins || research?.reflections);
  const items: { term: string; detail: React.ReactNode }[] = [
    { term: "Model provider", detail: providerLine(activeProvider()) },
    {
      term: "What is stored",
      detail: (
        <ul className="list-disc space-y-1 pl-5">
          <li>A pseudonymous learner id, when you joined and when you were last active, and a session token in a cookie. No name or email address is collected.</li>
          <li>Your chat messages, and the event log of your engagement with token counts.</li>
          <li>Your stage submissions with their rubric scores and rationales, the attempt number, the gate result, and any note the judge made about a result it could not check or about text addressed to the assessor.</li>
          <li>The record of facts established in your engagement, and which hidden facts you obtained and at which message.</li>
          <li>For each data file the data owner released to you, the file, the stage, and the text of your request that met the release rule.</li>
          <li>If you joined through Try as a learner, a salted hash of your IP address, used only to limit how many seats one address can take in a day.</li>
        </ul>
      ),
    },
    {
      term: "How long",
      detail: (
        <ul className="list-disc space-y-1 pl-5">
          <li>Chat messages, event logs and the text of your data requests are deleted {days} days after they were written, by a daily purge.</li>
          <li>Kept after {days} days, until your instructor deletes them: your submissions with their scores and grade record, the record of established facts, the record of which hidden facts you obtained, and the record of each data release without the text of your request.</li>
          <li>A seat taken through Try as a learner is deleted with everything stored under it {SANDBOX_RETENTION_DAYS} days after it was created. Its IP address hash goes after {ADDRESS_HASH_RETENTION_DAYS} days.</li>
          <li>The curated showcase runs that reviewers are shown are exempt from the purge. They were produced by the authors and an analyst agent, not by learners.</li>
        </ul>
      ),
    },
    {
      term: "Scoring",
      detail:
        "A language model scores each stage submission against the stage rubric. In a course cohort the scores are the judge's until your instructor reviews them: the instructor can see every score and override it, and may check results that the platform cannot verify. No instructor reviews scores in the demo sandbox.",
    },
    {
      term: "Research use",
      detail: researchOn
        ? "Your instructor has turned on additional research questions for this cohort, and the workspace invites you to answer them. Your answers are stored with your engagement and deleted with it."
        : "None. Nothing beyond what is listed above is collected.",
    },
    {
      term: "Deletion",
      detail:
        "Your instructor can delete your learner id with everything stored under it, a single engagement, or the whole cohort. Ask them, quoting the learner id shown after “Signed in as” in the workspace header. The rows are removed at once, not at the next purge. The platform keeps a record that a deletion happened, with the number of rows removed and no content.",
    },
    {
      term: "Demo sandbox",
      detail: `If you joined through Try as a learner, your engagement is stored on this demo server, where the demo authors can read it, and it is deleted automatically ${SANDBOX_RETENTION_DAYS} days after you joined. To have it deleted sooner, contact the demo authors and quote your learner id. ${contact ?? "Their contact details are in the paper and in the repository README."}`,
    },
  ];
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-3 text-muted-foreground">
        What happens to what you write in an AgenticPracticum engagement.
      </p>
      <dl className="mt-6 space-y-5 text-sm">
        {items.map((item) => (
          <div key={item.term}>
            <dt className="font-medium">{item.term}</dt>
            <dd className="mt-1 text-muted-foreground">{item.detail}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 text-sm">
        <Link href={back.href} className="text-primary underline-offset-4 hover:underline">
          {back.label}
        </Link>
      </p>
    </main>
  );
}
