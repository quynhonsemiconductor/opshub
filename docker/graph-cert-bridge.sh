#!/bin/sh
# ECS bridge for the Graph Service-app certificate (ONPREM-PLAN §7.3).
#
# The app reads the credential from the FILE at AZURE_CLIENT_CERTIFICATE_PATH.
# On ECS there is no file mount yet: the task definition injects the standalone
# secret (readable only by the worker's execution role) as the
# GRAPH_CLIENT_CERTIFICATE environment value. This bridge materializes that
# value as a worker-only file and points the app at it, then UNSETS the value:
# the PEM must not stay in the wrapped command's env. When the on-prem k3s move
# mounts the file (or sets the federated token), the bridge is a no-op: a
# preset AZURE_CLIENT_CERTIFICATE_PATH always wins.
#
# Worker image only — the API container is never given the secret, so it never
# runs this script.
set -eu

cert_file="${GRAPH_CERT_FILE:-/tmp/opshub-graph-cert.pem}"

if [ -n "${GRAPH_CLIENT_CERTIFICATE:-}" ] && [ -z "${AZURE_CLIENT_CERTIFICATE_PATH:-}" ]; then
  (umask 077 && printf '%s\n' "$GRAPH_CLIENT_CERTIFICATE" > "$cert_file")
  export AZURE_CLIENT_CERTIFICATE_PATH="$cert_file"
fi

# §7.3: the app reads the FILE; the PEM must not stay in the process env.
unset GRAPH_CLIENT_CERTIFICATE || true

exec "$@"
