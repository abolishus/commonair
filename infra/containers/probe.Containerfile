# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Adds BusyBox (for `wget` in healthchecks) to upstream images that ship without a
# shell (OpenTelemetry Collector, Loki, Tempo). The upstream image is otherwise
# unchanged; BASE_IMAGE must be a pinned entry of infra/image-licenses.json.
#   podman build -f infra/containers/probe.Containerfile \
#     --build-arg BASE_IMAGE=docker.io/grafana/loki:3.7.8 -t localhost/commonair/loki:dev .
#
# No RUN step: the build fetches nothing from a package mirror, only the pinned images. An
# `apk add busybox-static` here failed CI run 41764916744 on a TLS error from
# dl-cdn.alpinelinux.org. The pinned Alpine's own BusyBox needs nothing but musl, whose dynamic
# loader is also its libc (libc.musl-<arch>.so.1 links to it), so those two files come along.
# The bases are static Go images with no /lib of their own; it also builds for another
# architecture without emulation.

ARG BASE_IMAGE
ARG PROBE_IMAGE=docker.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${PROBE_IMAGE} AS probe

FROM ${BASE_IMAGE}
COPY --from=probe /lib/ld-musl-*.so.1 /lib/libc.musl-*.so.1 /lib/
COPY --from=probe /bin/busybox /usr/local/bin/busybox
