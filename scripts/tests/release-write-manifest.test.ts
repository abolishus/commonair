// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { ZodError } from "zod";
import { RELEASE_IMAGES, parseManifest } from "../release/manifest.ts";
import { assembleManifest, formatManifest, readDigests } from "../release/write-manifest.ts";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const allDigests = () => Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, digest(i + 1)]));
const input = (over: Partial<Parameters<typeof assembleManifest>[0]> = {}) => ({
  tag: "v0.1.0-rc.1",
  commit: "f".repeat(40),
  registry: "ghcr.io/someone/commonair",
  platforms: ["linux/amd64", "linux/arm64"],
  digests: allDigests(),
  ...over,
});

const dir = mkdtempSync(join(tmpdir(), "write-manifest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("assembleManifest", () => {
  test("a valid manifest round-trips through the contract parser", () => {
    const m = assembleManifest(input());
    expect(m).toMatchObject({
      schema: 1,
      version: "0.1.0-rc.1",
      tag: "v0.1.0-rc.1",
      registry: "ghcr.io/someone/commonair",
    });
    expect(Object.keys(m.images)).toHaveLength(RELEASE_IMAGES.length);
    expect(parseManifest(formatManifest(m))).toEqual(m);
    expect(formatManifest(m).endsWith("}\n")).toBe(true);
  });

  test("digest files are read from a directory, whitespace trimmed", () => {
    for (const [name, d] of Object.entries(allDigests())) writeFileSync(join(dir, `${name}.digest`), `${d}\n`);
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const m = assembleManifest(input({ digests: readDigests(dir) }));
    expect(m.images.api?.digest).toBe(digest(1));
    const out = join(dir, "release-manifest.json");
    writeFileSync(out, formatManifest(m));
    expect(parseManifest(readFileSync(out, "utf8")).images.worker?.digest).toBe(allDigests().worker);
  });

  test("a missing digest fails", () => {
    const { relay: _relay, ...rest } = allDigests();
    expect(() => assembleManifest(input({ digests: rest }))).toThrow(/missing digests: relay/);
  });

  test.each([
    ["short", "sha256:abc"],
    ["uppercase", `sha256:${"A".repeat(64)}`],
    ["wrong algorithm", `sha512:${"a".repeat(64)}`],
    ["blank", " "],
  ])("a bad digest (%s) fails", (_, bad) => {
    expect(() => assembleManifest(input({ digests: { ...allDigests(), api: bad } }))).toThrow(ZodError);
  });

  test("an unknown image fails", () => {
    expect(() => assembleManifest(input({ digests: { ...allDigests(), mailpit: digest(99) } }))).toThrow(ZodError);
  });

  test("a tag that is not a release tag fails", () => {
    expect(() => assembleManifest(input({ tag: "0.1.0" }))).toThrow("not a release tag");
    expect(() => assembleManifest(input({ tag: "v0.1" }))).toThrow("not a release tag");
  });

  test("a tag/version mismatch fails", () => {
    expect(() => assembleManifest(input({ version: "0.1.0" }))).toThrow("tag/version mismatch");
    expect(assembleManifest(input({ version: "0.1.0-rc.1" })).version).toBe("0.1.0-rc.1");
  });

  test("a tag/version mismatch fails in the contract too", () => {
    // assembleManifest derives the version from the tag, so feed the parser a mismatched pair
    // directly to prove the contract still guards it.
    const m = { ...assembleManifest(input()), tag: "v0.1.0" };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(ZodError);
  });

  test("a bad commit or registry fails", () => {
    expect(() => assembleManifest(input({ commit: "HEAD" }))).toThrow(ZodError);
    expect(() => assembleManifest(input({ registry: "GHCR.io/Someone" }))).toThrow(ZodError);
    expect(() => assembleManifest(input({ platforms: [] }))).toThrow(ZodError);
  });
});
