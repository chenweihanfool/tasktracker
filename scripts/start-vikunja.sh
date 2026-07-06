#!/usr/bin/env bash
# Configures and launches Vikunja. All persistent state (SQLite DB, JWT
# signing secret) lives under ./data so it survives restarts as long as this
# Repl is deployed as a Reserved VM (see .replit) rather than Autoscale.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/install-vikunja.sh

mkdir -p data

# --- Database -----------------------------------------------------------
export VIKUNJA_DATABASE_TYPE="${VIKUNJA_DATABASE_TYPE:-sqlite}"
export VIKUNJA_DATABASE_PATH="${VIKUNJA_DATABASE_PATH:-$ROOT_DIR/data/vikunja.db}"

# --- Service / network ----------------------------------------------------
export VIKUNJA_SERVICE_INTERFACE="${VIKUNJA_SERVICE_INTERFACE:-:3456}"
export VIKUNJA_SERVICE_ENABLEREGISTRATION="${VIKUNJA_SERVICE_ENABLEREGISTRATION:-true}"

# Public URL is required for CORS + correct links in emails/attachments.
# Prefer an explicitly-set secret; otherwise derive it from Replit's own
# deployment domain env var so this works without extra manual config.
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

# --- JWT signing secret ----------------------------------------------------
# If not provided via Replit Secrets, generate one ONCE and persist it to
# disk so restarts don't invalidate every issued login token / API token.
SECRET_FILE="$ROOT_DIR/data/.service_secret"
if [ -z "${VIKUNJA_SERVICE_SECRET:-}" ]; then
  if [ ! -f "$SECRET_FILE" ]; then
    openssl rand -hex 32 > "$SECRET_FILE" 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "[start-vikunja] Generated a new persistent VIKUNJA_SERVICE_SECRET at $SECRET_FILE"
  fi
  export VIKUNJA_SERVICE_SECRET="$(cat "$SECRET_FILE")"
fi

echo "[start-vikunja] Starting Vikunja on ${VIKUNJA_SERVICE_INTERFACE}, public URL ${VIKUNJA_SERVICE_PUBLICURL}"
exec ./bin/vikunja
