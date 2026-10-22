# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Adds a static BusyBox (for `wget` in healthchecks) to upstream images that ship
# without a shell (OpenTelemetry Collector, Loki, Tempo). The upstream image is
# otherwise unchanged; BASE_IMAGE must be a pinned entry of infra/image-licenses.json.
#   podman build -f infra/containers/probe.Containerfile \
#     --build-arg BASE_IMAGE=docker.io/grafana/loki:3.7.8 -t localhost/commonair/loki:dev .

ARG BASE_IMAGE
ARG PROBE_IMAGE=docker.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${PROBE_IMAGE} AS probe
RUN apk add --no-cache busybox-static && cp /bin/busybox.static /busybox

FROM ${BASE_IMAGE}
COPY --from=probe /busybox /usr/local/bin/busybox
