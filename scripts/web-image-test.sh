#!/usr/bin/env bash
# =============================================================================
# Container test for the web image (apps/web/Dockerfile + apps/web/Caddyfile).
#
# Builds the image from the repo root, runs it the way the chart runs it (read-only root filesystem,
# a writable /tmp, config.json mounted at /srv/config.json, an arbitrary non-root uid, port 8080),
# and exercises the serving contract.
#
#   contract      /healthz and /livez 200; doc root /srv; the process runs as the uid asked for;
#                 the SPA fallback answers an unknown client-side route
#   caching       /, /config.json and SPA routes no-cache; an existing /assets/* immutable; a MISSING
#                 asset 404 with no Cache-Control promise
#   headers       every value of the Worker's `_headers`; no Server fingerprint anywhere
#   config        the mounted file is served as JSON, and its absence is a 404 (the SPA shows its
#                 startup error instead of booting with defaults)
#
# A PASS must fail on broken input: every assertion is a real HTTP response from the image.
#
# Usage (the build needs the GitHub Packages token for @quynhonsemiconductor/*):
#   NODE_AUTH_TOKEN=$(gh auth token) scripts/web-image-test.sh
#
# Containers use this process's PID in their names and are removed on exit; nothing here touches the
# owner's stacks or the default compose project.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
: "${NODE_AUTH_TOKEN:?NODE_AUTH_TOKEN is required (it authenticates the pnpm install in the image build)}"

image="opshub-web:test-$$"
web="opshub-web-test-web-$$"
web_noconfig="opshub-web-test-web-noconfig-$$"
tmpdir="$(mktemp -d)"

cleanup() {
  docker rm -f "$web" "$web_noconfig" >/dev/null 2>&1 || true
  docker image rm -f "$image" >/dev/null 2>&1 || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

pass=0
failed=0
ok() { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf '  FAIL  %s: %s\n' "$1" "$2"; }

# The whole response headers of one request, as `curl -D -` prints them.
headers() { curl -sS --max-time 10 --path-as-is -D - -o /dev/null "$@"; }
status() { curl -sS --max-time 10 --path-as-is -o /dev/null -w '%{http_code}' "$@"; }
header_of() {
  local h=$1
  shift
  headers "$@" | tr -d '\r' | grep -i "^$h:" | head -1 | sed 's/^[^:]*:[[:space:]]*//'
}

expect_status() {
  local what=$1 want=$2
  shift 2
  local got
  got="$(status "$@")"
  if [ "$got" = "$want" ]; then ok "$what ($want)"; else bad "$what" "expected $want, got $got"; fi
}

expect_header() {
  local what=$1 header=$2 want=$3
  shift 3
  local got
  got="$(header_of "$header" "$@")"
  if [ "$got" = "$want" ]; then ok "$what ($header: $want)"; else bad "$what" "expected '$header: $want', got '$got'"; fi
}

expect_no_header() {
  local what=$1 header=$2
  shift 2
  if headers "$@" | tr -d '\r' | grep -qi "^${header}:"; then
    bad "$what" "expected no $header header"
  else
    ok "$what (no $header)"
  fi
}

printf '{"apiBaseUrl":"","appEnv":"production","devLoginEnabled":false}' > "$tmpdir/config.json"

echo "== build the image"
docker build -q -f apps/web/Dockerfile --target web \
  --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t "$image" . >/dev/null

echo "== start the image (read-only root, uid 12345, config mounted)"
docker run -d --name "$web" --read-only --tmpfs /tmp \
  --user 12345 -p 127.0.0.1::8080 \
  -v "$tmpdir/config.json:/srv/config.json:ro" "$image" >/dev/null

for _ in $(seq 1 30); do
  port="$(docker port "$web" 8080/tcp 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
: "${port:?the container never answered on 8080}"
base="http://127.0.0.1:$port"
asset="$(docker exec --user 0 "$web" sh -c 'ls /srv/assets | grep -E "^index-.*\.js$" | head -1')"

echo "== the image contract"
uid="$(docker exec --user 0 "$web" sh -c 'grep ^Uid /proc/1/status' | awk '{print $2}')"
if [ "$uid" = "12345" ]; then ok "the server runs as the uid the pod asked for (12345)"; else bad "non-root uid" "expected 12345, got $uid"; fi
root="$(docker exec --user 0 "$web" sh -c 'test -f /srv/index.html && echo /srv')"
if [ "$root" = "/srv" ]; then ok "doc root /srv holds index.html"; else bad "doc root" "/srv/index.html is missing"; fi
expect_status "/healthz" 200 "$base/healthz"
# The chart hardcodes liveness to /livez (admission rejects any other path). Both assertions matter:
# status alone would also pass against the SPA fallback, so require the probe's own one-word answer.
expect_status "/livez" 200 "$base/livez"
livez_body="$(curl -sS --max-time 10 "$base/livez")"
if [ "$livez_body" = "ok" ]; then
  ok "/livez answers the probe, not the SPA fallback"
else
  bad "/livez body" "expected 'ok', got '$(printf '%.40s' "$livez_body")'"
fi
expect_status "/" 200 "$base/"
expect_status "/config.json (mounted)" 200 "$base/config.json"
expect_status "unknown path falls back to the SPA" 200 "$base/some/spa/route"
expect_header "the config is JSON" content-type "application/json" "$base/config.json"

echo "== caching"
expect_header "/ is no-cache" cache-control "no-cache" "$base/"
expect_header "/config.json is no-cache" cache-control "no-cache" "$base/config.json"
expect_header "the SPA fallback is no-cache" cache-control "no-cache" "$base/some/spa/route"
expect_header "/$asset is immutable" cache-control "public, max-age=31536000, immutable" "$base/assets/$asset"
expect_status "a missing asset is a 404" 404 "$base/assets/nope.js"
expect_no_header "a missing asset promises nothing (no immutable)" cache-control "$base/assets/nope.js"

echo "== headers (Worker _headers parity, every header under /*)"
# The Cloudflare manifest is the source of truth: read the headers the Worker serves under `/*` and
# require the image to answer each one with the same value, so a Caddyfile edit that forgets
# `_headers` (or the reverse) fails here. Parsing the file, not a copy in this script, is the point.
headers_file="$REPO_ROOT/apps/web/public/_headers"
declared="$(awk '
  /^\/\*$/ { in_block = 1; next }
  in_block && /^[[:space:]]*$/ { exit }
  in_block && /^[[:space:]]+[A-Za-z0-9-]+:/ {
    sub(/^[[:space:]]+/, "")
    print
  }
' "$headers_file")"
if [ -n "$declared" ]; then
  ok "the _headers /* block parsed"
else
  bad "_headers /* block" "no headers found in $headers_file"
fi
while IFS= read -r declared_header; do
  [ -n "$declared_header" ] || continue
  name="${declared_header%%:*}"
  want="${declared_header#*: }"
  expect_header "_headers parity: $name" "$name" "$want" "$base/"
done <<< "$declared"
expect_no_header "no Server fingerprint" Server "$base/"

echo "== a deployment that forgot the config"
docker run -d --name "$web_noconfig" --read-only --tmpfs /tmp \
  --user 12345 -p 127.0.0.1::8080 "$image" >/dev/null
for _ in $(seq 1 30); do
  noconfig_port="$(docker port "$web_noconfig" 8080/tcp 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  [ -n "$noconfig_port" ] && curl -sf "http://127.0.0.1:$noconfig_port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
noconfig_base="http://127.0.0.1:${noconfig_port:?the container never answered on 8080}"
expect_status "an absent /config.json is a 404, not the SPA fallback" 404 "$noconfig_base/config.json"
expect_header "an absent /config.json is not cached" cache-control "no-cache" "$noconfig_base/config.json"

echo
echo "== $pass passed, $failed failed"
[ "$failed" -eq 0 ]
