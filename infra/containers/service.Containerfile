# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One Containerfile for every CommonAir Bun image. Build context is the repo root:
#   podman build -f infra/containers/service.Containerfile --build-arg SERVICE=api \
#     -t localhost/commonair/api:dev .
#
# SERVICE is a directory under services/ (api, chat, irc, origin, media, worker,
# tracker), `web` (apps/web, built with `vp build`), or `tools` (the migrate and
# garage-init one-shot jobs: packages/db + infra).
#
# Only the service's workspace closure (infra/containers/closure.ts) is installed and
# copied. The `media` variant adds FFmpeg from Debian (GPL-2.0-or-later, ADR 0002).

ARG BUN_IMAGE=docker.io/oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

# --- manifests: package.json files, lockfile and dependency patches (patches/) only, so
# the install layer below is cached until a manifest changes (not on every source edit).
FROM ${BUN_IMAGE} AS manifests
ARG SERVICE
WORKDIR /src
COPY . .
RUN set -eu; \
    test -n "${SERVICE}" || { echo "--build-arg SERVICE is required" >&2; exit 1; }; \
    mkdir -p /manifests; \
    find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests/ \; ; \
    cp bun.lock /manifests/; \
    cp -a patches /manifests/; \
    bun infra/containers/closure.ts "${SERVICE}" > /manifests/.closure; \
    bun infra/containers/closure.ts "${SERVICE}" --dev > /manifests/.closure-dev; \
    mkdir -p /sources; \
    for d in $(cat /manifests/.closure-dev); do mkdir -p "/sources/$d" && cp -a "$d/." "/sources/$d/"; done; \
    cp package.json bun.lock tsconfig.base.json /sources/

# --- production dependencies of the closure.
FROM ${BUN_IMAGE} AS deps
# onnxruntime-node's postinstall would fetch CUDA from NuGet on Linux x64. --ignore-scripts
# already stops it; this keeps it off if that flag is ever dropped (ADR 0006 Q2).
ENV ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN set -eu; \
    filters=""; for d in $(cat .closure); do filters="$filters --filter ./$d"; done; \
    bun install --frozen-lockfile --production --ignore-scripts $filters

# --- web build (no-op for every other image).
FROM ${BUN_IMAGE} AS build
ARG SERVICE
ENV ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN set -eu; \
    if [ "${SERVICE}" = web ]; then \
      filters=""; for d in $(cat .closure-dev); do filters="$filters --filter ./$d"; done; \
      bun install --frozen-lockfile --ignore-scripts $filters; \
    fi
COPY --from=manifests /sources/ ./
RUN set -eu; \
    mkdir -p /out; \
    if [ "${SERVICE}" = web ]; then \
      (cd apps/web && ./node_modules/.bin/vp build); \
      mkdir -p /out/web; \
      tar -C apps/web --exclude=./node_modules -cf - . | tar -C /out/web -xf -; \
    fi

# --- runtime.
FROM ${BUN_IMAGE} AS runtime
ARG SERVICE
ARG SOURCE_COMMIT=unknown
# ffmpeg: media transcodes and cuts; api (upload scanning) and worker (live frame scans, NCII
# hashing, evidence frames) decode and encode images through @commonair/moderation, which fails
# closed without it.
RUN set -eu; \
    case "${SERVICE}" in media|api|worker) \
      apt-get update; \
      apt-get install -y --no-install-recommends ffmpeg; \
      rm -rf /var/lib/apt/lists/*; \
      # What @commonair/moderation needs: PNG/JPEG encoders and its image demuxers.
      for e in png mjpeg; do ffmpeg -hide_banner -encoders | grep -qE " $e "; done; \
      for d in png_pipe jpeg_pipe gif webp_pipe bmp_pipe; do ffmpeg -hide_banner -demuxers | grep -qE " $d "; done;; \
    esac; \
    if [ "${SERVICE}" = media ]; then \
      ffmpeg -hide_banner -encoders | grep -q libx264; \
      ffmpeg -hide_banner -encoders | grep -q libwebp; \
      # MEDIA_WORK_DIR: a fresh named volume inherits this ownership.
      install -d -o bun -g bun -m 0750 /var/lib/commonair/media; \
    fi
WORKDIR /app
COPY --from=deps /app/ ./
COPY --from=manifests /sources/ ./
COPY --from=build /out/ /tmp/out/
# Drop sources only the build needed, then lay the web build output over apps/web
# (its node_modules stay the production ones installed above).
RUN set -eu; \
    for d in $(cat .closure-dev); do grep -qx "$d" .closure || rm -rf "$d"; done; \
    if [ -d /tmp/out/web ]; then cp -a /tmp/out/web/. apps/web/; fi; \
    rm -rf /tmp/out .closure-dev
COPY --chmod=0755 infra/containers/entrypoint.sh /opt/commonair/entrypoint.sh
COPY infra/containers/healthcheck.ts /opt/commonair/healthcheck.ts

# Code is root-owned and read-only to the runtime user (uid 1000 `bun`), which keeps
# rootless userns mappings simple and stops a compromised process rewriting itself.
ENV SERVICE=${SERVICE} \
    NODE_ENV=production \
    SOURCE_COMMIT=${SOURCE_COMMIT}
USER bun
# Honoured with `--format docker`; compose and Quadlet declare the same check.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["bun", "/opt/commonair/healthcheck.ts"]
ENTRYPOINT ["/opt/commonair/entrypoint.sh"]
