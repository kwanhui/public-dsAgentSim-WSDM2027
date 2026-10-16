# AgenticPracticum

> **Status:** public snapshot of the system submitted to the WSDM 2027 Demonstrations Track (under review).
>
> **Demonstration video:** <https://youtu.be/vfHl-Ba-PZI> (2:48).
>
> **Hosted demo:** <https://agenticpracticum.vercel.app>, read-only reviewer sign-in `reviewer` / `wsdm2027-demo`.

## Overview

AgenticPracticum is a course tool in which learners practise a complete
data-science engagement, from scoping to handover. Language-model personas play
the three external parties a working data scientist deals with (the client
sponsor, the data owner, and the end user) across a six-stage pipeline: problem
formulation, data collection, data cleaning, modelling, testing, and deployment
and handover. Learners do the actual analysis in their own tools (Jupyter, Excel),
then negotiate scope, request data, and defend results inside the platform. At
each stage gate they submit an artifact; a rubric judge scores it and the
client reacts in character.

Scenarios are tuned to the SUSS BSc Business Analytics curriculum: customer
churn, customer segmentation, and demand forecasting. An instructor view
manages cohorts, invites, and rubric analytics.

## Companion paper

The system is described in the paper "AgenticPracticum: A Multi-Agent LLM
Testbed for Practising End-to-End Data-Science Engagements", by Kwan Hui Lim,
Carmen Kar Hang Lee, Vanessa Liu and Yongqing Zhu, which has been submitted to
the WSDM 2027 Demonstrations Track. The source code is at
[`public-dsAgentSim-WSDM2027`](https://github.com/kwanhui/public-dsAgentSim-WSDM2027),
and the demo video is at <https://youtu.be/vfHl-Ba-PZI>.

## Hosted demo

The system runs at https://agenticpracticum.vercel.app on real models. Sign in
with the reviewer account, username `reviewer` and password `wsdm2027-demo`.
This account is shared and read-only, is meant for demonstration only, and
makes no model calls. Anyone who deploys their own instance sets their own
reviewer password with `pnpm change-admin-password --reviewer`. The reviewer
sees the showcase cohort (`showcase-meridian-mobile-churn-esagd`) and nothing
else. The "Try as a learner" link on the landing page,
https://agenticpracticum.vercel.app/try/try-the-demo-aeme7, starts an
engagement without an account. The sandbox allows five seats per
network each day and 40 messages per seat, within a USD 2 daily budget.

The hosted demo runs the code in this repository. Its `/api/health` reports
version `7f0a17a`, a commit in the authors' development history whose
application code is the same as the tagged snapshot here
(`wsdm2027-submission`); the commits after the tag change documentation only,
apart from one punctuation mark in a historical prompt text listed on
`/admin/scenarios`. The scenarios, the showcase snapshot, the sandbox limits
and the reviewer account all come from the files in this repository and the
settings in [Run your own copy](#run-your-own-copy).

## Documentation

- [docs/architecture.md](docs/architecture.md): components, data flow, agents,
  privacy and retention.
- [demo/deploy.md](demo/deploy.md): deploying to Vercel and Neon.
- [demo/README.md](demo/README.md): the walkthrough, the reviewer account, the
  learner sandbox and the health endpoint.
- [scripts/reviewer-path-check.md](scripts/reviewer-path-check.md): the
  checklist for the reviewer path.

## Run your own copy

This section takes a fresh clone to a running copy of the system, first on
your own machine with the offline mock model and then on your own Vercel
project with real models. The hosted demo at
https://agenticpracticum.vercel.app was set up with the same steps.

### 1. Prerequisites

- Node.js 20 or later and pnpm 9 (`corepack enable` gives the pinned
  pnpm 9.12.0).
- Git. Python 3 only for `make section5`, and `openssl` (or any other
  source of random hex) for the secrets below.
- For a real deployment: a Vercel account, a Neon Postgres database (added
  from the Vercel Marketplace), and an Anthropic or OpenAI API key.

```bash
git clone https://github.com/kwanhui/public-dsAgentSim-WSDM2027.git
cd public-dsAgentSim-WSDM2027
pnpm install
pnpm typecheck && pnpm test   # optional checks
```

### 2. Local demo in mock mode (no setup)

```bash
make demo            # empty demo database; open http://localhost:3000
make demo-showcase   # the same, with the showcase cohort of the paper restored
```

Both targets run without an env file, API key or database server. They apply
the migrations to an embedded PGlite database under `.pglite/` (set
`PGLITE_DIR` to use another directory), set `DEMO_MODE=1` and
`LLM_PROVIDER=mock`, and start `next dev`. The mock provider returns canned
persona replies and rubric scores, which still drive the full loop (scoping,
data release, stage gates, scores) without any model call. Set `PORT` to use
another port; sign-in follows it.

`make demo-showcase` also restores `demo/showcase-snapshot.json`, the cohort
`showcase-meridian-mobile-churn-esagd` that holds the runs H1, A1, A2 and the
exhibit of the paper's Table 2. It replaces that cohort's rows on every run.

Demo mode has fixed logins at `/admin`: `admin` / `demo` for the instructor
and `reviewer` / `reviewer` for the read-only reviewer account. The reviewer
sees the showcase cohort and nothing else. To try the "Try as a learner"
link, sign in as `admin`, create a cohort, open its **Configuration** page,
tick **Open join** in the Sandbox section and save; the landing page then
shows **Try as a learner**, which links to `/try/<cohort-slug>`.

`GET http://localhost:3000/api/health` answers with `"ok":true`,
`"provider":"mock"` and `"demoMode":true`.

### 3. Environment variables

For anything other than the demo targets, copy the template and fill it in:

```bash
cp .env.example .env.local
```

`.env.example` describes every variable. On a deployment these are required,
and `/api/health` answers 503 until each is set:

| Variable | Value |
| --- | --- |
| `LLM_PROVIDER` | `anthropic` or `openai` (`mock` for offline tests) |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | the key for that provider |
| `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING` | set by the Neon integration on Vercel |
| `AUTH_SECRET` | `openssl rand -hex 32` |
| `PSEUDONYM_SALT` | `openssl rand -hex 32` (at least 32 characters) |
| `CRON_SECRET` | `openssl rand -hex 32`; authenticates the daily purge |
| `ADMIN_PASSWORD_HASH` | from `pnpm change-admin-password` |

These are optional:

| Variable | Effect |
| --- | --- |
| `LLM_DAILY_BUDGET_USD` | daily spend limit over all model calls; set it on every deployment with a paid provider (the sandbox refuses joins without it), and `/api/health` warns while it is empty |
| `ADMIN_EMAIL` | the instructor's login name (default `admin`) |
| `REVIEWER_USERNAME`, `REVIEWER_PASSWORD_HASH` | the read-only reviewer account (default name `reviewer`; off while the hash is empty) |
| `SANDBOX_COHORT_SLUG` | which open cohort the landing page links to when more than one has open join |
| `DEMO_CONTACT` | email address or URL shown to sandbox visitors for deletion requests |
| `LLM_PERSONA_MODEL`, `LLM_RUBRIC_MODEL`, `LLM_ANALYST_MODEL` | model overrides; the Anthropic defaults are `claude-sonnet-5` for personas and the analyst agent and `claude-opus-4-8` for the judge and the auditor |
| `RETENTION_DAYS` | log retention for the daily purge (default 180) |
| `LLM_MAX_TOKENS_*` | output-token caps per call |
| `AUTH_URL` | public origin; leave unset unless a proxy rewrites the host |
| `AUTH_TRUST_HOST` | `true` when you serve `pnpm start` yourself outside Vercel (Vercel sets the equivalent itself) |
| `NEXT_PUBLIC_PAPER_URL`, `NEXT_PUBLIC_VIDEO_URL` | optional links on the landing page |

`DB_DRIVER=pglite` (with `PGLITE_DIR`) swaps Postgres for the embedded
database and is meant for local use. Never set `DEMO_MODE` outside the demo
targets: it turns on the fixed logins, and a Vercel build refuses it.

The password hashes come from a prompt:

```bash
pnpm change-admin-password              # prints ADMIN_PASSWORD_HASH=...
pnpm change-admin-password --reviewer   # prints REVIEWER_PASSWORD_HASH=...
```

Passwords must have at least 12 characters. The printed line has every `$`
escaped as `\$`, which `.env.local` needs; paste the unescaped hash into the
Vercel dashboard, or add `--vercel` to set the variable on the linked Vercel
project directly.

### 4. Local run with real settings

To test the deployment configuration on your machine without a Postgres
server, add these lines to `.env.local` beside the variables above:

```bash
DB_DRIVER=pglite
PGLITE_DIR=.pglite-real
LLM_PROVIDER=mock        # or anthropic with ANTHROPIC_API_KEY set
```

Then migrate, restore the showcase and start:

```bash
npx tsx --env-file=.env.local scripts/migrate-local.ts
npx tsx --env-file=.env.local scripts/showcase-snapshot.ts restore --in demo/showcase-snapshot.json
pnpm dev                 # or: pnpm build && AUTH_TRUST_HOST=true pnpm start
```

Sign in at `/admin` with the passwords behind your hashes. `/api/health`
should report `"demoMode":false` with every check true.

### 5. Deploy to your own Vercel project

1. Fork or push this repository to your own GitHub account, then in Vercel
   choose **Add New > Project** and import it. The framework preset is
   Next.js and the defaults (`pnpm install`, `pnpm build`) need no change.
   `vercel.json` pins the functions to the Singapore region (`sin1`); change
   `regions` there if your users are elsewhere.
2. In the project's **Storage** tab, add a Neon Postgres database from the
   Marketplace and connect it to the project. This sets `POSTGRES_URL`,
   `POSTGRES_URL_NON_POOLING` and the related variables.
3. Under **Settings > Environment Variables**, set the required variables
   from step 3 for Production (and Preview, if you use preview
   deployments), plus `LLM_DAILY_BUDGET_USD` and, if you want them, the
   reviewer hash and `DEMO_CONTACT`.
4. Create the tables. From your clone, link the project and pull its
   environment, then run the migrations against Neon:

   ```bash
   npx vercel link
   npx vercel env pull .env.local --environment=production
   pnpm db:migrate
   ```

   Run `pnpm db:migrate` again after any update that adds a file under
   `lib/db/migrations/`.
5. Load the showcase cohort (optional, but it is what the reviewer account
   shows):

   ```bash
   DB_DRIVER=direct npx tsx --env-file=.env.local scripts/showcase-snapshot.ts restore --in demo/showcase-snapshot.json --dry-run
   DB_DRIVER=direct npx tsx --env-file=.env.local scripts/showcase-snapshot.ts restore --in demo/showcase-snapshot.json
   ```

   `DB_DRIVER=direct` uses the direct connection string. The restore turns
   reviewer access on for this cohort and creates the instructor row it
   needs. Restoring again later puts the cohort back as committed.
6. Deploy (push to the production branch, or **Redeploy** in the dashboard)
   so the build picks up the variables. Then check
   `https://<your-project>.vercel.app/api/health`: it should answer 200 with
   `"ok":true`, `"demoMode":false` and `"budgetSet":true`.
7. Sign in at `/admin` as the instructor (`ADMIN_EMAIL`, default `admin`).
   Create a cohort for course use, or one for visitors: for the hosted demo's
   "Try the demo" cohort, open **Configuration**, keep only the churn
   scenario, keep the gates formative (the default), tick **Open join**, keep
   the sandbox defaults (USD 2 a day, 40 messages a seat) and leave reviewer
   access off. Its link is `/try/<cohort-slug>`, and the landing page shows
   it as **Try as a learner**. The code limits sandbox joins to five a day
   from one network.
8. Cron: `vercel.json` registers one job, `GET /api/cron/cleanup` daily at
   03:00 UTC, which applies the retention rules. Vercel calls it with
   `Authorization: Bearer $CRON_SECRET`, so `CRON_SECRET` must be set; it
   appears under **Settings > Cron Jobs** after the first production deploy,
   and `/api/health` reports `lastPurgeAt` once it has run. To call it by
   hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-project>.vercel.app/api/cron/cleanup`.

[demo/deploy.md](demo/deploy.md) gives the same steps with more on cost
controls and retention, and [demo/README.md](demo/README.md) describes the
reviewer account and the sandbox in more detail.

### Checking a running instance

`GET /api/health` is public and returns a boolean per required setting, the
provider, whether a budget is set, and the deployed commit (`version`, or the
package version outside Vercel). It answers 200 only when the database and
every required secret are in place, and 503 otherwise with the failing field
in the body. No secret value is returned.

## Reproducing section 5 of the paper

Every figure in the paper's section 5 (latencies, tokens, cost, rubric totals,
audit counts) comes from the committed showcase snapshot, through one
pipeline, with no server, database or model call involved:

```bash
pnpm install
make section5         # restore demo/showcase-snapshot.json into a fresh PGlite
                      # directory and run the metrics on the pinned runs
make section5-check   # the same, then diff every CSV against scripts/paper-metrics/expected/
```

`scripts/paper-metrics/paper-runs.env` pins the runs (engagement ids and
labels) and the pipeline arguments. The outputs go to `out/section5/`:
`run-summary.csv`, `metrics-summary.csv`, `tokens-by-stage.csv`,
`cost-per-reply.csv`, `audit-totals.csv`, the `paper-figures-*.csv` files
and a `section5-report.md` that gathers the reported figures. The
`paper-figures-*.csv` files (from `scripts/paper-metrics/paper-figures.py`)
hold the figures the paper quotes that the other CSVs do not: tokens and USD
over all metered calls (successful calls plus the metered calls of failed
attempts, each priced at the model that served it), wall clock of successful
stage attempts with failed and interrupted attempts listed apart, the message
at which each hidden fact was obtained, early-disclosure flags, audits by
trigger, and latency pooled over all pinned runs. Costs use the dated list prices in
`lib/llm/prices.ts`. The pipeline needs Node 20, pnpm and Python 3; it
installs its pinned Python packages into a virtual environment under the
output directory.

To see the same runs in the app, `make demo-showcase` restores the snapshot
into the local demo and serves it (reviewer login `reviewer` / `reviewer`).

### Paper artefacts and showcase run labels

The cohort table and the compare view label the showcase runs as the paper
does. The list below refers to the regenerated showcase; the labels stay the
same when the showcase is regenerated.

- Table 2 (compare-view values): column H1 is the reference run (an
  author-scripted replay of a recorded human run, with a documented patch),
  A1 and A2 are analyst-agent runs (A1 on Sonnet 5, A2 on Haiku 4.5), and the
  exhibit is the fail-then-revise replay, which stops at cleaning by design.
  The committed snapshot holds these four runs and no others. The same values
  are in `out/section5/section5-report.md` after `make section5`. The admin
  views label H1 and the exhibit "Scripted reference (author replay)" and give
  their times as replay times.
- Walkthrough 1 (eliciting the problem and the data): open the transcripts and
  the world-fact ledger of H1 in the engagement monitor.
- Walkthrough 2 (the reference run and an agent on the same scenario): the
  compare view with H1 beside A1, which is the pinned pair of the cohort. For
  an agent run the compare view and the monitor report active time, the sum
  of the stage attempts that finished without a failure; A1 reads 6m 25s
  (6.4 minutes in Table 2).
- Walkthrough 3 (a submission addressed to the assessor): the run labelled
  `exhibit`, whose data-audit memo is flagged in a banner above the submission.

### Regenerating the showcase

`make showcase-regen` rebuilds the showcase cohort: it replays the reference
human run H1 from its recorded learner messages and artifacts
(`scripts/replay/human-reference.ts`), drives `REGEN_AGENT_RUNS` analyst-agent
runs (`scripts/replay/agent-runs.ts`; two by default, labelled A1 and A2),
replays the fail-then-revise exhibit (`scripts/replay/fail-then-revise.ts`),
then exports the snapshot and writes a run map for that snapshot. The committed
snapshot holds H1, A1, A2 and the exhibit from one regeneration. With `REGEN_LOCAL=1` the script starts its own
local server on a fresh PGlite directory; with a real `LLM_PROVIDER` and key in
the environment this makes paid model calls, and a mock regeneration reports its
USD figures as 0. The run map points at the regenerated snapshot in the output
directory, so `make section5 SECTION5_ENV=out/showcase-regen/paper-runs.env`
recomputes section 5 from it; `REGEN_INSTALL=1` copies the snapshot and run map
over the committed ones. `scripts/replay/regen.sh` lists every variable.

The H1 replay applies `scripts/replay/patches/h1-current-scenario.json` by
default: H1 was recorded under an older version of the churn scenario, and the
patch updates its artifacts to the current scenario (the S$540,000 quarterly
budget and the May outage) and corrects one arithmetic slip (6,000 offers at
S$30 is S$180,000 a month). Each replacement is logged, and the regenerated
cohort records the patch's sha256 in `showcase.h1Patch`;
`REGEN_H1_ARGS=--no-patch` replays the recording verbatim. Each agent run can
use its own analyst model: `REGEN_ANALYST_MODELS` (default
`claude-sonnet-5,claude-haiku-4-5`) runs A1 on the persona model and A2 on
Haiku 4.5, through the instructor-only route
`POST /api/admin/cohorts/<id>/agent-runs`, and every analyst event of a run
records its model. The local server runs with `LLM_DAILY_BUDGET_USD` set to
`REGEN_BUDGET_USD` (default 8), with every database variable from
`.env.local` blanked, and the script prints the spend (the instructor's
readout and the spend guard's figure, both from `lib/llm/budget.ts`) before
and after it stops the server.

`make probes` runs scripted learner probes (`scripts/replay/probes.ts`, the
list in `scripts/replay/probes/round5.ts`) in a "Leak probes" cohort and
writes each probe's replies, releases, elicitation rows, audits and
early-disclosure verdicts to `PROBES_OUT`; `PROBES_LOCAL=1` gives it its own
local server in the same way. `scripts/replay/probes.sh` lists its variables.

The regeneration is meant to run against a local server (`REGEN_LOCAL=1`).
`make showcase-regen` and `pnpm showcase:regen` both set `SHOWCASE_REGEN=1`,
which the local server needs to mint invites into the reviewer-visible showcase
cohort. A deployment refuses those invites, because the variable set on your
machine does not reach it. To
regenerate against a deployment (`BASE_URL` without `REGEN_LOCAL`), set
`SHOWCASE_REGEN=1` in that deployment's environment for the duration of the
run, redeploy, and remove the variable (and redeploy again) as soon as the run
has finished. Labelled showcase runs cannot be deleted one at a time from the
admin screens; deleting the whole showcase cohort still works behind the typed
confirmation of its slug.

## Development

```bash
make test        # vitest unit tests
make e2e         # Playwright end-to-end tests (4 run; 2 more need E2E_ADMIN_PASSWORD)
make lint        # eslint
make typecheck   # tsc --noEmit
```

The two walkthrough specs sign in as the instructor and skip themselves without a
password. With `make demo` running, `E2E_ADMIN_PASSWORD=demo make e2e` runs all
six. Without `PLAYWRIGHT_BASE_URL`, Playwright starts its own `pnpm dev` on
port 3000; against a demo on another port, set it, for example
`PLAYWRIGHT_BASE_URL=http://localhost:3100 E2E_ADMIN_PASSWORD=demo make e2e`.

## Contact and data deletion

Questions about the software, and requests to delete a sandbox engagement on
the hosted demo, go to Kwan Hui Lim (khlim@suss.edu.sg), the first author of
the paper, or to the `DEMO_CONTACT` address if a deployment's privacy page
shows one. Quote the learner id
shown after "Signed in as" in the workspace header. Sandbox engagements are
deleted automatically 30 days after the seat was created.

## Citation

The paper is under submission, so cite it as unpublished work until a decision is in.

```bibtex
@unpublished{Lim2027WSDM_AgenticPracticum,
  author = {Lim, Kwan Hui and Lee, Carmen Kar Hang and Liu, Vanessa and Zhu, Yongqing},
  title  = {{AgenticPracticum}: A Multi-Agent {LLM} Testbed for Practising End-to-End Data-Science Engagements},
  note   = {Submitted to the WSDM 2027 Demonstrations Track},
  year   = {2026}
}
```

[CITATION.cff](CITATION.cff) carries the same entry, and it will be updated
with the proceedings reference on acceptance.

## License

See [LICENSE](LICENSE).
