# Deployment

The supported deployment is Vercel with a Neon Postgres database (Vercel
Postgres). The production database driver is `@vercel/postgres`, which
speaks Neon's protocol, so a hosted deployment needs Neon; the only other
driver is PGlite, an embedded database for the local demo. Hosting on an
institution's own servers with its own Postgres is not supported yet (see the
last section).

## Vercel steps

1. Import the GitHub repo into Vercel (framework preset: Next.js; region:
   `sin1` is already set in `vercel.json`).
2. Add a Postgres (Neon) store and link it to the project; `POSTGRES_URL`
   and friends are injected automatically.
3. Set the remaining environment variables (see `.env.example`):
   - `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`
   - `AUTH_SECRET` (`openssl rand -hex 32`). Leave `AUTH_URL` unset: invite
     and resume links then follow the host each request arrived on, which
     keeps them working on preview deployments. Set it only when a proxy in
     front of the app rewrites the host.
   - `PSEUDONYM_SALT` (`openssl rand -hex 32`, at least 32 characters; rotate
     each term)
   - `CRON_SECRET` (`openssl rand -hex 32`): authenticates the daily
     retention purge wired in `vercel.json`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`: run `pnpm change-admin-password`
     locally to generate and push the bcrypt hash
   - `REVIEWER_PASSWORD_HASH` (optional): `pnpm change-admin-password
     --reviewer`. The reviewer account is off while it is unset, and it sees
     only cohorts with reviewer access turned on in their configuration.
   - `LLM_DAILY_BUDGET_USD`: the daily spend limit in USD over every
     metered model call, as a plain number. Set 10 for the review window;
     the sandbox cohort's own daily limit (`sandbox.dailyBudgetUsd`, 2) sits
     inside it. Without it there is no limit, and sandbox joins are refused.
   - `SANDBOX_COHORT_SLUG` (optional): the cohort that the landing page's
     "Try as a learner" link and the bare `/try` use when more than one
     cohort has open join.
   - `DEMO_CONTACT` (set it when the sandbox is on): an email address or a
     URL for sandbox visitors. The privacy page and the sandbox notice give it
     as the contact for deletion requests. Unset, they point to the paper and
     the repository README instead.
   - Leave `DEMO_MODE` unset. It enables fixed demo logins and is meant for
     the local mock demo only; a deployment refuses to start with it.
4. Run the migrations against the linked database:
   `vercel env pull .env.local && pnpm db:migrate`. Run this again after
   every update that adds a file under `lib/db/migrations/`, before the new
   code serves.
   Configuration keys added since (for example `showcase.reviewerVisible`)
   need no migration: a stored configuration without them reads as the
   default.
5. Smoke-check: `GET /api/health` answers 200 with `demoMode: false` and
   `budgetSet: true`. Sign in at `/admin`, create a throwaway cohort, join it
   through an invite in a private window, run one persona turn and one
   stage-gate submission, then archive the cohort.
6. Showcase and sandbox: restore the showcase cohort with
   `DB_DRIVER=direct npx tsx --env-file=.env.local scripts/showcase-snapshot.ts restore --in demo/showcase-snapshot.json`
   (the restore turns reviewer access on for it; the script reads the
   database variables from the `.env.local` pulled in step 4). Create a separate sandbox
   cohort, tick **Open join** under Configuration, and give the paper and the
   landing page its `/try/<slug>` link. Keep reviewer access off for the
   sandbox and for every course cohort.
   Regenerate the showcase against a local server (`make showcase-regen
   REGEN_LOCAL=1`) and restore the resulting snapshot here. Driving this
   deployment with `BASE_URL` instead needs `SHOWCASE_REGEN=1` in its
   environment for the duration of the run, and the variable removed (with a
   redeploy) straight afterwards; without it the deployment refuses invites
   into the reviewer-visible showcase cohort.
7. Optional full check:
   `PLAYWRIGHT_BASE_URL=https://<deployment> E2E_ADMIN_PASSWORD=... pnpm e2e tests/e2e/engagement-walkthrough.spec.ts`

## Cost controls

- Personas run on `claude-sonnet-5`, the rubric judge on `claude-opus-4-8`;
  both can be pointed at cheaper models through `LLM_PERSONA_MODEL` /
  `LLM_RUBRIC_MODEL` without code changes.
- Chat turns are structured `generateObject` calls with capped history (30
  turns) plus the world-fact ledger, with one retry and one style rewrite at
  most. Consistency audits, gate reactions, the rubric judge and analyst-agent
  runs also call models; all of them, and every failed call whose usage the
  provider reports, are metered and count toward `LLM_DAILY_BUDGET_USD`.
- `LLM_DAILY_BUDGET_USD` stops chat, gate submissions, analyst runs and
  sandbox joins with HTTP 429 once the day's spend (UTC) reaches it. It is
  one limit for the whole deployment. A sandbox cohort also has its own daily
  limit and a lower message cap per seat in its configuration (Sandbox
  section), so anonymous visitors cannot use up the budget that the showcase
  and course cohorts share.
- Spend per cohort and per engagement, computed by the same code as the
  guard (`lib/llm/budget.ts`), is shown to the instructor on the cohort
  overview, the engagement monitor and the compare view, and is in the
  engagements export. `pnpm spend` reads it from a database directory.
- Each engagement has a learner message cap (cohort configuration, default
  200); learners see how many messages remain.
- `RETENTION_DAYS` (default 180) bounds stored transcript volume. The daily
  purge deletes chat messages and events past the window, blanks the text of
  learners' data requests on `data_releases` (keeping its length and
  sha256), deletes sandbox seats older than 30 days with everything under
  them (recorded in the deletion log as "retention purge"), and removes the
  IP address hash from sandbox seats after 30 days. Cohorts whose
  configuration has `showcase.reviewerVisible` on are exempt, so a restored
  showcase keeps its transcripts. Submissions with their scores and grade
  record, the world-fact ledger, `fact_elicitations` and the release records
  are kept until an instructor deletes them.

## Institutional hosting (not supported yet)

The database drivers are Vercel Postgres (Neon) and, for local use, PGlite;
an on-premises Postgres needs a node-postgres driver path that is not in the
code yet. Once that exists, the rest is standard: `pnpm build && pnpm start`
behind a reverse proxy with `AUTH_TRUST_HOST=true` (or `AUTH_URL`) set, and with the `vercel.json` cron replaced by a system cron
calling `GET /api/cron/cleanup` with the `Authorization: Bearer $CRON_SECRET`
header. Do not copy the `pnpm demo` settings to such a server: `DEMO_MODE`
turns on fixed logins.
