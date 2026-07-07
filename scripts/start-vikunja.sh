#!/usr/bin/env bash
# Configures and launches Vikunja for Replit Autoscale: since Autoscale
# instances are stateless and can be replaced at any time, ALL persistent
# state must live outside this container -- Replit's managed Postgres
# (DATABASE_URL) for data, and a fixed Replit Secret for the JWT signing key.
# Nothing here is allowed to silently fall back to a weaker, data-losing
# default; if required config is missing we fail fast with an exact fix.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/install-vikunja.sh

# --- Database ---------------------------------------------------------
# Default path: Replit-provisioned Postgres via DATABASE_URL (works with
# Autoscale). Set VIKUNJA_DATABASE_TYPE=sqlite explicitly only if you are
# deploying to a Reserved VM instead and want the simpler local-file setup.
if [ "${VIKUNJA_DATABASE_TYPE:-}" = "sqlite" ]; then
  mkdir -p data
  export VIKUNJA_DATABASE_TYPE="sqlite"
  export VIKUNJA_DATABASE_PATH="${VIKUNJA_DATABASE_PATH:-$ROOT_DIR/data/vikunja.db}"
  echo "[start-vikunja] Using local SQLite at $VIKUNJA_DATABASE_PATH (only safe on a Reserved VM, not Autoscale)."
else
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "[start-vikunja] ERROR: DATABASE_URL is not set." >&2
    echo "[start-vikunja] Open the 'Database' pane in your Repl to provision a Postgres" >&2
    echo "[start-vikunja] database (this sets DATABASE_URL automatically), then restart." >&2
    echo "[start-vikunja] (Or set VIKUNJA_DATABASE_TYPE=sqlite as a Secret if you are" >&2
    echo "[start-vikunja]  deploying to a Reserved VM instead of Autoscale.)" >&2
    exit 1
  fi

  # postgres://user:password@host:port/dbname?sslmode=...
  if [[ "$DATABASE_URL" =~ ^postgres(ql)?://([^:@/]+)(:([^@/]*))?@([^:/]+)(:([0-9]+))?/([^?]+)(\?(.*))?$ ]]; then
    DB_USER="${BASH_REMATCH[2]}"
    DB_PASS="${BASH_REMATCH[4]}"
    DB_HOST="${BASH_REMATCH[5]}"
    DB_PORT="${BASH_REMATCH[7]:-5432}"
    DB_NAME="${BASH_REMATCH[8]}"
    DB_QUERY="${BASH_REMATCH[10]:-}"
  else
    echo "[start-vikunja] ERROR: could not parse DATABASE_URL (unexpected format)." >&2
    exit 1
  fi

  DB_SSLMODE="disable"
  if [[ "$DB_QUERY" =~ sslmode=([a-zA-Z-]+) ]]; then
    DB_SSLMODE="${BASH_REMATCH[1]}"
  elif [ "$DB_HOST" != "localhost" ] && [ "$DB_HOST" != "127.0.0.1" ]; then
    DB_SSLMODE="require"
  fi

  export VIKUNJA_DATABASE_TYPE="postgres"
  export VIKUNJA_DATABASE_HOST="${DB_HOST}:${DB_PORT}"
  export VIKUNJA_DATABASE_USER="$DB_USER"
  export VIKUNJA_DATABASE_PASSWORD="$DB_PASS"
  export VIKUNJA_DATABASE_DATABASE="$DB_NAME"
  export VIKUNJA_DATABASE_SSLMODE="$DB_SSLMODE"
  echo "[start-vikunja] Using Postgres at $VIKUNJA_DATABASE_HOST/$DB_NAME (sslmode=$DB_SSLMODE)"
fi

# --- Service / network --------------------------------------------------
# Vikunja itself listens only on an internal port; the gantt-today-line proxy
# (see scripts/gantt-today-line/) owns the public port so it can inject the
# Gantt "today" vertical line into the HTML it serves. See that directory's
# proxy.js for why this can't just be a patch to Vikunja's own files (the
# release binary embeds a prebuilt frontend, nothing left to patch post-install).
PUBLIC_PORT="${VIKUNJA_SERVICE_INTERFACE:-:3456}"
PUBLIC_PORT="${PUBLIC_PORT#:}"
INTERNAL_PORT="${GANTT_PROXY_INTERNAL_PORT:-3457}"

export VIKUNJA_SERVICE_INTERFACE=":${INTERNAL_PORT}"
export VIKUNJA_SERVICE_ENABLEREGISTRATION="${VIKUNJA_SERVICE_ENABLEREGISTRATION:-true}"

# Public URL is required for CORS + correct links. Prefer an explicitly-set
# secret; otherwise derive it from Replit's own deployment domain env var.
if [ -z "${VIKUNJA_SERVICE_PUBLICURL:-}" ]; then
  if [ -n "${REPLIT_DOMAINS:-}" ]; then
    FIRST_DOMAIN="${REPLIT_DOMAINS%%,*}"
    export VIKUNJA_SERVICE_PUBLICURL="https://${FIRST_DOMAIN}"
    echo "[start-vikunja] VIKUNJA_SERVICE_PUBLICURL not set; derived from REPLIT_DOMAINS: $VIKUNJA_SERVICE_PUBLICURL"
  else
    echo "[start-vikunja] ERROR: VIKUNJA_SERVICE_PUBLICURL is not set and REPLIT_DOMAINS is unavailable." >&2
    echo "[start-vikunja] Set VIKUNJA_SERVICE_PUBLICURL as a Replit Secret to your Repl's public URL (e.g. https://tasktracker.yourname.repl.co) and restart." >&2
    exit 1
  fi
fi

# --- JWT signing secret ---------------------------------------------------
# Must be a FIXED value set as a Replit Secret, not auto-generated: on
# Autoscale a freshly-generated-per-instance secret would invalidate every
# login/API token whenever a new instance is spun up.
if [ -z "${VIKUNJA_SERVICE_SECRET:-}" ]; then
  echo "[start-vikunja] ERROR: VIKUNJA_SERVICE_SECRET is not set." >&2
  echo "[start-vikunja] Generate one locally with: openssl rand -hex 32" >&2
  echo "[start-vikunja] then add it as a Replit Secret named VIKUNJA_SERVICE_SECRET and restart." >&2
  exit 1
fi

echo "[start-vikunja] Starting Vikunja on ${VIKUNJA_SERVICE_INTERFACE} (internal), public URL ${VIKUNJA_SERVICE_PUBLICURL}"
./bin/vikunja &
VIKUNJA_PID=$!
trap 'kill "$VIKUNJA_PID" 2>/dev/null || true' EXIT

echo "[start-vikunja] Waiting for Vikunja to become ready on 127.0.0.1:${INTERNAL_PORT}..."
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:${INTERNAL_PORT}/api/v1/info"; then
    break
  fi
  if ! kill -0 "$VIKUNJA_PID" 2>/dev/null; then
    echo "[start-vikunja] ERROR: Vikunja exited before becoming ready." >&2
    wait "$VIKUNJA_PID"
    exit 1
  fi
  sleep 1
done

echo "[start-vikunja] Starting gantt-today-line proxy on :${PUBLIC_PORT} -> 127.0.0.1:${INTERNAL_PORT}"
trap - EXIT
GANTT_PROXY_PUBLIC_PORT="$PUBLIC_PORT" GANTT_PROXY_INTERNAL_PORT="$INTERNAL_PORT" \
  exec node scripts/gantt-today-line/proxy.js
