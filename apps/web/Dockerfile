# syntax=docker/dockerfile:1
# =============================================================================
# OpsHub web — the SPA as a static image (DELIVERY-DESIGN-2026-11 §3.1)
# =============================================================================
# One image for every environment. The bundle is built ONCE and promoted by digest, like the API's;
# everything that differs between dev and prod (`/config.json`) is mounted at deploy time, so there
# is no per-environment build to drift.
#
# Target: web
#
# Build (the context is the REPO ROOT — pnpm workspace, root lockfile):
#   docker build -f apps/web/Dockerfile --target web \
#     --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t opshub-web:local .
#
# Runtime contract (the qnsc-service chart's `web:` block supplies it):
#   - listens on 8080, doc root /srv (index.html at its root), health /healthz
#   - config.json at /srv/config.json — a gitops-rendered ConfigMap, mounted as a file over the
#     read-only root filesystem. Absent = the SPA shows its "could not start" screen, by design.
#   - /tmp is the ONLY writable path (emptyDir): Caddy's only writes (its config autosave), under
#     XDG_* below. The image therefore runs as ANY non-root uid (it defaults to 1001).
# =============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 │ build
# Only the web workspace's dependencies: the API's toolchain (Nest, Drizzle) is dead weight and
# extra CVE surface for a static bundle.
# ─────────────────────────────────────────────────────────────────────────────
# node:24-alpine3.22 — the tag stays for Renovate and readers; the digest is what is built.
FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS build
RUN corepack enable

WORKDIR /app

# The build runs `pnpm --filter opshub-web build` with a filtered install, so the API workspace is
# never installed; pnpm 11's implicit "node_modules is stale, install first" check would then try to
# install the whole workspace (and fail: no registry token in that step). Same setting as the root
# Dockerfile's builder stage.
ENV pnpm_config_verify_deps_before_run=false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches

# The workspace member's manifest must exist before a filtered install can resolve it.
COPY apps/web/package.json ./apps/web/package.json

RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=secret,id=node_auth_token \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" && \
    pnpm config set store-dir /root/.local/share/pnpm/store && \
    export NPM_CONFIG_USERCONFIG="$(mktemp)" && \
    printf '%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > "$NPM_CONFIG_USERCONFIG" && \
    HUSKY=0 pnpm install --frozen-lockfile --filter opshub-web... && \
    rm -f "$NPM_CONFIG_USERCONFIG"

COPY apps/web ./apps/web

# TypeScript project build + Vite bundle → apps/web/dist
RUN pnpm --filter opshub-web build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 │ web  (the image)
# Caddy, not nginx: see apps/web/Caddyfile for the reason.
# ─────────────────────────────────────────────────────────────────────────────
# caddy:2.11.7-alpine — tag for Renovate, digest for reproducibility.
FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS web

# Latest patches within the pinned Alpine: Trivy gates on fixable CRITICALs and the base's busybox
# and libssl move faster than the tag.
RUN apk upgrade --no-cache && rm -rf /var/cache/apk/*

# The upstream image ships Caddy with a FILE capability (cap_net_bind_service=ep) so root can bind
# port 80/443. This image listens on 8080 and runs as an unprivileged user, so it needs none — and
# the capability is worse than useless here: a runtime that drops ALL capabilities (the chart's
# securityContext, or `docker run --cap-drop ALL`) cannot exec a binary carrying one, and the pod
# dies with `exec /usr/bin/caddy: operation not permitted`. Removing the xattr is what lets it run
# under that policy; the assertion fails the BUILD if a base-image bump brings the cap back.
RUN apk add --no-cache --virtual .caddy-cap libcap && \
    setcap -r /usr/bin/caddy && \
    test -z "$(getcap /usr/bin/caddy)" && \
    apk del .caddy-cap

COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile

# An unparseable Caddyfile must fail the BUILD, not the pod's first start.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# The upstream image has no service user (the official image runs Caddy as root by default); create
# one instead of shipping only root. UID/GID 1001 match the ownership of the caddy binary and files.
RUN addgroup -S -g 1001 caddy && adduser -S -D -H -u 1001 -G caddy -s /sbin/nologin caddy

# Read-only root filesystem: every path Caddy writes is under /tmp. HOME matters because Caddy
# resolves its config/data dirs from XDG (or HOME) and the service user's home is not writable.
ENV XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data \
    HOME=/tmp

# Nothing in the image is writable by it except /tmp.
USER caddy

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
