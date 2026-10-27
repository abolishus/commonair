// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A pull-through mirror for the self-host e2e's third-party images (local runs only).
 *
 * Every fresh e2e host pulls Caddy, Grafana, Garage, MediaMTX, Valkey and Prometheus from their
 * upstream registries, and a local run once hit Docker Hub's anonymous rate limit. This is a Zot
 * (the e2e's own pinned image) with its sync extension in on-demand mode for docker.io, ghcr.io
 * and quay.io: the first pull of an image fetches it from upstream and keeps it; later runs are
 * served from `.cache/selfhost-e2e-mirror/`, which survives between runs. The host's
 * registries.conf.d names it as a mirror of each upstream.
 *
 * It cannot change what runs: every third-party image is pinned by digest, Podman verifies the
 * digest of what a mirror serves, and when the mirror fails it falls back to the upstream.
 * Checked at Zot v2.1.22: digest pulls through it keep the upstream digest, OCI indexes and
 * Docker manifest lists alike (`http.compat: docker2s2` keeps Docker media types as they are).
 */
import { join } from "node:path";
import { REPO_ROOT } from "./bundle.ts";

/** Upstream registries the mirror stands in for, by the name images use. */
export const MIRROR_UPSTREAMS = {
  "docker.io": "https://registry-1.docker.io",
  "ghcr.io": "https://ghcr.io",
  "quay.io": "https://quay.io",
} as const;

export const MIRROR_CONTAINER = "commonair-e2e-mirror";
/** Kept between runs: outside .cache/selfhost-e2e/, which every run starts by removing. */
export const MIRROR_DIR = join(REPO_ROOT, ".cache/selfhost-e2e-mirror");
/** In the host, before the e2e's own 50-e2e.conf (registries.conf.d is read in name order). */
export const MIRROR_CONF_PATH = "/etc/containers/registries.conf.d/40-e2e-mirror.conf";
const PORT = 5000;

/** Zot's config: plain HTTP on the test network, one on-demand sync entry per upstream. */
export function mirrorZotConfig(): string {
  return `${JSON.stringify(
    {
      distSpecVersion: "1.1.1",
      // gc off: nothing is ever pushed or deleted here, and a cache that keeps everything is the point.
      storage: { rootDirectory: "/var/lib/registry", gc: false, dedupe: false },
      http: { address: "0.0.0.0", port: String(PORT), compat: ["docker2s2"] },
      log: { level: "info" },
      extensions: {
        sync: {
          enable: true,
          registries: Object.entries(MIRROR_UPSTREAMS).map(([name, url]) => ({
            urls: [url],
            onDemand: true,
            tlsVerify: true,
            maxRetries: 2,
            retryDelay: "10s",
            // Each upstream under its own prefix, so docker.io/x and quay.io/x never collide.
            content: [{ prefix: "**", destination: `/${name}` }],
          })),
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** The host's registries.conf.d entry: the mirror (by address, no DNS needed) for each upstream. */
export function mirrorRegistriesConf(address: string): string {
  if (!/^[0-9a-f.:]+$/i.test(address)) throw new Error(`not an IP address: ${address}`);
  const host = address.includes(":") ? `[${address}]` : address;
  return Object.keys(MIRROR_UPSTREAMS)
    .map((name) =>
      [
        "[[registry]]",
        `location = "${name}"`,
        "[[registry.mirror]]",
        `location = "${host}:${PORT}/${name}"`,
        "insecure = true",
        "",
      ].join("\n"),
    )
    .join("\n");
}

/** `podman run` arguments for the mirror (outer podman: Podman 4.9 flags only). */
export function mirrorRunArgs(image: string, network: string, dir = MIRROR_DIR): string[] {
  return [
    "run",
    "-d",
    "--name",
    MIRROR_CONTAINER,
    "--network",
    network,
    "-v",
    `${join(dir, "config.json")}:/etc/zot/config.json:ro`,
    "-v",
    `${join(dir, "data")}:/var/lib/registry`,
    image,
  ];
}

/**
 * Whether this run uses the mirror: on by default locally, off on CI (fresh runners, and
 * GitHub's own Docker Hub access), and `--no-mirror` or `--mirror` decide either way.
 */
export function mirrorWanted(flag: boolean | undefined, env: Record<string, string | undefined>): boolean {
  return flag ?? !env.CI;
}
