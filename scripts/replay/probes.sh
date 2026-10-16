#!/usr/bin/env bash
# Runs the scripted learner probes (scripts/replay/probes.ts, the
# list in scripts/replay/probes/round5.ts) in a "Leak probes" cohort, run
# by `make probes`. Output (one JSON per probe run, summary.md, the raw
# exports, probes.log, spend.json) goes to $PROBES_OUT.
#
#   PROBES_LOCAL=1  starts a local server on a fresh PGlite directory, as
#                   `make showcase-regen REGEN_LOCAL=1` does
#                   (scripts/replay/local-server.sh: DB_DRIVER=pglite, the
#                   database variables from .env.local blanked,
#                   LLM_DAILY_BUDGET_USD=$PROBES_BUDGET_USD), prints the
#                   spend, and stops it with SIGINT:
#                     make probes PROBES_LOCAL=1                       # mock
#                     make probes PROBES_LOCAL=1 LLM_PROVIDER=anthropic PROBES_SEEDS=3
#   otherwise       drives BASE_URL with E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD.
#
# Variables:
#   PROBES_OUT         output directory (default out/probes)
#   PROBES_PORT        local server port (default 3000)
#   PROBES_PGLITE_DIR  local PGlite directory (default $PROBES_OUT/pglite; must not exist)
#   PROBES_BUDGET_USD  LLM_DAILY_BUDGET_USD for the local server (default 8)
#   PROBES_SEEDS       runs per probe (default 1; 3 recommended)
#   PROBES_ONLY        comma-separated probe ids (default all; see `tsx scripts/replay/probes.ts --list`)
#   PROBES_COHORT_ID   an existing cohort to use instead of creating one
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT="${PROBES_OUT:-out/probes}"
PORT="${PROBES_PORT:-3000}"
BUDGET="${PROBES_BUDGET_USD:-8}"
mkdir -p "$OUT"
LOG="$OUT/probes-run.log"
: > "$LOG"
say() { echo "[$(date -u +%FT%TZ)] probes $*" | tee -a "$LOG"; }
say "tool commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)'), output $OUT"

# shellcheck source=scripts/replay/local-server.sh
source scripts/replay/local-server.sh
trap stop_server EXIT

if [ "${PROBES_LOCAL:-}" = "1" ]; then
  PGDIR="${PROBES_PGLITE_DIR:-$OUT/pglite}"
  PROVIDER="${LLM_PROVIDER:-mock}"
  start_local_server
else
  : "${BASE_URL:?set BASE_URL to the server to drive, or PROBES_LOCAL=1}"
  : "${E2E_ADMIN_PASSWORD:?set E2E_ADMIN_PASSWORD (and E2E_ADMIN_EMAIL) to the instructor sign-in for BASE_URL}"
fi

ARGS=(--base-url "$BASE_URL" --out "$OUT" --seeds "${PROBES_SEEDS:-1}")
[ -n "${PROBES_ONLY:-}" ] && ARGS+=(--only "$PROBES_ONLY")
[ -n "${PROBES_COHORT_ID:-}" ] && ARGS+=(--cohort-id "$PROBES_COHORT_ID")
status=0
npx tsx scripts/replay/probes.ts "${ARGS[@]}" || status=$?

COHORT_ID="$(grep -o '"cohortId": "[^"]*"' "$OUT/summary.json" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
if [ -n "$COHORT_ID" ]; then
  npx tsx scripts/replay/spend-report.ts --base-url "$BASE_URL" --cohort-id "$COHORT_ID" --budget "$BUDGET" \
    --out "$OUT/spend.json" --log "$LOG" || say "WARN: the spend readout failed"
fi
if [ "${PROBES_LOCAL:-}" = "1" ]; then
  stop_server
  DB_DRIVER=pglite PGLITE_DIR="$PGDIR" npx tsx scripts/replay/spend-report.ts --offline --out "$OUT/spend.json" | tee -a "$LOG"
fi
say "done (probes exit status $status): $OUT/summary.md"
exit "$status"
