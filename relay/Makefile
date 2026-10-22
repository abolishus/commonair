# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Reproducible static builds of commonair-relay. Same source + same Go
# toolchain = same bytes: no cgo, -trimpath, no build IDs or timestamps,
# and the version comes from git, never the clock.
#
# `make release VERSION=v1.2.3` builds the same bytes, under the same names, as the release
# workflow (scripts/release/relay.ts): PLATFORMS is RELAY_TARGETS and each name is
# relayAssetName (scripts/release/manifest.ts). scripts/tests/relay-makefile.test.ts checks both.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
# Release versions carry no leading v (versionFromTag), in the binary and in its name.
VER := $(patsubst v%,%,$(VERSION))
LDFLAGS := -s -w -buildid= -X main.version=$(VER)
GOFLAGS_BUILD := -trimpath -buildvcs=false -ldflags "$(LDFLAGS)"
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64
PKG := ./cmd/commonair-relay
BIN := bin

os = $(word 1,$(subst /, ,$(1)))
arch = $(word 2,$(subst /, ,$(1)))
# relayAssetName: commonair-relay_<version>_<os>_<arch>[.exe]
asset = commonair-relay_$(VER)_$(call os,$(1))_$(call arch,$(1))$(if $(filter windows,$(call os,$(1))),.exe,)
ASSETS := $(foreach p,$(PLATFORMS),$(call asset,$(p)))

.PHONY: all build release check test fmt vet image clean $(PLATFORMS)

all: check build

build:
	CGO_ENABLED=0 go build $(GOFLAGS_BUILD) -o $(BIN)/commonair-relay $(PKG)

release: $(PLATFORMS)
	cd $(BIN) && if command -v sha256sum >/dev/null; then sha256sum $(ASSETS); else shasum -a 256 $(ASSETS); fi > SHA256SUMS

$(PLATFORMS):
	CGO_ENABLED=0 GOOS=$(call os,$@) GOARCH=$(call arch,$@) \
		go build $(GOFLAGS_BUILD) -o $(BIN)/$(call asset,$@) $(PKG)

check: fmt vet test

fmt:
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

vet:
	go vet ./...

test:
	go test -race ./...

image:
	podman build --build-arg VERSION=$(VER) -t commonair-relay:$(VER) -f Containerfile .

clean:
	rm -rf $(BIN)
