.PHONY: install dev demo demo-showcase build test e2e lint typecheck format clean paper-metrics spend \
	section5 section5-check section5-expected showcase-regen probes

# --- Setup ---
install:
	pnpm install

# --- Development ---
dev:
	pnpm dev

# Single-command demo (repo convention): fully offline, with an embedded PGlite
# database, mock LLM personas, fixed credentials admin/demo. For the real
# LLM experience use `pnpm dev` with a configured .env.local instead.
demo:
	pnpm demo

# The same offline demo with the curated showcase cohort restored from
# demo/showcase-snapshot.json into the local PGlite database (PGLITE_DIR,
# default .pglite). The restore replaces that cohort's rows on every run and
# creates the admin user row it needs. Sign in as admin/demo, or as
# reviewer/reviewer for the read-only view.
demo-showcase:
	pnpm demo:showcase

build:
	pnpm build

# --- Quality ---
test:
	pnpm test

e2e:
	pnpm e2e

lint:
	pnpm lint

typecheck:
	pnpm typecheck

format:
	pnpm format

# --- Database ---
db-generate:
	pnpm db:generate

db-migrate:
	pnpm db:migrate

# --- Paper metrics ---
# The one canonical pipeline behind the paper's section 5 numbers: pull a
# cohort from a PGlite directory (or Postgres, or an export directory), then
# run analyse.py, reestimate.py and report-tables.py into PAPER_METRICS_OUT.
# Prices come from lib/llm/prices.ts. Example:
#   make paper-metrics PAPER_METRICS_SOURCE=pglite:.pglite \
#     PAPER_METRICS_COHORT=showcase-meridian-mobile-churn-esagd \
#     PAPER_METRICS_RUNS="H1=<id>:exemplar,A1=<id>:paper,A2=<id>:paper,exhibit=<id>:context"
# Leave PAPER_METRICS_RUNS empty to list the engagements. See
# scripts/paper-metrics/run.sh for every variable.
paper-metrics:
	PAPER_METRICS_SOURCE="$(PAPER_METRICS_SOURCE)" PAPER_METRICS_COHORT="$(PAPER_METRICS_COHORT)" \
	PAPER_METRICS_RUNS="$(PAPER_METRICS_RUNS)" PAPER_METRICS_OUT="$(PAPER_METRICS_OUT)" \
	PAPER_METRICS_ARGS="$(PAPER_METRICS_ARGS)" PAPER_METRICS_PREVIOUS="$(PAPER_METRICS_PREVIOUS)" \
	bash scripts/paper-metrics/run.sh

# Section 5 from the committed snapshot alone: restore the snapshot named in
# the pinned run map (scripts/paper-metrics/paper-runs.env) into a fresh
# PGlite directory, run paper-metrics on the pinned runs, and write the CSVs
# and section5-report.md to SECTION5_OUT (default out/section5).
# section5-check also diffs the outputs against scripts/paper-metrics/expected;
# section5-expected rewrites those expected files.
section5:
	bash scripts/paper-metrics/section5.sh

section5-check:
	SECTION5_CHECK=1 bash scripts/paper-metrics/section5.sh

section5-expected:
	SECTION5_WRITE_EXPECTED=1 bash scripts/paper-metrics/section5.sh

# Regenerate the showcase cohort (reference human replay, analyst runs,
# fail-then-revise exhibit), export its snapshot and write a new run map into
# REGEN_OUT (default out/showcase-regen). REGEN_LOCAL=1 runs its own local
# server on a fresh PGlite directory (mock provider unless LLM_PROVIDER says
# otherwise; LLM_DAILY_BUDGET_USD from REGEN_BUDGET_USD, default 8; A1 and A2
# on the analyst models in REGEN_ANALYST_MODELS, default
# claude-sonnet-5,claude-haiku-4-5; the H1 patch applied); without it, set
# BASE_URL, E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD.
# REGEN_INSTALL=1 copies the snapshot and run map into place. See
# scripts/replay/regen.sh for every variable.
# SHOWCASE_REGEN=1 lets the local server it starts mint invites into the
# reviewer-visible showcase cohort for its scripted runs
# (lib/cohort/showcase-invites.ts). A deployment driven with BASE_URL needs
# it set for the run and removed afterwards.
showcase-regen:
	SHOWCASE_REGEN=1 bash scripts/replay/regen.sh

# Scripted learner probes (scripts/replay/probes.ts) in a "Leak probes"
# cohort, written to PROBES_OUT (default out/probes). PROBES_LOCAL=1 runs
# them on their own local server as showcase-regen does; see
# scripts/replay/probes.sh.
probes:
	bash scripts/replay/probes.sh

# Total USD in a database: make spend SPEND_SOURCE=pglite:<dir> [SPEND_ARGS="--by cohort"]
spend:
	npx tsx scripts/spend.ts --source "$(SPEND_SOURCE)" $(SPEND_ARGS)

# --- Cleanup ---
clean:
	rm -rf .next out coverage playwright-report test-results *.tsbuildinfo
