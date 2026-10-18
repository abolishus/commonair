# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Reproducible static builds of commonair-relay. Same source + same Go
# toolchain = same bytes: no cgo, -trimpath, no build IDs or timestamps,
# and the version comes from git, never the clock.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -buildid= -X main.version=$(VERSION)
GOFLAGS_BUILD := -trimpath -buildvcs=false -ldflags "$(LDFLAGS)"
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64
PKG := ./cmd/commonair-relay
BIN := bin

.PHONY: all build release check test fmt vet image clean

all: check build

build:
	CGO_ENABLED=0 go build $(GOFLAGS_BUILD) -o $(BIN)/commonair-relay $(PKG)

release: $(PLATFORMS)
	cd $(BIN) && if command -v sha256sum >/dev/null; then sha256sum commonair-relay-*; else shasum -a 256 commonair-relay-*; fi > SHA256SUMS

$(PLATFORMS):
	CGO_ENABLED=0 GOOS=$(word 1,$(subst /, ,$@)) GOARCH=$(word 2,$(subst /, ,$@)) \
		go build $(GOFLAGS_BUILD) \
		-o $(BIN)/commonair-relay-$(word 1,$(subst /, ,$@))-$(word 2,$(subst /, ,$@))$(if $(findstring windows,$@),.exe,) $(PKG)

check: fmt vet test

fmt:
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

vet:
	go vet ./...

test:
	go test -race ./...

image:
	podman build --build-arg VERSION=$(VERSION) -t commonair-relay:$(VERSION) -f Containerfile .

clean:
	rm -rf $(BIN)
