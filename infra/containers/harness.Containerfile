# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The seed harness image, for staging seed mode only (ADR 0040): `selfhost.sh seed-mode run` runs
# `bun harness/src/cli.ts seed full` in it, on the instance's own network. No instance runs it
# otherwise. Build context is the repo root:
#   podman build -f infra/containers/harness.Containerfile -t localhost/commonair/harness:dev .
#
# Playwright's own image at the version harness/package.json pins (its Chromium and WebKit with
# their system libraries, for `seed-coverage`), plus:
# - Bun, from the pinned Bun image;
# - Go, from the pinned Go image: seed-media builds the member relay from relay/ (standard library
#   only, no module downloads), and its readiness check asks for `go version`. The relay is built
#   once here, into the cache harness/src/relay.ts buildRelay reads, so a run needs no compiler work;
# - FFmpeg 8.1, the same static BtbN build CI uses (.github/actions/setup), checked against its
#   SHA-256 per architecture: Ubuntu noble's 6.1 lacks options the harness passes (`-readrate_catchup`,
#   ffmpeg 7+) and the WHIP muxer. With libx264 and aac to publish, RTMP to publish to MediaMTX and to
#   listen as the simulcast sink, libopus for the captions audio. GPL-3.0-or-later.
# The whole repository source goes in, with every workspace's production dependencies: the
# harness imports across workspaces (packages/i18n, apps/web's locale files, the moderation
# fixtures). It runs as the container's root, which rootless Podman maps to the instance's user,
# so it can write the reports directory selfhost.sh mounts.

ARG BASE_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
ARG BUN_IMAGE=docker.io/oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
ARG GO_IMAGE=docker.io/library/golang:1.27.3-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4

FROM ${BUN_IMAGE} AS bun
FROM ${GO_IMAGE} AS go

FROM ${BASE_IMAGE}
ARG SOURCE_COMMIT=unknown
ARG TARGETARCH
ARG FFMPEG_BUILD=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=linux64; sum=97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79 ;; \
      arm64) arch=linuxarm64; sum=10523d1e0be6b3ce62a9708cc50815c4b5eb5f36ae147fbe2afeecda6f2d6845 ;; \
      *) echo "no FFmpeg build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    curl -fsSL --retry 3 --max-time 600 -o /tmp/ffmpeg.tar.xz "${FFMPEG_BUILD}-${arch}-gpl-8.1.tar.xz"; \
    echo "${sum}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'; \
    rm /tmp/ffmpeg.tar.xz; \
    apt-get purge -y xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    for e in libx264 aac libopus; do ffmpeg -hide_banner -encoders | grep -qE " $e "; done; \
    ffmpeg -hide_banner -protocols | grep -qx '  rtmp'; \
    ffmpeg -hide_banner -h full | grep -q readrate_catchup
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=go /usr/local/go /usr/local/go
# onnxruntime-node's postinstall would fetch CUDA from NuGet; --ignore-scripts stops it too.
ENV PATH=/usr/local/go/bin:${PATH} \
    CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    ONNXRUNTIME_NODE_INSTALL=skip \
    SOURCE_COMMIT=${SOURCE_COMMIT}
WORKDIR /app
COPY . .
RUN set -eu; \
    bun install --frozen-lockfile --production --ignore-scripts; \
    bun -e 'const { buildRelay } = await import("./harness/src/relay.ts"); console.log(await buildRelay());'; \
    go version; \
    bun --version
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "--version"]
CMD ["sleep", "infinity"]
