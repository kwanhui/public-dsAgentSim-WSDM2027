# AgenticPracticum

Cut from tool commit 60d6e55 (tag wsdm2027-submission); showcase generated at 960485f.

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

## Documentation

- [docs/architecture.md](docs/architecture.md): components, data flow, agents,
  privacy and retention.
- [demo/deploy.md](demo/deploy.md): deploying to Vercel and Neon.
- [demo/README.md](demo/README.md): the walkthrough, the reviewer account, the
  learner sandbox and the health endpoint.
- [scripts/reviewer-path-check.md](scripts/reviewer-path-check.md): the
  checklist for the reviewer path.

## Run the Demo (no setup)

Needs Node 20 or later and pnpm 9 or later. The section 5 pipeline also needs
Python 3.

```bash
git clone https://github.com/kwanhui/public-dsAgentSim-WSDM2027.git
cd public-dsAgentSim-WSDM2027
pnpm install
make demo    # embedded PGlite database + mock LLM; open http://localhost:3000
```

Sign in at `/admin` with `admin` / `demo` (local demo only), create a cohort, generate a learner
invite URL, and open it in a private window to walk an engagement as a
learner. Demo mode needs no database, API key, or env file; persona replies
are canned but drive the full loop (scoping, dataset release, stage gates,
rubric scores). The login `reviewer` / `reviewer` gives the read-only
reviewer view. Set `PORT` (default 3000) to run the demo on another port; sign-in follows it.

```bash
make demo-showcase   # the same, with the curated showcase cohort restored
```

`make demo-showcase` migrates the local PGlite database, restores
`demo/showcase-snapshot.json` into it (replacing that cohort's rows each time
and creating the `admin` user row the cohort needs), and starts the demo. Set
`PGLITE_DIR` to keep it apart from the plain demo database.

## Full Setup (real LLM personas)

```bash
cp .env.example .env.local
pnpm change-admin-password   # prints an ADMIN_PASSWORD_HASH line for .env.local
pnpm db:migrate
pnpm dev
```

Fill in `.env.local` before the first start. These variables are required on a
deployment, and `/api/health` reports each one as missing until it is set:

- `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` with `LLM_PROVIDER=openai`).
- `POSTGRES_URL` for a Postgres database such as Neon (see the local recipe
  below for a database without a server).
- `AUTH_SECRET`, generated with `openssl rand -hex 32`.
- `PSEUDONYM_SALT`, at least 32 characters and not the placeholder from
  `.env.example`; `openssl rand -hex 32` gives a valid value.
- `ADMIN_PASSWORD_HASH`, from `pnpm change-admin-password`.
- `CRON_SECRET`, generated the same way. Without it the daily retention purge
  at `/api/cron/cleanup` refuses to run.
- `LLM_DAILY_BUDGET_USD`, a plain number such as `5`. It caps the day's model
  spend; empty means no limit, and sandbox joins are refused while it is empty
  on a paid provider. `/api/health` reports a missing budget as a warning, not
  as a failure, so check the `warnings` field before going live.

On a deployment with the "Try as a learner" sandbox, also set `DEMO_CONTACT`
(an email address or a URL). The privacy page and the sandbox notice show it
as the contact for deletion requests; unset, they point visitors to the paper
and this README.

The password must be at least 12 characters and is read from a prompt, never
from the command line. `--reviewer` prints a `REVIEWER_PASSWORD_HASH` line for
the read-only reviewer account instead, and `--vercel` sets the variable on the
linked Vercel project's production environment (it does not deploy).

Leave `AUTH_URL` commented out unless the app runs behind a proxy that rewrites
the host. Unset, the invite and resume links an instructor hands to learners
follow the host the request came in on, so a tunnel, a LAN address, or a
preview deployment produces links that work. Every other variable is described
in `.env.example`.

### Local real-mode recipe (no Postgres server)

To run the non-demo configuration on a laptop, use the embedded PGlite database
instead of Postgres. Put these in `.env.local` beside the variables above:

```bash
DB_DRIVER=pglite
PGLITE_DIR=.pglite-real          # any new directory
LLM_PROVIDER=mock                # or anthropic with ANTHROPIC_API_KEY set
```

Then run `PGLITE_DIR=.pglite-real npx tsx scripts/migrate-local.ts` in place of
`pnpm db:migrate`, and `pnpm dev`. The fixed `admin` / `demo` login is not
available in this mode; sign in with the password behind your
`ADMIN_PASSWORD_HASH`. To test the demo logins beside a paid provider on your
own machine, set `DEMO_MODE=1` and `ALLOW_DEMO_MODE_WITH_KEY=1`; never set
either on a shared deployment, and `DEMO_MODE` is refused on Vercel.

### Checking a running instance

`GET /api/health` is public and returns a boolean per required setting, the
provider, whether a budget is set, and the deployed commit. It answers 200 only
when the database and every required secret are in place, and 503 otherwise
with the failing field in the body. No secret value is returned.

For deployment steps on Vercel and Neon, see [demo/deploy.md](demo/deploy.md).

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
  of the stage attempts that finished without a failure; A1 reads about 4.6
  minutes, because its interrupted first formulation attempt is left out.
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
the hosted demo, go to the corresponding author named in the paper, or to the
`DEMO_CONTACT` address shown on the demo's privacy page. Quote the learner id
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
