# syntax=docker/dockerfile:1
# =============================================================================
# opshub — Production Dockerfile (multi-target)
# =============================================================================
# Targets:
#   api       → HTTP API server          (default)
#   worker    → Background job processor
#   migrator  → One-shot Drizzle migration runner (CI gate job)
#
# Build:
#   docker build --target api      -t opshub-api:latest .
#   docker build --target worker   -t opshub-worker:latest .
#   docker build --target migrator -t opshub-migrator:latest .
# =============================================================================

ARG NODE_VERSION=24
ARG ALPINE_VERSION=3.22
ARG PNPM_VERSION=10.33.2

# ── deps: all packages (dev+prod) for the builder ────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=secret,id=node_auth_token \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" && \
    pnpm config set store-dir /root/.local/share/pnpm/store && \
    HUSKY=0 pnpm install --frozen-lockfile

# ── prod-deps: production-only node_modules for runtime images ────────────────
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS rds-ca
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /bundle.pem
RUN chmod 0644 /bundle.pem

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS prod-deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=secret,id=node_auth_token \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" && \
    pnpm config set store-dir /root/.local/share/pnpm/store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ── builder: compile the NestJS monorepo ─────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS builder
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build:api
RUN pnpm build:worker
# Compile Migrator  →  dist/db/
# Pre-compiling eliminates tsx (and its embedded esbuild Go binaries) from the
# migrator runtime image, removing the CVE surface without .trivyignore suppression.
RUN pnpm build:migrator

# ── api (default) ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS api
# Upgrade all Alpine packages to latest security patches within the pinned Alpine
# version, and remove the base image's global npm — it is unused at runtime (the app
# runs via `node dist/...`) and its BUNDLED node-tar carries a CRITICAL CVE
# (CVE-2026-59873, tar 7.5.13 < 7.5.19) that neither `apk upgrade` nor a pnpm override
# can patch, because it is npm's own vendored copy rather than a dependency of ours.
# Same treatment as rova.
RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
    && rm -rf /var/cache/apk/*
ENV NODE_ENV=production
# The RDS global CA bundle (public certificates only) for DATABASE_SSL_CA. The
# default points at the baked file; a task definition may override it (on-prem:
# the CNPG ca.crt). Fetched at build time, unpinned on purpose: the bundle gains
# CAs over time and a stale local copy would fail verification against new
# instances instead of being silently wrong. Own stage so it is fetched once and
# lands world-readable: a remote ADD is root-owned 0600, and the runtime users
# (nestjs/migrator) must read it.
COPY --from=rds-ca /bundle.pem /etc/ssl/rds-global-bundle.pem
ENV DATABASE_SSL_CA=/etc/ssl/rds-global-bundle.pem
ENV NODE_OPTIONS="--max-old-space-size=512"
ENV PORT=3000
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/api ./dist/apps/api
COPY --from=builder /app/package.json ./
RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 nestjs \
    && chown -R nestjs:nodejs /app
USER nestjs
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/apps/api/apps/api/src/main.js"]
# `/v1/healthz`, not `/healthz`. `bootstrapApp` calls `setGlobalPrefix('v1')`, so the unprefixed path
# is a 404 — and a HEALTHCHECK that always fails marks the image permanently unhealthy to anything
# that honours it: `docker run`, compose, and image scanners. ECS and the ALB were unaffected because
# they use the target-group health check with the correct path, which is why this went unnoticed.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/v1/healthz || exit 1

# ── worker ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS worker
# Upgrade all Alpine packages to latest security patches within the pinned Alpine
# version, and remove the base image's global npm — it is unused at runtime (the app
# runs via `node dist/...`) and its BUNDLED node-tar carries a CRITICAL CVE
# (CVE-2026-59873, tar 7.5.13 < 7.5.19) that neither `apk upgrade` nor a pnpm override
# can patch, because it is npm's own vendored copy rather than a dependency of ours.
# Same treatment as rova.
RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
    && rm -rf /var/cache/apk/*
ENV NODE_ENV=production
# The RDS global CA bundle (public certificates only) for DATABASE_SSL_CA. The
# default points at the baked file; a task definition may override it (on-prem:
# the CNPG ca.crt). Fetched at build time, unpinned on purpose: the bundle gains
# CAs over time and a stale local copy would fail verification against new
# instances instead of being silently wrong. Own stage so it is fetched once and
# lands world-readable: a remote ADD is root-owned 0600, and the runtime users
# (nestjs/migrator) must read it.
COPY --from=rds-ca /bundle.pem /etc/ssl/rds-global-bundle.pem
ENV DATABASE_SSL_CA=/etc/ssl/rds-global-bundle.pem
ENV NODE_OPTIONS="--max-old-space-size=256"
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder   /app/dist/apps/worker ./dist/apps/worker
COPY --from=builder   /app/package.json ./
RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 nestjs \
    && chown -R nestjs:nodejs /app
USER nestjs
# ECS bridge: materialize the injected GRAPH_CLIENT_CERTIFICATE secret value as
# the file AZURE_CLIENT_CERTIFICATE_PATH and unset it (worker only; see the
# script header).
COPY docker/graph-cert-bridge.sh /app/docker/graph-cert-bridge.sh
ENTRYPOINT ["/sbin/tini", "--", "/bin/sh", "/app/docker/graph-cert-bridge.sh"]
CMD ["node", "dist/apps/worker/apps/worker/src/main.js"]

# ── migrator (one-shot Drizzle migration runner) ─────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS migrator
# Upgrade all Alpine packages to latest security patches within the pinned Alpine
# version, and remove the base image's global npm — it is unused at runtime (the app
# runs via `node dist/...`) and its BUNDLED node-tar carries a CRITICAL CVE
# (CVE-2026-59873, tar 7.5.13 < 7.5.19) that neither `apk upgrade` nor a pnpm override
# can patch, because it is npm's own vendored copy rather than a dependency of ours.
# Same treatment as rova.
RUN apk upgrade --no-cache \
    && apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
    && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
    && rm -rf /var/cache/apk/*
ENV NODE_ENV=production
# The RDS global CA bundle (public certificates only) for DATABASE_SSL_CA. The
# default points at the baked file; a task definition may override it (on-prem:
# the CNPG ca.crt). Fetched at build time, unpinned on purpose: the bundle gains
# CAs over time and a stale local copy would fail verification against new
# instances instead of being silently wrong. Own stage so it is fetched once and
# lands world-readable: a remote ADD is root-owned 0600, and the runtime users
# (nestjs/migrator) must read it.
COPY --from=rds-ca /bundle.pem /etc/ssl/rds-global-bundle.pem
ENV DATABASE_SSL_CA=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
# Production deps only — tsx and esbuild (with Go CVE binaries) are devDeps,
# so they are absent here. This is the key CVE fix.
COPY --from=prod-deps /app/node_modules ./node_modules
# Pre-compiled JS (dist/db/) from the builder stage.
# Raw SQL migrations go into dist/db/migrations — matches __dirname in compiled migrate.js.
COPY --from=builder /app/dist/db ./dist/db
COPY --from=builder /app/db/migrations ./dist/db/migrations
COPY --from=builder /app/package.json ./
RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 migrator \
    && chown -R migrator:nodejs /app
USER migrator
ENTRYPOINT ["/sbin/tini", "--"]
# Plain node runs pre-compiled JS — no tsx, no esbuild, no Go binaries.
CMD ["node", "dist/db/migrate.js"]
