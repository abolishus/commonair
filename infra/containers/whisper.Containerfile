# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The whisper.cpp speech sidecar for live captions (ADR 0011 decisions 1 and 5, batch 6
# decision (j)). Build context is the repo root:
#   podman build -f infra/containers/whisper.Containerfile -t localhost/commonair/whisper:dev .
#
# whisper.cpp (MIT, github.com/ggml-org/whisper.cpp) is built from source at a pinned tag whose
# commit is checked, on a pinned Debian base; only `whisper-server` reaches the final stage, which
# runs as a non-root user. The weights are never baked in: `bun scripts/fetch-model.ts --model
# captions` downloads and digest-checks them, and compose mounts the file read-only at
# /models/ggml-base-q5_1.bin. Two threads per process (decision (j)); the server listens on the
# internal network only and nothing publishes its port.

ARG BUILD_IMAGE=docker.io/library/debian:trixie-20261005@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
# The same pinned base for both stages (one image-licenses.json entry, one tag).
ARG RUNTIME_IMAGE=docker.io/library/debian:trixie-20261005@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5

# --- build: whisper.cpp v1.9.5 (tag object d2a764c6, commit d1be6fde), the server example only.
FROM ${BUILD_IMAGE} AS build
ARG WHISPER_TAG=v1.9.5
ARG WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
ARG TARGETARCH
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git cmake make g++; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN set -eu; \
    git clone --depth 1 --branch "${WHISPER_TAG}" https://github.com/ggml-org/whisper.cpp.git .; \
    test "$(git rev-parse HEAD)" = "${WHISPER_COMMIT}" || { echo "whisper.cpp ${WHISPER_TAG} is not ${WHISPER_COMMIT}" >&2; exit 1; }
# Portable CPU code (no -march=native: the image runs on hosts other than the builder); on amd64 the
# AVX2/FMA/F16C paths every current cloud CPU has. No OpenMP: the runtime image stays plain Debian.
RUN set -eu; \
    simd=""; \
    if [ "${TARGETARCH:-amd64}" = "amd64" ]; then simd="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; fi; \
    cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF ${simd}; \
    cmake --build build --target whisper-server -j"$(nproc)"; \
    install -m 0755 build/bin/whisper-server /usr/local/bin/whisper-server; \
    install -m 0644 LICENSE /usr/local/share/whisper.cpp-LICENSE

# --- runtime: the server binary, its licence and a health probe; nothing else.
FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=build /usr/local/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=build /usr/local/share/whisper.cpp-LICENSE /usr/share/doc/whisper.cpp/LICENSE
# `GET /health` over bash's /dev/tcp: no curl or wget in the image.
RUN set -eu; \
    printf '%s\n' '#!/bin/bash' \
      'exec 3<>/dev/tcp/127.0.0.1/8080 || exit 1' \
      'printf "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3' \
      'grep -q "\"ok\"" <&3' > /usr/local/bin/whisper-health; \
    chmod 0755 /usr/local/bin/whisper-health
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=30 CMD ["/usr/local/bin/whisper-health"]
ENTRYPOINT ["/usr/local/bin/whisper-server"]
CMD ["--host", "0.0.0.0", "--port", "8080", "--threads", "2", "--model", "/models/ggml-base-q5_1.bin"]
