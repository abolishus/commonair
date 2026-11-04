// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `portability` scenario's pure helpers: adding the T0 fixture emote to an exported bundle
 * keeps the archive consistent (the manifest lists the new file with its real size and SHA-256),
 * and every step has a runner that is not the contract step's stub.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";
import { readBundleJson, withExtraEmote } from "../../src/w3/portability/bundle.ts";
import { PORTABILITY_ROUTES, PORTABILITY_STEP_RUNNERS } from "../../src/w3/portability/index.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const sha = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b))), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");

async function archive(): Promise<Uint8Array> {
  const bundle = {
    v: 1,
    source: "commonair",
    emotes: [{ code: "wave", tier: 0, animated: false, file: "files/emote-wave.png" }],
    standing: { payload: "x", signature: "y" },
  };
  const manifest = {
    v: 1,
    files: [
      { file: "files/emote-wave.png", sizeBytes: PNG.byteLength, sha256: await sha(PNG), contentType: "image/png" },
    ],
  };
  return zipSync({
    "bundle.json": strToU8(JSON.stringify(bundle)),
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "files/emote-wave.png": PNG,
  });
}

describe("withExtraEmote", () => {
  test("adds the emote, its file and a manifest entry that matches the bytes", async () => {
    const t0 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const out = await withExtraEmote(await archive(), "ptbad", t0);
    const entries = unzipSync(out);
    expect(Object.keys(entries).sort()).toEqual([
      "bundle.json",
      "files/emote-ptbad.png",
      "files/emote-wave.png",
      "manifest.json",
    ]);
    expect(entries["files/emote-ptbad.png"]).toEqual(t0);
    const bundle = readBundleJson(out) as { emotes: { code: string; file: string }[]; standing: unknown };
    expect(bundle.emotes.map((e) => [e.code, e.file])).toEqual([
      ["wave", "files/emote-wave.png"],
      ["ptbad", "files/emote-ptbad.png"],
    ]);
    // The statement is kept: it no longer matches the edited bundle, which the import reports.
    expect(bundle.standing).toEqual({ payload: "x", signature: "y" });
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as { files: Record<string, unknown>[] };
    expect(manifest.files.at(-1)).toEqual({
      file: "files/emote-ptbad.png",
      sizeBytes: t0.byteLength,
      sha256: await sha(t0),
      contentType: "image/png",
    });
  });

  test("replaces an emote of the same code instead of duplicating it", async () => {
    const out = await withExtraEmote(await archive(), "wave", PNG);
    const bundle = readBundleJson(out) as { emotes: unknown[] };
    expect(bundle.emotes).toHaveLength(1);
    const manifest = JSON.parse(strFromU8(unzipSync(out)["manifest.json"]!)) as { files: unknown[] };
    expect(manifest.files).toHaveLength(1);
  });

  test("refuses a code the bundle schema would refuse", async () => {
    await expect(withExtraEmote(await archive(), "no-dash", PNG)).rejects.toThrow(/not an emote code/);
    expect(() => readBundleJson(zipSync({ "x.txt": strToU8("x") }))).toThrow(/no bundle.json/);
  });
});

describe("the scenario", () => {
  test("every step has its own runner and the studio routes are the real ones", () => {
    const runners = Object.values(PORTABILITY_STEP_RUNNERS);
    expect(runners).toHaveLength(5);
    expect(new Set(runners).size).toBe(5);
    expect(PORTABILITY_ROUTES).toEqual({ move: "/move", notifications: "/settings/notifications" });
  });
});
