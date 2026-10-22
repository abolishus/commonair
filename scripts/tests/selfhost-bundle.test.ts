// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { SITE } from "../../packages/config/src/site.ts";
import { DEFAULT_REGISTRY, RELEASE_IMAGES, bundleAssetName, imageRef, parseManifest } from "../release/manifest.ts";
import { buildBundle } from "../selfhost/bundle.ts";
import { gzipReproducible, tar } from "../selfhost/tar.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const manifestJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    version: "0.2.0",
    tag: "v0.2.0",
    commit: "b".repeat(40),
    registry: DEFAULT_REGISTRY,
    images: Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, { digest: digest(i + 100) }])),
    platforms: ["linux/amd64", "linux/arm64"],
    ...over,
  });

interface Entry {
  path: string;
  mode: number;
  type: string;
  mtime: number;
  uid: number;
  data: Uint8Array;
}

/** Minimal ustar reader (the format tar.ts writes). */
function untar(gz: Uint8Array): Entry[] {
  const buf = new Uint8Array(gunzipSync(gz));
  const dec = new TextDecoder();
  const str = (o: number, n: number) => dec.decode(buf.subarray(o, o + n)).replace(/\0.*$/s, "");
  const entries: Entry[] = [];
  for (let off = 0; off + 512 <= buf.length;) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const name = str(off, 100);
    const prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12), 8);
    const path = (prefix ? `${prefix}/${name}` : name).replace(/\/$/, "");
    const stored = parseInt(str(off + 148, 8).trim(), 8);
    const header = buf.slice(off, off + 512);
    header.fill(32, 148, 156);
    expect(
      header.reduce((a, b) => a + b, 0),
      `checksum of ${path}`,
    ).toBe(stored);
    entries.push({
      path,
      mode: parseInt(str(off + 100, 8), 8),
      type: str(off + 156, 1),
      mtime: parseInt(str(off + 136, 12), 8),
      uid: parseInt(str(off + 108, 8), 8),
      data: buf.slice(off + 512, off + 512 + size),
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const TOP = "commonair-selfhost_0.2.0";
let archive: { name: string; data: Uint8Array };
let entries: Entry[];
let files: Map<string, Entry>;
const text = (p: string) => new TextDecoder().decode(files.get(`${TOP}/${p}`)?.data);

beforeAll(async () => {
  archive = await buildBundle({ manifestJson: manifestJson() });
  entries = untar(archive.data);
  files = new Map(entries.filter((e) => e.type === "0").map((e) => [e.path, e]));
}, 60_000);

/** Volume= sources of the repository's units, parsed here independently of units.ts. */
function volumeSources(): string[] {
  return readdirSync(join(ROOT, "infra/quadlet"))
    .filter((f) => f.endsWith(".container"))
    .flatMap((f) =>
      [...readFileSync(join(ROOT, "infra/quadlet", f), "utf8").matchAll(/^Volume=([^:]+):/gm)].map((m) => m[1]!),
    );
}

describe("bundle contents", () => {
  test("is named by bundleAssetName", () => {
    expect(archive.name).toBe(bundleAssetName("0.2.0"));
  });

  test("equals the expected set", () => {
    const quadlet = readdirSync(join(ROOT, "infra/quadlet")).map((f) => `quadlet/${f}`);
    const systemd = readdirSync(join(ROOT, "infra/systemd")).map((f) => `systemd/${f}`);
    const expected = [
      "selfhost.sh",
      "release-manifest.json",
      "release.env",
      ...quadlet,
      ...systemd,
      // Config the units mount from %h/commonair/ (a new mount must show up here).
      "infra/caddy/Caddyfile",
      "infra/garage/garage.toml",
      "infra/grafana/dashboards/README.md",
      "infra/grafana/provisioning/dashboards/dashboards.yaml",
      "infra/grafana/provisioning/datasources/datasources.yaml",
      "infra/loki/loki.yaml",
      "infra/mediamtx/mediamtx.yml",
      "infra/otel-collector/config.yaml",
      "infra/prometheus/prometheus.yml",
      "infra/tempo/tempo.yaml",
      "tools/init-env.js",
      "tools/fetch-model.js",
      "tools/.env.example",
      "tools/THIRD-PARTY-LICENSES.txt",
      "LICENSES/AGPL-3.0-or-later.txt",
      "LICENSES/CC0-1.0.txt",
      "LICENSES/CC-BY-SA-4.0.txt",
    ].map((p) => `${TOP}/${p}`);
    expect([...files.keys()].sort()).toEqual(expected.sort());
  });

  test("every path is under the one top-level directory, with its parents as directories", () => {
    for (const e of entries) expect(e.path === TOP || e.path.startsWith(`${TOP}/`), e.path).toBe(true);
    const dirs = new Set(entries.filter((e) => e.type === "5").map((e) => e.path));
    for (const p of files.keys())
      for (let d = p.slice(0, p.lastIndexOf("/")); d; d = d.slice(0, Math.max(0, d.lastIndexOf("/"))))
        expect(dirs.has(d), `${d} (parent of ${p})`).toBe(true);
  });

  test("every Volume= source the units mount from the release is in the bundle", () => {
    const fromRelease = volumeSources().filter((s) => s.startsWith("%h/commonair/"));
    expect(fromRelease).toHaveLength(9);
    for (const src of fromRelease) {
      const path = `${TOP}/${src.slice("%h/commonair/".length)}`;
      const present = files.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`));
      expect(present, src).toBe(true);
    }
  });

  test("every other host mount is one selfhost.sh creates (hash list, model or directory)", () => {
    const sh = readFileSync(join(ROOT, "scripts/selfhost.sh"), "utf8");
    const other = volumeSources().filter((s) => s.startsWith("%h/") && !s.startsWith("%h/commonair/"));
    expect(new Set(other)).toEqual(
      new Set([
        "%h/.local/share/commonair/moderation/csam.pdq",
        "%h/.local/share/commonair/moderation/ncii.pdq",
        "%h/.local/share/commonair/models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx",
        "%h/.config/commonair/irc-tls",
      ]),
    );
    // prepare_mounts: *.pdq → empty file, *.onnx → fetch-model, anything else → directory.
    expect(sh).toMatch(/\*\.pdq\)/);
    expect(sh).toMatch(/\*\.onnx\) fetch_model/);
    expect(sh).toMatch(/\*\) mkdir -p "\$_path"/);
  });

  test("selfhost.sh is executable, everything else is not", () => {
    for (const [p, e] of files) expect(e.mode, p).toBe(p === `${TOP}/selfhost.sh` ? 0o755 : 0o644);
    expect(text("selfhost.sh")).toBe(readFileSync(join(ROOT, "scripts/selfhost.sh"), "utf8"));
  });

  test("owned by root with a fixed mtime", () => {
    for (const e of entries) {
      expect(e.uid, e.path).toBe(0);
      expect(e.mtime, e.path).toBe(0);
    }
  });

  test("units are the rendered ones; timers and config are copied verbatim", () => {
    const m = parseManifest(manifestJson());
    expect(text("quadlet/commonair-worker.container")).toContain(`Image=${imageRef(m, "worker")}\n`);
    expect(text("quadlet/commonair-migrate.container")).toContain(`Image=${imageRef(m, "tools")}\n`);
    expect(text("systemd/commonair-backup.timer")).toBe(
      readFileSync(join(ROOT, "infra/systemd/commonair-backup.timer"), "utf8"),
    );
    expect(text("infra/caddy/Caddyfile")).toBe(readFileSync(join(ROOT, "infra/caddy/Caddyfile"), "utf8"));
  });

  test("manifest and release.env", () => {
    expect(text("release-manifest.json")).toBe(manifestJson());
    expect(text("release.env")).toBe(
      [
        "COMMONAIR_VERSION=0.2.0",
        "COMMONAIR_TAG=v0.2.0",
        `COMMONAIR_COMMIT=${"b".repeat(40)}`,
        `COMMONAIR_REGISTRY=${DEFAULT_REGISTRY}`,
        `COMMONAIR_REPOSITORY_URL=${SITE.repository.url}`,
        "",
      ].join("\n"),
    );
  });

  test("bundled tools carry the licenses of the npm code inside them", () => {
    const notices = text("tools/THIRD-PARTY-LICENSES.txt");
    expect(notices).toMatch(/^zod@\d+\.\d+\.\d+$/m);
    expect(notices).toContain("MIT License");
    expect(text("tools/.env.example")).toBe(readFileSync(join(ROOT, ".env.example"), "utf8"));
  });

  test("the bundled init-env runs on Bun alone and writes a 0600 env with fresh secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-bundle-tools-"));
    for (const f of ["init-env.js", ".env.example"]) writeFileSync(join(dir, f), files.get(`${TOP}/tools/${f}`)!.data);
    mkdirSync(join(dir, "out"));
    const run = Bun.spawnSync(["bun", "init-env.js", "--out", "out/commonair.env", "--merge"], { cwd: dir });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const env = readFileSync(join(dir, "out/commonair.env"), "utf8");
    expect(env).not.toContain("__generate");
    expect(env).toMatch(/^POSTGRES_PASSWORD=.{20,}$/m);
  });
});

describe("reproducible", () => {
  test("building twice gives byte-identical archives", async () => {
    const again = await buildBundle({ manifestJson: manifestJson() });
    expect(Buffer.from(again.data).equals(Buffer.from(archive.data))).toBe(true);
  }, 60_000);

  test("a mirror registry is baked into units and release.env", async () => {
    const mirror = await buildBundle({ manifestJson: manifestJson(), registry: "zot.internal:5000/commonair" });
    const m = new Map(untar(mirror.data).map((e) => [e.path, new TextDecoder().decode(e.data)]));
    expect(m.get(`${TOP}/quadlet/commonair-api.container`)).toContain(
      `Image=zot.internal:5000/commonair/api:0.2.0@${digest(100)}\n`,
    );
    expect(m.get(`${TOP}/release.env`)).toContain("COMMONAIR_REGISTRY=zot.internal:5000/commonair\n");
  }, 60_000);
});

describe("tar writer", () => {
  test("rejects unsafe or duplicate paths", () => {
    const d = new Uint8Array(1);
    for (const p of ["/abs", "a/../b", "a//b", "./a", ""])
      expect(() => tar([{ path: p, data: d, mode: 0o644 }]), p).toThrow("invalid path");
    expect(() =>
      tar([
        { path: "a", data: d, mode: 0o644 },
        { path: "a", data: d, mode: 0o644 },
      ]),
    ).toThrow("duplicate");
    expect(() =>
      tar([
        { path: "a", data: d, mode: 0o644 },
        { path: "a/b", data: d, mode: 0o644 },
      ]),
    ).toThrow("both a file and a directory");
  });

  test("long paths use the ustar prefix field", () => {
    const long = `${"d".repeat(90)}/${"e".repeat(90)}/f.txt`;
    const out = untar(gzipReproducible(tar([{ path: long, data: new Uint8Array([1, 2]), mode: 0o644 }])));
    expect(out.find((e) => e.type === "0")?.path).toBe(long);
  });

  test("system tar reads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-bundle-tar-"));
    writeFileSync(join(dir, archive.name), archive.data);
    const list = Bun.spawnSync(["tar", "-tzf", join(dir, archive.name)]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain(`${TOP}/selfhost.sh`);
  });
});

describe("bundle.ts CLI (the release workflow's contract)", () => {
  test("writes <out>/commonair-selfhost_<version>.tar.gz and prints its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-bundle-cli-"));
    writeFileSync(join(dir, "release-manifest.json"), manifestJson());
    const out = join(dir, "dist");
    const run = Bun.spawnSync(
      ["bun", "scripts/selfhost/bundle.ts", "--manifest", join(dir, "release-manifest.json"), "--out", out],
      { cwd: ROOT },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString().trim()).toBe(join(out, "commonair-selfhost_0.2.0.tar.gz"));
    expect(
      Buffer.from(readFileSync(join(out, "commonair-selfhost_0.2.0.tar.gz"))).equals(Buffer.from(archive.data)),
    ).toBe(true);
  }, 60_000);

  test("usage errors and bad manifests exit non-zero", () => {
    expect(Bun.spawnSync(["bun", "scripts/selfhost/bundle.ts"], { cwd: ROOT }).exitCode).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "commonair-bundle-cli-"));
    writeFileSync(join(dir, "m.json"), manifestJson({ schema: 2 }));
    const run = Bun.spawnSync(["bun", "scripts/selfhost/bundle.ts", "--manifest", join(dir, "m.json"), "--out", dir], {
      cwd: ROOT,
    });
    expect(run.exitCode).toBe(1);
  });
});
