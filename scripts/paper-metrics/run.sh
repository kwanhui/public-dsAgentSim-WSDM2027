#!/usr/bin/env bash
# End-to-end paper-metrics pipeline, driven by environment variables (set by
# `make paper-metrics`). No path, URL, cohort or run id is hard-coded here.
#
#   PAPER_METRICS_SOURCE   pglite:<dir> | postgres | export-dir:<dir>   (required)
#   PAPER_METRICS_COHORT   cohort slug or id (required for pglite/postgres; the
#                          slug prefix of the export files for export-dir)
#   PAPER_METRICS_RUNS     label=engagement-id[:group],...  (required; when
#                          empty the engagements in the source are listed)
#   PAPER_METRICS_OUT      output directory (default out/paper-metrics)
#   PAPER_METRICS_ARGS     extra analyse.py arguments, e.g.
#                          "--metering-cutoff 2026-08-26T10:08:18Z"
#   PAPER_METRICS_PREVIOUS earlier unmetered-estimate.csv to compare against
#   PAPER_METRICS_PYTHON   python with the requirements installed; by default a
#                          venv is created under $PAPER_METRICS_OUT/.venv
set -euo pipefail

cd "$(dirname "$0")/../.."
SOURCE="${PAPER_METRICS_SOURCE:?set PAPER_METRICS_SOURCE to pglite:<dir>, postgres or export-dir:<dir>}"
COHORT="${PAPER_METRICS_COHORT:-}"
RUNS="${PAPER_METRICS_RUNS:-}"
OUT="${PAPER_METRICS_OUT:-out/paper-metrics}"
mkdir -p "$OUT"

PY="${PAPER_METRICS_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ ! -x "$OUT/.venv/bin/python" ]; then
    python3 -m venv "$OUT/.venv"
  fi
  "$OUT/.venv/bin/pip" install --quiet -r scripts/paper-metrics/requirements.txt
  PY="$OUT/.venv/bin/python"
fi

# Prices: one dated table, lib/llm/prices.ts.
npx tsx scripts/paper-metrics/export-prices.ts --out "$OUT/prices.json"

# Data: pull from a database, or use an export directory as it stands.
case "$SOURCE" in
  export-dir:*)
    DATA="${SOURCE#export-dir:}"
    ;;
  pglite:*|postgres)
    [ -n "$COHORT" ] || { echo "PAPER_METRICS_COHORT is required for $SOURCE" >&2; exit 1; }
    DATA="$OUT/data"
    npx tsx scripts/paper-metrics/pull-db.ts --source "$SOURCE" --cohort "$COHORT" --out "$DATA"
    ;;
  *)
    echo "Unknown PAPER_METRICS_SOURCE: $SOURCE" >&2
    exit 1
    ;;
esac

if [ -z "$RUNS" ]; then
  echo "PAPER_METRICS_RUNS is empty. Engagements in $DATA/db-engagements.csv:" >&2
  "$PY" - "$DATA/db-engagements.csv" <<'PYEOF' >&2
import csv, sys
for r in csv.DictReader(open(sys.argv[1])):
    print(f"  {r['id']}  mode={r['mode']}  status={r['status']}  stage={r['current_stage']}  events={r['n_events']}")
print('Pass PAPER_METRICS_RUNS="label=id[:group],..." (group: paper | exemplar | context).')
PYEOF
  exit 2
fi

ANALYSE_ARGS=(--source "export-dir:$DATA" --runs "$RUNS" --prices "$OUT/prices.json" --out "$OUT")
[ -n "$COHORT" ] && ANALYSE_ARGS+=(--cohort "$COHORT")
# shellcheck disable=SC2206
EXTRA=(${PAPER_METRICS_ARGS:-})
"$PY" scripts/paper-metrics/analyse.py "${ANALYSE_ARGS[@]}" "${EXTRA[@]}" > "$OUT/analyse.log"

REESTIMATE_ARGS=(--dir "$OUT" --prices "$OUT/prices.json")
[ -n "${PAPER_METRICS_PREVIOUS:-}" ] && REESTIMATE_ARGS+=(--previous "$PAPER_METRICS_PREVIOUS")
"$PY" scripts/paper-metrics/reestimate.py "${REESTIMATE_ARGS[@]}" > "$OUT/reestimate.log"
"$PY" scripts/paper-metrics/report-tables.py --dir "$OUT" > "$OUT/report-tables.txt"
# The paper figures analyse.py does not print (all-metered tokens and USD,
# successful-attempt wall clock, audit triggers, hidden-fact indices, pooled
# latency), from the same exports.
"$PY" scripts/paper-metrics/paper-figures.py --dir "$OUT" --data "$DATA" --runs "$RUNS" --prices "$OUT/prices.json" > "$OUT/paper-figures.log"

echo "paper-metrics written to $OUT:"
ls "$OUT" | grep -v '^\.venv$' | sed 's/^/  /'
