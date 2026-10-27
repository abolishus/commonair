// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Registry errors while pulling images. */
import { describe, expect, test } from "vite-plus/test";
import { type Host, TIMEOUT, host, INSTALL, expectOk, useReleases } from "./support/selfhost-host.ts";

useReleases();

describe("registry errors while pulling", () => {
  // What Podman printed in CI run 39958894162 (Docker Hub, mid-upgrade).
  const HUB_500 =
    "unable to copy from source docker://dxflrs/garage@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020: " +
    "copying system image from manifest list: determining manifest MIME type for docker://dxflrs/garage@sha256:9c96: " +
    "reading manifest sha256:0d7c74fc in docker.io/dxflrs/garage: received unexpected HTTP status: 500 Internal Server Error";
  const pulls = (h: Host) => h.calls().filter((c) => c.startsWith("podman pull"));
  const sleeps = (h: Host) => h.calls().filter((c) => c.startsWith("sleep "));

  test.each([
    ["a 500", HUB_500],
    ["a 503", "reading manifest latest in docker.io/x/y: received unexpected HTTP status: 503 Service Unavailable"],
    [
      "a 429",
      "initializing source docker://x/y: reading manifest: toomanyrequests: You have reached your pull rate limit",
    ],
    [
      "a timeout",
      'pinging container registry registry-1.docker.io: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout',
    ],
    [
      "a reset connection",
      "writing blob: storing blob to file: read tcp 10.0.0.2:4122->1.2.3.4:443: read: connection reset by peer",
    ],
    ["a 408", "reading manifest latest in docker.io/x/y: received unexpected HTTP status: 408 Request Timeout"],
    [
      "a DNS server that failed",
      'pinging container registry ghcr.io: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io on 127.0.0.53:53: server misbehaving',
    ],
  ])(
    "%s is retried, and the install goes on",
    (_, message) => {
      const h = host();
      const r = h.run(INSTALL, { STUB_PULL_ERR: message, STUB_PULL_ERR_TIMES: "2" });
      expectOk(r);
      const all = pulls(h);
      // The first image took three tries; every other image one.
      expect(all.length).toBe(new Set(all).size + 2);
      expect(all[0]).toBe(all[1]);
      expect(all[1]).toBe(all[2]);
      expect(r.err).toContain(message);
      expect(r.err).toContain("failed (attempt 1 of 4), retrying in 5s");
      expect(r.err).toContain("failed (attempt 2 of 4), retrying in 15s");
      expect(sleeps(h).slice(0, 2)).toEqual(["sleep 5", "sleep 15"]);
    },
    TIMEOUT,
  );

  test(
    "a registry that keeps failing stops the install after four tries, with Podman's error",
    () => {
      const h = host();
      const r = h.run(INSTALL, { STUB_PULL_ERR: HUB_500 });
      expect(r.code).toBe(1);
      expect(pulls(h)).toHaveLength(4);
      expect(new Set(pulls(h)).size).toBe(1);
      expect(sleeps(h).slice(0, 3)).toEqual(["sleep 5", "sleep 15", "sleep 45"]);
      expect(r.err).toContain("500 Internal Server Error");
      expect(r.err).toContain("selfhost: error: could not pull");
      expect(h.calls().some((c) => c.startsWith("systemctl --user start"))).toBe(false);
    },
    TIMEOUT,
  );

  test.each([
    ["unauthorized", "initializing source docker://x/y: reading manifest: unauthorized: authentication required"],
    ["denied", "requested access to the resource is denied"],
    ["a missing manifest", "reading manifest sha256:abc in docker.io/x/y: manifest unknown"],
    ["a 404", "reading manifest sha256:abc in docker.io/x/y: received unexpected HTTP status: 404 Not Found"],
    ["a digest mismatch", "writing blob: Digest did not match, expected sha256:aaaa, got sha256:bbbb"],
    ["a mismatched manifest", "Manifest does not match provided manifest digest sha256:abc"],
    ["an error it does not know", "something else went wrong"],
  ])(
    "%s is not retried",
    (_, message) => {
      const h = host();
      const r = h.run(INSTALL, { STUB_PULL_ERR: message, STUB_PULL_ERR_TIMES: "1" });
      expect(r.code).toBe(1);
      expect(pulls(h)).toHaveLength(1);
      expect(sleeps(h)).toEqual([]);
      expect(r.err).toContain(message);
      expect(r.err).toContain("selfhost: error: could not pull");
    },
    TIMEOUT,
  );
});
