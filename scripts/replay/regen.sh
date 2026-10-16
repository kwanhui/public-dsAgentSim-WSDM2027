#!/usr/bin/env bash
# Regenerates the showcase cohort behind the paper's section 5 (run by
# `make showcase-regen`), then exports it and writes the pinned run map:
#
#   1. create the cohort (gated, reviewer-visible, one scenario)
#   2. replay the reference human run H1        (human-reference.ts; the H1
#      patch scripts/replay/patches/h1-current-scenario.json is applied
#      unless REGEN_H1_ARGS=--no-patch, and its sha256 is recorded)
#   3. drive REGEN_AGENT_RUNS analyst runs A1.. (agent-runs.ts; each on its
#      own analyst model from REGEN_ANALYST_MODELS)
#   4. replay the fail-then-revise exhibit      (fail-then-revise.ts)
#   5. label the runs, pin the compare pair (H1 against A1), set reviewer visibility
#   6. export the cohort snapshot               (showcase-snapshot.ts)
#   7. write paper-runs.env                     (run-map.ts)
#
# Every step logs to $REGEN_OUT/regen.log and the script stops at the first
# step that fails.
#
# Two ways to run it:
#
#   REGEN_LOCAL=1  starts a local server (scripts/replay/local-server.sh) on
#                  a fresh PGlite directory with DB_DRIVER=pglite, every
#                  database variable from .env.local blanked, SHOWCASE_REGEN=1,
#                  LLM_DAILY_BUDGET_USD=$REGEN_BUDGET_USD and a generated
#                  instructor password. Before the export it prints the spend
#                  (lib/llm/budget.ts) and stops the server with SIGINT
#                  (PGlite is single-process). The model provider is
#                  LLM_PROVIDER (mock when unset), so the same command runs
#                  offline or against a real model; the key comes from the
#                  environment or .env.local:
#                    make showcase-regen REGEN_LOCAL=1
#                    make showcase-regen REGEN_LOCAL=1 LLM_PROVIDER=anthropic REGEN_BUDGET_USD=8
#   otherwise      drives the server at BASE_URL with E2E_ADMIN_EMAIL and
#                  E2E_ADMIN_PASSWORD, and exports from the database the
#                  environment selects (DB_DRIVER, POSTGRES_URL...), which must
#                  be the one behind BASE_URL. A deployment with a paid
#                  provider makes paid model calls.
#                  The deployment refuses invites into the reviewer-visible
#                  showcase cohort unless SHOWCASE_REGEN=1 is set in its
#                  environment; set it for the duration of the run only,
#                  then remove it and redeploy.
#
# Variables:
#   BASE_URL            server to drive (REGEN_LOCAL: http://localhost:$REGEN_PORT)
#   REGEN_OUT           output directory (default out/showcase-regen)
#   REGEN_PORT          local server port (default 3000)
#   REGEN_PGLITE_DIR    local PGlite directory (default $REGEN_OUT/pglite; must not exist)
#   REGEN_COHORT_NAME   cohort name (default "Showcase: Meridian Mobile churn")
#   REGEN_SCENARIO      scenario id (default customer-churn)
#   REGEN_AGENT_RUNS    number of analyst runs, labelled A1, A2, ... (default 2)
#   REGEN_ANALYST_MODELS  analyst model per agent run, in label order (default
#                       "claude-sonnet-5,claude-haiku-4-5": A1 on the persona
#                       model, A2 on Haiku 4.5; an empty entry keeps the
#                       deployment's analyst model; on the mock the models are
#                       recorded but the mock serves every call)
#   REGEN_BUDGET_USD    LLM_DAILY_BUDGET_USD for the local server (default 8)
#   REGEN_REPLAY_ARGS   extra arguments for both replays
#   REGEN_H1_ARGS       extra arguments for the H1 replay only, e.g. --no-patch
#   REGEN_RESUME=1      continue an earlier run in an existing REGEN_OUT (needs
#                       REGEN_LOCAL=1, cohort.json and the pglite directory
#                       there): restarts the local server on that PGlite
#                       directory, skips the steps already completed (H1 when
#                       human-reference.json records a completed engagement;
#                       each agent run in agent-runs.json that completed; the
#                       exhibit when fail-then-revise.json is ok), continues an
#                       agent run left "active" from its current stage (it is
#                       not restarted or deleted), then finishes the export.
#                       The log is appended to, not truncated. Logs each skip.
#   REGEN_STOP_AFTER    stop cleanly after step h1, agents or exhibit (test
#                       aid: produces a partial run that REGEN_RESUME=1 can
#                       continue)
#   STAGE_TIMEOUT_S     longest wait for one agent stage (default 600); the
#                       driver polls every STAGE_POLL_S (default 5) seconds
#   REGEN_INSTALL=1     copy the snapshot to demo/showcase-snapshot.json and the
#                       run map to scripts/paper-metrics/paper-runs.env
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT="${REGEN_OUT:-out/showcase-regen}"
PORT="${REGEN_PORT:-3000}"
SCENARIO="${REGEN_SCENARIO:-customer-churn}"
NAME="${REGEN_COHORT_NAME:-Showcase: Meridian Mobile churn}"
N_AGENT="${REGEN_AGENT_RUNS:-2}"
ANALYST_MODELS="${REGEN_ANALYST_MODELS-claude-sonnet-5,claude-haiku-4-5}"
BUDGET="${REGEN_BUDGET_USD:-8}"
# shellcheck disable=SC2206
REPLAY_ARGS=(${REGEN_REPLAY_ARGS:-})
# shellcheck disable=SC2206
H1_ARGS=(${REGEN_H1_ARGS:-})
mkdir -p "$OUT"
LOG="$OUT/regen.log"
RESUME="${REGEN_RESUME:-}"
STOP_AFTER="${REGEN_STOP_AFTER:-}"
if [ "$RESUME" = "1" ]; then
  [ "${REGEN_LOCAL:-}" = "1" ] || { echo "REGEN_RESUME=1 needs REGEN_LOCAL=1 (it restarts the local server on the earlier PGlite directory)." >&2; exit 1; }
  [ -f "$OUT/cohort.json" ] || { echo "REGEN_RESUME=1 needs $OUT/cohort.json from the earlier run." >&2; exit 1; }
else
  : > "$LOG"
fi
say() { echo "[$(date -u +%FT%TZ)] regen $*" | tee -a "$LOG"; }
say "tool commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)'), output $OUT"

# shellcheck source=scripts/replay/local-server.sh
source scripts/replay/local-server.sh
trap stop_server EXIT

if [ "${REGEN_LOCAL:-}" = "1" ]; then
  PGDIR="${REGEN_PGLITE_DIR:-$OUT/pglite}"
  PROVIDER="${LLM_PROVIDER:-mock}"
  export SHOWCASE_REGEN=1
  start_local_server
else
  : "${BASE_URL:?set BASE_URL to the server to drive, or REGEN_LOCAL=1}"
  : "${E2E_ADMIN_PASSWORD:?set E2E_ADMIN_PASSWORD (and E2E_ADMIN_EMAIL) to the instructor sign-in for BASE_URL}"
fi

# The mock judge scores every artifact the same, so on the mock provider no
# gate holds a submission and the exhibit's first memo cannot be held. The
# replays then log that mismatch instead of stopping.
PROVIDER_SEEN="$(curl -s "$BASE_URL/api/health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).provider??"")}catch{console.log("")}})')"
say "provider reported by $BASE_URL/api/health: ${PROVIDER_SEEN:-unknown}"
if [ "$PROVIDER_SEEN" = "mock" ]; then
  REPLAY_ARGS+=(--lenient-gates)
  say "mock provider: gate outcomes are not checked (--lenient-gates); this run tests the pipeline, not the exhibit"
fi

# True when a result file has a top-level field with the given value (resume checks).
jsonis() { node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(String(process.argv[2].split(".").reduce((a,k)=>a[k],o))===process.argv[3]?0:1)}catch{process.exit(1)}' "$1" "$2" "$3"; }
stop_here() {
  if [ "$STOP_AFTER" = "$1" ]; then
    say "REGEN_STOP_AFTER=$1: stopping here; resume with REGEN_RESUME=1 and the same REGEN_OUT"
    exit 0
  fi
}

json() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].split(".").reduce((a,k)=>a[k],o))' "$1" "$2"; }

if [ "$RESUME" = "1" ]; then
  say "RESUME: 1/7 skipped, cohort $(json "$OUT/cohort.json" cohortId) exists in $OUT/cohort.json"
else
  say "1/7 create cohort"
  npx tsx scripts/replay/cohort.ts create --base-url "$BASE_URL" --name "$NAME" --scenario "$SCENARIO" \
    --out "$OUT/cohort.json" --log "$LOG"
fi
COHORT_ID="$(json "$OUT/cohort.json" cohortId)"

if [ "$RESUME" = "1" ] && jsonis "$OUT/human-reference.json" ok true && jsonis "$OUT/human-reference.json" finalStatus completed; then
  say "RESUME: 2/7 skipped, H1 already completed ($(json "$OUT/human-reference.json" engagementId))"
else
  if [ "$RESUME" = "1" ] && [ -f "$OUT/human-reference.json" ]; then
    echo "RESUME: H1 in $OUT/human-reference.json did not complete; it cannot be resumed mid-replay. Start a fresh REGEN_OUT." >&2
    exit 1
  fi
  say "2/7 replay the reference human run (H1)"
  npx tsx scripts/replay/human-reference.ts --base-url "$BASE_URL" --cohort-id "$COHORT_ID" --label H1 \
    --out "$OUT/human-reference.json" --log "$LOG" "${REPLAY_ARGS[@]}" "${H1_ARGS[@]}"
fi
# The patch applied to H1 (file:sha256), or empty for a verbatim replay.
H1_PATCH="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).patch; console.log(p ? `${p.file}:${p.sha256}` : "")' "$OUT/human-reference.json")"
if [ -n "$H1_PATCH" ]; then
  cp "${H1_PATCH%:*}" "$OUT/h1-patch.json"
  say "H1 patch applied: $H1_PATCH (copy in $OUT/h1-patch.json)"
else
  say "H1 replayed verbatim (no patch)"
fi

stop_here h1
LABELS="$(seq -s, -f 'A%g' 1 "$N_AGENT")"
say "3/7 analyst-agent runs ($LABELS, analyst models: ${ANALYST_MODELS:-deployment default})"
npx tsx scripts/replay/agent-runs.ts --base-url "$BASE_URL" --cohort-id "$COHORT_ID" --count "$N_AGENT" \
  --labels "$LABELS" --analyst-models "$ANALYST_MODELS" --scenario "$SCENARIO" --out "$OUT/agent-runs.json" --log "$LOG" \
  ${RESUME:+--resume}
stop_here agents

if [ "$RESUME" = "1" ] && jsonis "$OUT/fail-then-revise.json" ok true; then
  say "RESUME: 4/7 skipped, the exhibit is already present ($(json "$OUT/fail-then-revise.json" engagementId))"
else
  if [ "$RESUME" = "1" ] && [ -f "$OUT/fail-then-revise.json" ]; then
    echo "RESUME: the exhibit in $OUT/fail-then-revise.json did not complete; it cannot be resumed mid-replay. Start a fresh REGEN_OUT." >&2
    exit 1
  fi
  say "4/7 replay the fail-then-revise exhibit"
  npx tsx scripts/replay/fail-then-revise.ts --base-url "$BASE_URL" --cohort-id "$COHORT_ID" --label exhibit \
    --out "$OUT/fail-then-revise.json" --log "$LOG" "${REPLAY_ARGS[@]}"
fi
stop_here exhibit

say "5/7 label the runs, pin the compare pair, set reviewer visibility"
H1_ID="$(json "$OUT/human-reference.json" engagementId)"
EX_ID="$(json "$OUT/fail-then-revise.json" engagementId)"
RUN_LABELS="H1=$H1_ID,exhibit=$EX_ID"
for i in $(seq 0 $((N_AGENT - 1))); do
  RUN_LABELS="$RUN_LABELS,$(json "$OUT/agent-runs.json" "runs.$i.label")=$(json "$OUT/agent-runs.json" "runs.$i.engagementId")"
done
npx tsx scripts/replay/cohort.ts finalize --base-url "$BASE_URL" --cohort-id "$COHORT_ID" --scenario "$SCENARIO" \
  --human "$H1_ID" --agent "$(json "$OUT/agent-runs.json" runs.0.engagementId)" --labels "$RUN_LABELS" \
  ${H1_PATCH:+--h1-patch "$H1_PATCH"} --out "$OUT/cohort-final.json" --log "$LOG"

say "spend so far (lib/llm/budget.ts: the instructor's readout and the guard's share of the budget)"
npx tsx scripts/replay/spend-report.ts --base-url "$BASE_URL" --cohort-id "$COHORT_ID" --budget "${BUDGET}" \
  --out "$OUT/spend.json" --log "$LOG" || say "WARN: the spend readout failed; see above"

say "6/7 export the snapshot"
if [ "${REGEN_LOCAL:-}" = "1" ]; then
  stop_server
  DB_DRIVER=pglite PGLITE_DIR="$PGDIR" npx tsx scripts/replay/spend-report.ts --offline --out "$OUT/spend.json" \
    | tee -a "$LOG"
  DB_DRIVER=pglite PGLITE_DIR="$PGDIR" npx tsx scripts/showcase-snapshot.ts export \
    --cohort "$COHORT_ID" --out "$OUT/showcase-snapshot.json" | tee -a "$LOG"
else
  npx tsx scripts/showcase-snapshot.ts export --cohort "$COHORT_ID" --out "$OUT/showcase-snapshot.json" | tee -a "$LOG"
fi

say "7/7 write the run map"
# The run map names the snapshot it was written for: the copy in $OUT, or the
# committed path when REGEN_INSTALL=1 puts that copy in place.
if [ "${REGEN_INSTALL:-}" = "1" ]; then MAP_SNAPSHOT="demo/showcase-snapshot.json"; else MAP_SNAPSHOT="$OUT/showcase-snapshot.json"; fi
npx tsx scripts/replay/run-map.ts --dir "$OUT" --snapshot "$OUT/showcase-snapshot.json" \
  --installed-snapshot "$MAP_SNAPSHOT" \
  --out "$OUT/paper-runs.env" --commit "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" | tee -a "$LOG"

if [ "${REGEN_INSTALL:-}" = "1" ]; then
  cp "$OUT/showcase-snapshot.json" demo/showcase-snapshot.json
  cp "$OUT/paper-runs.env" scripts/paper-metrics/paper-runs.env
  say "installed demo/showcase-snapshot.json and scripts/paper-metrics/paper-runs.env"
fi
say "done: $OUT/showcase-snapshot.json, $OUT/paper-runs.env"
