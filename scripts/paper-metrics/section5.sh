#!/usr/bin/env bash
# Regenerates the paper's section 5 figures from the committed showcase
# snapshot alone (run by `make section5`): restore the snapshot into a fresh
# PGlite directory, run the paper-metrics pipeline on the pinned runs, and
# write the CSVs plus section5-report.md to an output directory. No server,
# no production database and no model call is involved.
#
#   SECTION5_ENV       pinned run map (default scripts/paper-metrics/paper-runs.env);
#                      it sets SECTION5_SNAPSHOT, SECTION5_COHORT, SECTION5_RUNS
#                      and SECTION5_ARGS
#   SECTION5_SNAPSHOT  overrides the snapshot named in the run map
#   SECTION5_OUT       output directory (default out/section5)
#   SECTION5_EXPECTED  directory of expected CSVs (default scripts/paper-metrics/expected)
#   SECTION5_CHECK=1   diff the output CSVs against SECTION5_EXPECTED; exit 1 on a difference
#   SECTION5_WRITE_EXPECTED=1  copy the output CSVs and report into SECTION5_EXPECTED
#   SECTION5_KEEP_DB=1 keep the PGlite directory (it is made under TMPDIR)
#   PAPER_METRICS_PYTHON  as for run.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE="${SECTION5_ENV:-scripts/paper-metrics/paper-runs.env}"
OVERRIDE_SNAPSHOT="${SECTION5_SNAPSHOT:-}"
[ -f "$ENV_FILE" ] || { echo "No run map at $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
[ -n "$OVERRIDE_SNAPSHOT" ] && SECTION5_SNAPSHOT="$OVERRIDE_SNAPSHOT"
: "${SECTION5_SNAPSHOT:?the run map sets no SECTION5_SNAPSHOT}"
: "${SECTION5_RUNS:?the run map sets no SECTION5_RUNS}"
: "${SECTION5_COHORT:?the run map sets no SECTION5_COHORT}"
OUT="${SECTION5_OUT:-out/section5}"
EXPECTED="${SECTION5_EXPECTED:-scripts/paper-metrics/expected}"
mkdir -p "$OUT"

DB="$(mktemp -d "${TMPDIR:-/tmp}/section5-pglite.XXXXXX")"
cleanup() { [ "${SECTION5_KEEP_DB:-}" = "1" ] || rm -rf "$DB"; }
trap cleanup EXIT

echo "section5: restoring $SECTION5_SNAPSHOT into $DB"
PGLITE_DIR="$DB" npx tsx scripts/migrate-local.ts > "$OUT/restore.log"
DB_DRIVER=pglite PGLITE_DIR="$DB" npx tsx scripts/showcase-snapshot.ts restore --in "$SECTION5_SNAPSHOT" >> "$OUT/restore.log"

PAPER_METRICS_SOURCE="pglite:$DB" PAPER_METRICS_COHORT="$SECTION5_COHORT" \
PAPER_METRICS_RUNS="$SECTION5_RUNS" PAPER_METRICS_ARGS="${SECTION5_ARGS:-}" \
PAPER_METRICS_OUT="$OUT" PAPER_METRICS_PREVIOUS="" \
  bash scripts/paper-metrics/run.sh

PY="${PAPER_METRICS_PYTHON:-$OUT/.venv/bin/python}"
"$PY" scripts/paper-metrics/section5-report.py --dir "$OUT" --snapshot "$SECTION5_SNAPSHOT" \
  --runs "$SECTION5_RUNS" > "$OUT/section5-report.md"
echo "section5: report written to $OUT/section5-report.md"

# The CSVs that carry section 5's numbers. The data/ pulls are inputs and are
# not compared.
FILES=(run-summary.csv metrics-summary.csv tokens-by-stage.csv cost-per-reply.csv audit-totals.csv
       message-classifier-check.csv unmetered-estimate.csv paper-figures-runs.csv paper-figures-facts.csv
       paper-figures-audits.csv paper-figures-latency.csv section5-report.md)

if [ "${SECTION5_WRITE_EXPECTED:-}" = "1" ]; then
  mkdir -p "$EXPECTED"
  for f in "${FILES[@]}"; do [ -f "$OUT/$f" ] && cp "$OUT/$f" "$EXPECTED/$f"; done
  cp "$ENV_FILE" "$EXPECTED/paper-runs.env"
  echo "section5: expected outputs written to $EXPECTED"
fi

if [ "${SECTION5_CHECK:-}" = "1" ]; then
  status=0
  for f in "${FILES[@]}"; do
    if [ -f "$EXPECTED/$f" ] || [ -f "$OUT/$f" ]; then
      if d="$(diff -u "$EXPECTED/$f" "$OUT/$f" 2>&1)"; then
        echo "  same     $f"
      else
        printf '%s\n' "$d" > "$OUT/$f.diff"
        echo "  DIFFERS  $f (see $OUT/$f.diff)"
        status=1
      fi
    fi
  done
  [ "$status" = 0 ] && echo "section5: every output matches $EXPECTED" || echo "section5: outputs differ from $EXPECTED" >&2
  exit "$status"
fi
