// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_REGISTRY,
  RELEASE_IMAGES,
  imageRef,
  parseManifest,
  type ReleaseManifest,
} from "../release/manifest.ts";
import { renderUnit, renderUnits } from "../selfhost/render.ts";
import { QUADLET_DIR, readUnitDir, unitValues } from "../selfhost/units.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const manifestJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    version: "0.1.0-rc.1",
    tag: "v0.1.0-rc.1",
    commit: "a".repeat(40),
    registry: DEFAULT_REGISTRY,
    images: Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, { digest: digest(i + 1) }])),
    platforms: ["linux/amd64", "linux/arm64"],
    ...over,
  });
const manifest = parseManifest(manifestJson());
const units = readUnitDir(join(ROOT, QUADLET_DIR));
const images = (m: Map<string, string>) =>
  new Map([...m].flatMap(([name, text]) => unitValues(text, "Image").map((img) => [name, img] as const)));

describe("renderUnits", () => {
  const rendered = renderUnits(units, manifest);

  test("every own image becomes imageRef(manifest, name)", () => {
    let own = 0;
    for (const [file, before] of images(units)) {
      const name = /^localhost\/commonair\/([a-z-]+):latest$/.exec(before)?.[1];
      if (!name) continue;
      own++;
      expect(images(rendered).get(file)).toBe(imageRef(manifest, name as (typeof RELEASE_IMAGES)[number]));
      expect(images(rendered).get(file)).toMatch(/^ghcr\.io\/abolishus\/commonair\/[a-z-]+:0\.1\.0-rc\.1@sha256:/);
    }
    // api chat irc media origin web worker tracker + migrate garage-init irc-cert (tools)
    // + postgres loki tempo otel-collector.
    expect(own).toBe(15);
    expect([...rendered.values()].join("\n")).not.toContain("localhost/");
  });

  test("third-party images are untouched", () => {
    const third = [...images(units)].filter(([, img]) => !img.startsWith("localhost/"));
    expect(third.length).toBeGreaterThanOrEqual(6);
    for (const [file, img] of third) expect(images(rendered).get(file), file).toBe(img);
  });

  test("only Image= lines change", () => {
    for (const [file, before] of units) {
      const strip = (t: string) => t.replace(/^Image=.*$/gm, "");
      expect(strip(rendered.get(file)!), file).toBe(strip(before));
    }
  });

  test("a mirror registry replaces the namespace and keeps the digests", () => {
    const mirror = renderUnits(units, manifest, "registry.internal:5000/mirror/commonair");
    const api = unitValues(mirror.get("commonair-api.container")!, "Image")[0];
    expect(api).toBe(`registry.internal:5000/mirror/commonair/api:0.1.0-rc.1@${manifest.images.api!.digest}`);
    const caddy = unitValues(mirror.get("commonair-caddy.container")!, "Image")[0];
    expect(caddy).toBe(unitValues(units.get("commonair-caddy.container")!, "Image")[0]);
  });

  test("an invalid mirror is refused", () => {
    expect(() => renderUnits(units, manifest, "Not A Registry")).toThrow("invalid registry");
  });
});

describe("renderUnit failures", () => {
  test("a manifest without an image fails", () => {
    const { tools: _, ...rest } = manifest.images;
    const partial = { ...manifest, images: rest } as ReleaseManifest;
    expect(() => renderUnits(units, partial)).toThrow("manifest has no image tools");
    // parseManifest refuses it as well, before rendering.
    expect(() => parseManifest(manifestJson({ images: rest }))).toThrow(/tools/);
  });

  test("an own image that is not a release image fails", () => {
    expect(() => renderUnit("Image=localhost/commonair/unknown:latest\n", manifest)).toThrow("not a release image");
  });

  test("a locally built image under another tag cannot slip through", () => {
    expect(() => renderUnit("Image=localhost/commonair/api:dev\n", manifest)).toThrow("unrenderable local image");
  });
});

describe("render.ts CLI", () => {
  test("writes every unit rendered", () => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-render-"));
    writeFileSync(join(dir, "m.json"), manifestJson());
    const out = join(dir, "out");
    const proc = Bun.spawnSync(["bun", "scripts/selfhost/render.ts", "--manifest", join(dir, "m.json"), "--out", out], {
      cwd: ROOT,
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(readdirSync(out).sort()).toEqual([...units.keys()]);
    expect(readFileSync(join(out, "commonair-web.container"), "utf8")).toContain(`Image=${imageRef(manifest, "web")}`);
  });

  test("a bad manifest exits non-zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-render-"));
    writeFileSync(join(dir, "m.json"), manifestJson({ tag: "v9.9.9" }));
    const proc = Bun.spawnSync(
      ["bun", "scripts/selfhost/render.ts", "--manifest", join(dir, "m.json"), "--out", join(dir, "o")],
      { cwd: ROOT },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("tag must be v<version>");
  });
});
