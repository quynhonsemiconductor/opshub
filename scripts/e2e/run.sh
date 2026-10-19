#!/usr/bin/env bash
# Runs the backend e2e suite against an ISOLATED stack: its own compose project, ephemeral loopback ports (no fixed host
# port is used), a migrated and reset database.
#
#   scripts/e2e/run.sh [vitest args...]        # whole suite, or the files you name
#   E2E_KEEP=1 scripts/e2e/run.sh              # leave the stack up afterwards (default: `down -v`; the stack is disposable)
#   COMPOSE_PROJECT_NAME=opshub-e2e-alice scripts/e2e/run.sh   # a name for this run (default: opshub-e2e-<random>)
#
# Never run this against a stack you did not start: the suite truncates the database it points at.
set -euo pipefail
cd "$(dirname "$0")/../.."

files=(-f docker-compose.dev.yml -f docker-compose.e2e.yml)
project=${COMPOSE_PROJECT_NAME:-opshub-e2e-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')}

# Free ports for the processes this script starts on the host (the SPA and the API). Asked of the OS, not fixed.
free_port() {
  node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}
export E2E_PORT_WEB=$(free_port)
export E2E_PORT_API=$(free_port)

COMPOSE_PROJECT_NAME=$project node scripts/e2e/make-env.mjs .env.e2e >/dev/null
docker compose -p "$project" --env-file .env.e2e "${files[@]}" up -d --wait

# The containers' ephemeral ports, as Docker assigned them.
port_of() { docker compose -p "$project" "${files[@]}" port "$1" "$2" | awk -F: '{print $NF}'; }
export E2E_PORT_POSTGRES=$(port_of postgres 5432)
export E2E_PORT_VALKEY=$(port_of valkey 6379)
export E2E_PORT_LOCALSTACK=$(port_of localstack 4566)
export E2E_PORT_MAILPIT_SMTP=$(port_of mailpit 1025)
export E2E_PORT_MAILPIT_UI=$(port_of mailpit 8025)
export E2E_PORT_OTEL_OTLP=$(port_of otel 4318)
export E2E_PORT_OTEL_METRICS=$(port_of otel 8889)
COMPOSE_PROJECT_NAME=$project node scripts/e2e/make-env.mjs .env.e2e >/dev/null

# Migrations and the reset read the env as plain shell variables (they do not load .env themselves).
set -a
. ./.env.e2e
set +a
pnpm db:migrate

status=0
E2E_ENV_FILE=.env.e2e pnpm exec vitest run --config test/vitest.e2e.config.ts "$@" || status=$?

if [ "${E2E_KEEP:-0}" != 1 ]; then
  docker compose -p "$project" --env-file .env.e2e "${files[@]}" down -v
fi
exit "$status"
