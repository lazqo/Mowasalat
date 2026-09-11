#!/usr/bin/env bash
#
# Starts everything the apps talk to, with one command.
#
#   ./tools/dev.sh
#
# Brings up Postgres and Redis (via Docker if it is there), creates the
# database, loads the five pilot lines, prints the address a phone should use,
# and runs the API in the foreground. Ctrl-C stops it.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_PORT="${PG_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
API_PORT="${PORT:-3000}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- Postgres and Redis ------------------------------------------------------
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  say "starting Postgres and Redis"
  docker start mwsl-pg >/dev/null 2>&1 || docker run -d --name mwsl-pg \
    -e POSTGRES_PASSWORD=dev -p "$PG_PORT:5432" postgres:16 >/dev/null
  # Redis must not persist: live movement never touches a disk.
  docker start mwsl-redis >/dev/null 2>&1 || docker run -d --name mwsl-redis \
    -p "$REDIS_PORT:6379" redis:7 redis-server --save '' --appendonly no >/dev/null

  export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:dev@localhost:$PG_PORT/postgres}"
  printf 'waiting for Postgres'
  for _ in $(seq 1 30); do
    docker exec mwsl-pg pg_isready -q 2>/dev/null && break
    printf '.'; sleep 1
  done
  echo
else
  echo "Docker is not running — expecting Postgres and Redis to be up already."
  : "${DATABASE_URL:?set DATABASE_URL, or start Docker and re-run}"
fi

export REDIS_URL="${REDIS_URL:-redis://localhost:$REDIS_PORT}"

# --- Secrets, generated once and kept in .env.local ---------------------------
if [ ! -f .env.local ]; then
  say "generating local secrets (.env.local, git-ignored)"
  {
    echo "ADMIN_TOKEN=$(openssl rand -hex 16)"
    echo "PHONE_SALT=$(openssl rand -hex 16)"
    echo "OTP_SECRET=$(openssl rand -hex 16)"
  } > .env.local
fi
set -a; . ./.env.local; set +a

# Development only: the OTP comes back in the response, so a tester never waits
# for an SMS. The provider that does this refuses to exist in production.
export NODE_ENV="${NODE_ENV:-development}"

# The web passenger page is a browser origin, and a browser will not call an API
# that has not named it. Locally the page is served from whatever address the
# laptop happens to have, so any origin is allowed here. A deployment sets this
# to the one page it serves.
export WEB_ORIGINS="${WEB_ORIGINS:-*}"

# --- The pilot lines ----------------------------------------------------------
say "loading the five Irbid ↔ Bani Kinana lines"
npm run --silent seed

# --- What a phone should point at ---------------------------------------------
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '')"

if [ -n "$LAN_IP" ]; then
  PHONE_URL="http://$LAN_IP:$API_PORT/health"
else
  PHONE_URL="(could not detect a LAN address — find this machine's IP by hand)"
fi

say "ready"
cat <<INFO
  This machine        http://localhost:$API_PORT/health
  From a phone        $PHONE_URL
  Ops admin           http://localhost:$API_PORT/v1/admin?token=$ADMIN_TOKEN

  Build the apps against:
    Flutter   --dart-define=API_BASE=http://${LAN_IP:-YOUR_IP}:$API_PORT
    Web       API_BASE=http://${LAN_IP:-YOUR_IP}:$API_PORT npm run build:web
              then  node tools/serve.mjs apps/web-passenger/dist

  Open the phone address in the phone's browser first. If it does not load,
  it is the WiFi, not the app.

INFO

npm run api
