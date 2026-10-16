# Sourced by scripts/replay/regen.sh and scripts/replay/probes.sh: starts a
# local server on a fresh PGlite directory for one scripted run, and stops it
# with SIGINT. Never runs against a shared database: every database variable
# a .env.local may hold (the production Neon connection among them) is set to
# the empty string in the server's environment, and Next.js does not load a
# .env file value over a variable that is already defined, even as empty.
#
# Inputs (set by the caller):
#   OUT       output directory (server.log goes there)
#   LOG       step log file
#   PORT      port for the server
#   PGDIR     PGlite directory; must not exist yet
#   PROVIDER  LLM provider (mock, anthropic, openai)
#   BUDGET    LLM_DAILY_BUDGET_USD for the server (a plain number)
# Outputs: BASE_URL, SERVER_PID, E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD
# (exported, a generated instructor password for this server only).
# Requires the caller to define say().

# Database and deployment variables that must never reach the local server
# from .env.local.
LOCAL_SERVER_BLANK_VARS=(
  POSTGRES_URL POSTGRES_URL_NON_POOLING POSTGRES_URL_NO_SSL POSTGRES_PRISMA_URL
  POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DATABASE
  DATABASE_URL DATABASE_URL_UNPOOLED PGHOST PGHOST_UNPOOLED PGUSER PGPASSWORD PGDATABASE
  NEON_PROJECT_ID NEON_AUTH_BASE_URL VITE_NEON_AUTH_URL VERCEL_OIDC_TOKEN
  DEMO_MODE ALLOW_DEMO_MODE_WITH_KEY LLM_ANALYST_MODEL SANDBOX_COHORT_SLUG REVIEWER_PASSWORD_HASH
)

SERVER_PID=""

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    say "stopping the local server (SIGINT to process group $SERVER_PID)"
    kill -INT -- "-$SERVER_PID" 2>/dev/null || kill -INT "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      say "WARN: server still running after 60 s; sending SIGTERM"
      kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
      sleep 5
    fi
    say "local server stopped"
  fi
  SERVER_PID=""
}

start_local_server() {
  if [ "${REGEN_RESUME:-}" = "1" ]; then
    if [ ! -d "$PGDIR" ]; then
      echo "REGEN_RESUME=1 needs the PGlite directory of the earlier run, but $PGDIR does not exist." >&2
      exit 1
    fi
    export MIGRATE_NO_RESET=1
    # A stage the previous server was running died with it; do not wait for
    # its start event to go stale (10 min).
    export STAGE_ORPHAN_AFTER_RESTART=1
  elif [ -e "$PGDIR" ]; then
    echo "PGlite directory $PGDIR exists; point it at a new directory (the run must start from an empty database)." >&2
    exit 1
  fi
  BASE_URL="http://localhost:$PORT"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    echo "Port $PORT is in use; choose another port." >&2
    exit 1
  fi
  case "$BUDGET" in
    ''|*[!0-9.]*) echo "The daily budget must be a plain number of USD (got '$BUDGET')." >&2; exit 1 ;;
  esac
  local blank=()
  local v
  for v in "${LOCAL_SERVER_BLANK_VARS[@]}"; do blank+=("$v="); done
  # On the mock no key is needed; blank them so none reaches the server.
  if [ "$PROVIDER" = "mock" ]; then blank+=(ANTHROPIC_API_KEY= OPENAI_API_KEY=); fi

  env "${blank[@]}" DB_DRIVER=pglite PGLITE_DIR="$PGDIR" npx tsx scripts/migrate-local.ts | tee -a "$LOG"

  local admin_hash
  E2E_ADMIN_PASSWORD="$(openssl rand -hex 16)"
  admin_hash="$(node -e 'console.log(require("bcryptjs").hashSync(process.argv[1], 10))' "$E2E_ADMIN_PASSWORD")"
  export E2E_ADMIN_EMAIL=admin E2E_ADMIN_PASSWORD
  say "starting a local server on $BASE_URL (PGlite $PGDIR, provider $PROVIDER, LLM_DAILY_BUDGET_USD=$BUDGET, database variables from .env.local blanked)"
  # setsid puts next and its workers in one process group, so one SIGINT
  # reaches the process that holds PGlite and it closes the directory cleanly.
  setsid env "${blank[@]}" DB_DRIVER=pglite PGLITE_DIR="$PGDIR" LLM_PROVIDER="$PROVIDER" \
    LLM_DAILY_BUDGET_USD="$BUDGET" SHOWCASE_REGEN="${SHOWCASE_REGEN:-}" \
    ADMIN_EMAIL=admin ADMIN_PASSWORD_HASH="$admin_hash" \
    AUTH_SECRET="$(openssl rand -hex 32)" PSEUDONYM_SALT="$(openssl rand -hex 32)" \
    CRON_SECRET="$(openssl rand -hex 16)" AUTH_URL="$BASE_URL" \
    npx next dev -p "$PORT" > "$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  local i
  for i in $(seq 1 120); do
    if curl -sf -o /dev/null "$BASE_URL/admin/login"; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "local server exited; see $OUT/server.log" >&2; exit 1; fi
    sleep 2
    [ "$i" = 120 ] && { echo "local server did not answer within 240 s; see $OUT/server.log" >&2; exit 1; }
  done
  local health
  health="$(curl -s "$BASE_URL/api/health")"
  say "local server is up: $(node -e 'const h=JSON.parse(process.argv[1]);console.log(`provider ${h.provider}, key ${h.keyPresent?"present":"MISSING"}, db ${h.db}, budget set ${h.budgetSet}`)' "$health")"
  if ! node -e 'const h=JSON.parse(process.argv[1]); process.exit(h.db && h.keyPresent && h.budgetSet ? 0 : 1)' "$health"; then
    echo "local server is not usable (database, provider key or budget missing): $health" >&2
    exit 1
  fi
}
