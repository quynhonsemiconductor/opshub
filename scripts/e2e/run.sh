#!/usr/bin/env bash
# Runs the backend e2e suite against an ISOLATED stack: its own compose project, ephemeral loopback ports (no fixed host port is
# used), a migrated and reset database. The suite starts the API in-process, so no host web server or API port is needed here.
#
#   scripts/e2e/run.sh [vitest args...]                 # whole suite, or the files you name
#   E2E_KEEP=1 scripts/e2e/run.sh                       # keep the stack up afterwards and print its project name
#   E2E_PROJECT=opshub-e2e-alice scripts/e2e/run.sh     # a name for this run (default: random). Not COMPOSE_PROJECT_NAME.
#
# The env file is per run (.env.e2e.<project>) and is removed on exit. Never point this at a stack you did not start.
set -euo pipefail
cd "$(dirname "$0")/../.."

files=(-f docker-compose.dev.yml -f docker-compose.e2e.yml)
project=${E2E_PROJECT:-opshub-e2e-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')}
envfile=".env.e2e.$project"

if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]; then
  echo "refusing to run: compose project $project already has containers. Pick another E2E_PROJECT." >&2
  exit 1
fi

compose() { docker compose -p "$project" --env-file "$envfile" "${files[@]}" "$@"; }

cleanup() {
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "kept compose project $project (env file $envfile). Remove it with: docker compose -p $project --env-file $envfile ${files[*]} down -v && rm $envfile"
  else
    compose down -v || true
    rm -f "$envfile"
  fi
}
trap cleanup EXIT

# A starting env for compose only: the ports are not known until the containers exist.
node scripts/e2e/make-env.mjs "$envfile" >/dev/null
compose up -d --wait

# The containers' ephemeral ports, as Docker assigned them.
port_of() { compose port "$1" "$2" | awk -F: '{print $NF}'; }
export E2E_PORT_POSTGRES=$(port_of postgres 5432)
export E2E_PORT_VALKEY=$(port_of valkey 6379)
export E2E_PORT_STORAGE=$(port_of garage 3900)
export E2E_PORT_MAILPIT_SMTP=$(port_of mailpit 1025)
export E2E_PORT_MAILPIT_UI=$(port_of mailpit 8025)
export E2E_PORT_OTEL_OTLP=$(port_of otel 4318)
export E2E_PORT_OTEL_METRICS=$(port_of otel 8889)
# The web and API ports are not started by this suite; they only fill the env file's URLs with free ports of this run.
export E2E_PORT_WEB=$(node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
export E2E_PORT_API=$(node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
COMPOSE_PROJECT_NAME=$project node scripts/e2e/make-env.mjs "$envfile" --strict >/dev/null

# Migrations and the reset read the env as plain shell variables (they do not load .env themselves).
set -a
. "./$envfile"
set +a
pnpm db:migrate

E2E_ENV_FILE="$envfile" pnpm exec vitest run --config test/vitest.e2e.config.ts "$@"
