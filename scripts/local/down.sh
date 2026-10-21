#!/usr/bin/env bash
# `make down`: stops the API, worker and web app started by `make local`, then the containers. Volumes are kept.
#
# Each pid file holds the pid of a `pnpm` wrapper. The wrapper starts the real server (nest, vite) as its child, and killing the
# wrapper alone leaves that child holding the port. So each tree is stopped children first, and any process still alive after
# ten seconds is killed outright.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Prints the pids of every descendant of a process, depth first.
descendants_of() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    echo "$child"
    descendants_of "$child"
  done
}

# Sends TERM to a process and its descendants, deepest first.
terminate_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# Waits up to ten seconds for a pid to exit, then kills it.
wait_or_kill() {
  local pid=$1 i
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

for pid_file in .local/*.pid; do
  [ -f "$pid_file" ] || continue
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    tree=$(descendants_of "$pid")
    terminate_tree "$pid"
    for member in $pid $tree; do wait_or_kill "$member"; done
  fi
  rm -f "$pid_file"
done
docker compose -f docker-compose.dev.yml down
