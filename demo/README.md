# Demo Materials

Demo and deployment materials for AgenticPracticum.

## Walkthrough (5 minutes)

1. Sign in at `/admin`, create a cohort (defaults enable all three
   scenarios), and generate an invite link.
2. Open the invite link in a private window: you land in the learner
   workspace and pick an engagement (customer churn is the reference
   scenario).
3. In **Sarah Tan (Client sponsor)**, ask what decision the work should support.
   Notice she answers scoping questions with specifics (budget, offer
   capacity, the 6-month save rule) but never volunteers them.
4. Open **Stage gate**, read the gate instructions, and submit a problem statement. The
   rubric judge scores it, the stage advances, and Sarah reacts in her
   channel.
5. In **Marcus Wong (Data owner)** (unlocked at data collection), state what data
   you need and why; he releases `churn_extract.csv`, which appears under
   *Data files*. Ask him how the churn label is defined; he knows more than
   the dictionary says.
6. Back in `/admin`: open the engagement from the cohort page to read the
   full transcripts, world-fact ledger, and rubric rationales; open
   *Analytics & export* for the stage funnel and the scores CSV.

## Hosted demo

The system runs in production at **https://agenticpracticum.vercel.app**,
deployed on Vercel in the Singapore region (`sin1`) against a Neon Postgres
database. It is not a mock: personas and the analyst agent run on Claude
Sonnet 5, and the rubric judge and the role-consistency auditor run on Claude
Opus 4.8. Every rubric score row carries the judge model and the prompt
version that produced it.

The paper and the top-level README print the sign-in of the read-only
reviewer account (see *Reviewer account* below), `reviewer` /
`wsdm2027-demo`, which is shared and meant for demonstration only. The
instructor's password is not printed anywhere. Neither password is stored in
any tracked file: the bcrypt hashes live in the Vercel environment, and the
passwords are rotated with `pnpm change-admin-password` (`--reviewer` for the
reviewer account). In the local demo the reviewer login is `reviewer` /
`reviewer`.

### What a reviewer finds

Production carries a curated showcase cohort on the Meridian Mobile churn
scenario, built so that the claims in the paper can be checked in a few
minutes rather than taken on trust. The cohort table labels its runs as the
paper names them (H1 for the human reference run, A1 and on for analyst-agent
runs, and the exhibit). After signing in with the reviewer account:

- **Compare view.** A completed six-stage human run beside a completed
  six-stage analyst-agent run on the same scenario, the same models, and the
  same gate policy. The view is stage-aligned, one row per pipeline stage and
  one row per rubric criterion inside a gate, with a summary strip stating the
  difference in score, messages, stages reached, and elapsed time over the
  stages both runs finished.
- **Engagement monitor.** Full transcripts per persona channel, the world-fact
  ledger, gate submissions, and the judge's per-criterion rationales. The
  cohort also holds a failure exhibit: a fluent data-audit memo that cites a
  row count the released file does not have and ends by asking the grader for
  full marks. The judge scores it on its merits and the monitor shows the
  assessor-directed line in a banner above the submission; the learner's
  revised memo then clears the gate.
- **Scenario library.** Read-only view of the three scenario configs shipped
  with the deployment (churn, segmentation, demand forecasting): personas,
  stage gates, and the rubric each gate is scored against, plus the prompt
  provenance panel showing the exact judge and consistency-audit prompt
  templates and their version strings.
- **Cohort analytics.** Stage funnel, rubric criterion means,
  consistency-audit rate, and CSV export. Invited human
  learners are counted by default; the *Include agent runs* and *Include
  sandbox seats* toggles add the analyst-agent engagements and the sandbox
  visitors, so a reviewer can see which numbers come from which source.

### Reviewer account

Reviewers sign in with the read-only `reviewer` account rather than the
instructor account. It sees only cohorts whose configuration has **Visible
to the read-only reviewer account** turned on (`showcase.reviewerVisible`;
a restored showcase snapshot has it on), with their engagements,
transcripts, analytics and exports. Any other cohort on the deployment, such
as a course cohort or the sandbox, is out of its reach and answers 404. It
cannot change anything: cohort creation and edits, invites and resume links,
score overrides, force-advance, analyst-agent runs and rescoring are refused
with HTTP 403, and the controls are hidden. It sees no spend figures. Set it
up by generating a hash with `pnpm change-admin-password --reviewer` and
setting `REVIEWER_PASSWORD_HASH` (and optionally `REVIEWER_USERNAME`) in the
deployment environment. Under `pnpm demo` the login `reviewer` / `reviewer`
works without a hash.

### Learner sandbox ("Try as a learner")

A reviewer can try the learner side without an invite through a sandbox
cohort. To set one up:

1. As the instructor, create a cohort for the purpose (for example
   "Reviewer sandbox"). Keep it separate from the showcase cohort, so that
   visitors cannot change the exhibits.
2. Under **Configuration**, tick **Open join** in the Sandbox section, and
   set **Sandbox joins per day** (default 50). The same section holds the
   cohort's own daily spend limit (`sandbox.dailyBudgetUsd`) and the message
   cap for each sandbox seat (`sandbox.maxLearnerMessages`), so visitors
   cannot use up the deployment's budget or run long engagements.
3. Save. The documented link is `/try/<cohort-slug>`. The landing page shows
   **Try as a learner** with that link when this is the only cohort with open
   join, or when `SANDBOX_COHORT_SLUG` names it; with two open cohorts and no
   `SANDBOX_COHORT_SLUG` the landing page shows no link, the bare `/try`
   refuses, and the admin pages warn. Each visit from a new browser creates a
   fresh pseudonymous learner and lands them in the workspace; a browser that
   already holds a seat there returns to it.

On the hosted demo the sandbox cohort is "Try the demo", and its link is
https://agenticpracticum.vercel.app/try/try-the-demo-aeme7 (open join, USD 2
a day for the cohort, 40 messages a seat, the churn scenario only, formative
gates, no reviewer access).

The sandbox is off unless a cohort opts in. Joins are refused while
`LLM_DAILY_BUDGET_USD` is unset (except on the offline mock provider), stop
for the rest of the UTC day once the cohort's daily cap or the daily budget
is reached, and are limited to five seats per network each day. Sandbox
learners are marked `profile_json.kind = "sandbox"` in the `students` table,
appear as "Sandbox" in the learner list and in the `join_route` column of
every export, and are left out of analytics by default. Their notice says
that messages are stored on this demo server, and `/privacy` describes what
is stored and for how long.

### Checking the deployment

`GET /api/health` is public and unauthenticated. It returns
`{ ok, db, provider, keyPresent, adminHashSet, reviewerHashSet, authSecretSet,
pseudonymSaltSet, cronSecretSet, demoMode, budgetSet, todaySpendRatio,
lastPurgeAt, version }`. On a deployment it
answers 200 only when the database answers and the provider key,
`ADMIN_PASSWORD_HASH`, `AUTH_SECRET`, `PSEUDONYM_SALT` and `CRON_SECRET` are
all set; otherwise 503 with the failing field still in the body. The reviewer
hash is reported but optional. Under `DEMO_MODE` only the database is
required, and `DEMO_MODE` is refused outright on Vercel (the build and the
server start fail with an error naming it, and health reports 503).
`budgetSet` says whether `LLM_DAILY_BUDGET_USD` holds a limit and
`todaySpendRatio` is today's spend as a share of it (null without a budget). `lastPurgeAt` is when the retention purge (chat messages and event
logs older than `RETENTION_DAYS`) last completed, or null. Every check is a
boolean; no secret is returned. `version` is the short git SHA of the deployed
commit, which is what a bug report should quote.

Before every submission, and again the week reviews open, walk
`scripts/reviewer-path-check.md` by hand in a fresh incognito window.
`pnpm reviewer-path-check` drives the read-only half of it.

- **Video**: linked from the paper
- **Reproducibility**: `demo/deploy.md` has the full deployment steps
- **Restoring the showcase**: `scripts/showcase-snapshot.ts` exports and
  restores one cohort with its primary keys intact. Take the snapshot once
  against production, commit it, and use it whenever the exhibit needs putting
  back:

  ```bash
  pnpm showcase:export  --cohort showcase-meridian-mobile-churn-esagd \
                        --out demo/showcase-snapshot.json
  pnpm showcase:restore --in demo/showcase-snapshot.json --dry-run
  pnpm showcase:restore --in demo/showcase-snapshot.json
  ```

  Restore is destructive by design: it replaces the cohort's rows inside one
  transaction, so read the dry-run summary before pointing it at production.

  The showcase is `showcase-meridian-mobile-churn-esagd`, regenerated on 2026-10-07 and
  committed as the snapshot (tool 142cebb). An earlier regeneration the same day
  (`showcase-meridian-mobile-churn-1f4wn`, tool 46fc939) was discarded because three
  persona replies were delivered as raw JSON. It replaces
  `showcase-meridian-mobile-churn-gx3s8`, the showcase restored to production
  on 2026-09-30; the earlier showcase (`showcase-meridian-mobile-churn-j51tl`)
  is archived. The snapshot was
  exported from a local database, so its serial ids (messages, scores, world
  facts, events) start at 1 and collide with rows already in production. That
  first production restore used a hand-made copy with those ids shifted past
  the production maxima and the message references moved with them. The
  restore now does this itself: when a snapshot id is already taken by
  another cohort's row, it moves that table's ids past the target's maximum,
  carries the message references (`fact_elicitations.message_id`,
  `data_releases.scope_message_id`, and `scopeMessageId` in event details)
  with them, and prints the offsets. UUID keys never move.

## Conventions

- Keep media files small. Large videos go on a hosting platform; commit only thumbnails.
- For double-blind submissions, mirror demo materials to an anonymized location and link from the paper.

## Showcase snapshot

`demo/showcase-snapshot.json` is an export of the curated showcase cohort, and
`scripts/paper-metrics/paper-runs.env` names the runs in it that the paper
reports. `make section5` recomputes the paper's section 5 figures from this
file alone, and `make showcase-regen` rebuilds the cohort on a running server
and exports a new snapshot (see the README). Restore it with `DB_DRIVER=direct pnpm showcase:restore --in demo/showcase-snapshot.json`
if a reviewer mutates the showcase during the review window. The committed copy carries no
learner session rows and has the invite tokens redacted; mint new invites after a restore if
learner links are needed. `DB_DRIVER=direct` makes operator scripts reach Neon over the direct
connection string (`POSTGRES_URL_NON_POOLING`), since the pooled path is not always reachable
outside Vercel.
