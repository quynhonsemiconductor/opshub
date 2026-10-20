#!/usr/bin/env bash
# `make down`: stops the API, worker and web app started by `make local`, then the containers. Volumes are kept.
set -euo pipefail
cd "$(dirname "$0")/../.."

for pid_file in .local/*.pid; do
  [ -f "$pid_file" ] || continue
  pid=$(cat "$pid_file")
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
done
docker compose -f docker-compose.dev.yml down
