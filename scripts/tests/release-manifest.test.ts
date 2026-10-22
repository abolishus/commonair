// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { ZodError } from "zod";
import {
  DEFAULT_REGISTRY,
  RELAY_TARGETS,
  RELEASE_IMAGES,
  bundleAssetName,
  imageRef,
  isPrerelease,
  parseManifest,
  relayAssetName,
  versionFromTag,
} from "../release/manifest.ts";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const manifest = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  version: "0.1.0-rc.1",
  tag: "v0.1.0-rc.1",
  commit: "a".repeat(40),
  registry: DEFAULT_REGISTRY,
  images: Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, { digest: digest(i + 1) }])),
  platforms: ["linux/amd64", "linux/arm64"],
  ...over,
});

describe("versionFromTag", () => {
  test.each([
    ["v0.1.0", "0.1.0"],
    ["v0.1.0-rc.1", "0.1.0-rc.1"],
    ["v10.20.30-alpha.beta-1", "10.20.30-alpha.beta-1"],
  ])("%s → %s", (tag, version) => expect(versionFromTag(tag)).toBe(version));

  test.each(["0.1.0", "v0.1", "v01.0.0", "v0.1.0+build.1", "v0.1.0-", "vv0.1.0", "v0.1.0-rc..1", ""])(
    "refuses %j",
    (tag) => expect(() => versionFromTag(tag)).toThrow("not a release tag"),
  );

  test("prerelease", () => {
    expect(isPrerelease("0.1.0-rc.1")).toBe(true);
    expect(isPrerelease("0.1.0")).toBe(false);
  });
});

describe("parseManifest", () => {
  test("accepts a complete manifest", () => {
    expect(parseManifest(JSON.stringify(manifest())).version).toBe("0.1.0-rc.1");
  });

  test("the default registry is the project's namespace", () => {
    expect(DEFAULT_REGISTRY).toBe("ghcr.io/abolishus/commonair");
  });

  test.each([
    ["missing image", { images: { api: { digest: digest(1) } } }],
    ["tag mismatch", { tag: "v0.1.0" }],
    ["bad digest", { images: { ...manifest().images, api: { digest: "sha256:abc" } } }],
    ["unknown image", { images: { ...manifest().images, mailpit: { digest: digest(99) } } }],
    ["uppercase registry", { registry: "GHCR.io/x" }],
    ["short commit", { commit: "abc" }],
    ["schema 2", { schema: 2 }],
    ["no platforms", { platforms: [] }],
    ["unknown field", { extra: true }],
  ])("refuses %s", (_, over) => expect(() => parseManifest(JSON.stringify(manifest(over)))).toThrow(ZodError));
});

describe("references and asset names", () => {
  const m = parseManifest(JSON.stringify(manifest()));

  test("imageRef pins tag and digest", () => {
    expect(imageRef(m, "api")).toBe(`ghcr.io/abolishus/commonair/api:0.1.0-rc.1@${digest(1)}`);
  });

  test("imageRef with a mirror keeps the digest", () => {
    expect(imageRef(m, "worker", "registry.example.org:5000/commonair")).toBe(
      `registry.example.org:5000/commonair/worker:0.1.0-rc.1@${m.images.worker!.digest}`,
    );
    expect(() => imageRef(m, "api", "https://bad/x")).toThrow("invalid registry");
  });

  test("relay asset names cover six targets, .exe only on Windows", () => {
    const names = RELAY_TARGETS.map((t) => relayAssetName("0.1.0", t));
    expect(new Set(names).size).toBe(6);
    expect(names.filter((n) => n.endsWith(".exe"))).toEqual([
      "commonair-relay_0.1.0_windows_amd64.exe",
      "commonair-relay_0.1.0_windows_arm64.exe",
    ]);
    expect(bundleAssetName("0.1.0")).toBe("commonair-selfhost_0.1.0.tar.gz");
  });
});
