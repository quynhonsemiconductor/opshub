#!/usr/bin/env bash
# Runs once, when the container first initialises its data directory (docker-entrypoint-initdb.d). Creates the database the e2e
# suite runs against, the same name CI uses (opshub_test), so `scripts/e2e/run.sh` works on a fresh stack with no manual step.
# A stack that already has its data directory does not run this again; it has to be created there by hand.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'opshub_test'" | grep -q 1 \
  || psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c 'CREATE DATABASE opshub_test'
