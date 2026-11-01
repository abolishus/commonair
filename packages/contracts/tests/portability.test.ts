// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  BundleFileName,
  PORTABILITY_LIMITS,
  PortabilityBundle,
  bundleFileRefs,
  parseBundle,
} from "../src/portability.ts";

const sha = "a".repeat(64);
const sig = "A".repeat(86);

const bundle = () => ({
  v: 1,
  source: "commonair",
  exportedAt: "2026-11-01T10:00:00Z",
  instance: { domain: "example.test", software: "commonair", version: "0.0.0" },
  channel: {
    title: "Speedruns",
    description: "Any% runs",
    tags: ["speedrun"],
    language: "en",
    mature: false,
    categorySlug: "games",
    categoryName: "Games",
  },
  panels: [{ title: "About", body: "Hi", link: "https://example.test/about", image: { file: "files/panel-1.png" } }],
  emotes: [{ code: "Hype", tier: 0, animated: false, file: "files/emote-hype.png" }],
  schedule: [{ startsAt: "2026-11-02T18:00:00Z", endsAt: null, title: "Weekly", category: null }],
  standing: { payload: "eyJ2IjoxfQ", signature: sig },
});
const manifest = () => ({
  v: 1,
  files: [
    { file: "files/panel-1.png", sizeBytes: 2_000_000, sha256: sha, contentType: "image/png" },
    { file: "files/emote-hype.png", sizeBytes: 5_000, sha256: sha, contentType: "image/png" },
  ],
});

describe("PortabilityBundle v1 (decision (j))", () => {
  test("a complete bundle parses, and lists its files", () => {
    const r = parseBundle(bundle(), manifest());
    expect(r.ok && bundleFileRefs(r.bundle)).toEqual(["files/emote-hype.png", "files/panel-1.png"]);
  });

  test("unknown versions are refused before the shape is read", () => {
    expect(parseBundle({ ...bundle(), v: 2 }, manifest())).toEqual({ ok: false, error: "unsupported_version" });
    expect(parseBundle(bundle(), { ...manifest(), v: 0 })).toEqual({ ok: false, error: "unsupported_version" });
    expect(parseBundle(null, manifest())).toEqual({ ok: false, error: "unsupported_version" });
    expect(parseBundle("v1", manifest())).toEqual({ ok: false, error: "unsupported_version" });
  });

  test("shape and limit violations are malformed", () => {
    const tooMany = {
      ...bundle(),
      emotes: Array.from({ length: PORTABILITY_LIMITS.maxEmotes + 1 }, (_, i) => ({
        code: `E${i}x`,
        tier: 0,
        animated: false,
        file: "files/emote-hype.png",
      })),
    };
    expect(parseBundle(tooMany, manifest())).toEqual({ ok: false, error: "malformed" });
    expect(parseBundle({ ...bundle(), source: "youtube" }, manifest())).toEqual({ ok: false, error: "malformed" });
    expect(parseBundle({ ...bundle(), source: "twitch" }, manifest())).toEqual({ ok: false, error: "malformed" });
    expect(parseBundle({ ...bundle(), source: "twitch", standing: null }, manifest()).ok).toBe(true);
    const dup = {
      ...bundle(),
      emotes: [...bundle().emotes, { code: "hype", tier: 1, animated: false, file: "files/emote-hype.png" }],
    };
    expect(parseBundle(dup, manifest())).toEqual({ ok: false, error: "malformed" });
    const dupFile = { v: 1, files: [...manifest().files, manifest().files[0]] };
    expect(parseBundle(bundle(), dupFile)).toEqual({ ok: false, error: "malformed" });
    expect(parseBundle({ ...bundle(), standing: { payload: "x", signature: "short" } }, manifest()).ok).toBe(false);
  });

  test("a referenced file missing from the manifest, and an oversized emote, are refused", () => {
    expect(parseBundle(bundle(), { v: 1, files: [manifest().files[0]] })).toEqual({ ok: false, error: "missing_file" });
    const big = manifest();
    big.files[1] = { ...big.files[1]!, sizeBytes: PORTABILITY_LIMITS.maxEmoteBytes + 1 };
    expect(parseBundle(bundle(), big)).toEqual({ ok: false, error: "file_too_large" });
  });

  test("file names cannot escape files/", () => {
    for (const bad of [
      "../etc/passwd",
      "files/../x.png",
      "files/a/b.png",
      "files/.hidden",
      "/files/x.png",
      "files/",
      "x.png",
      "files/a..png",
    ])
      expect(BundleFileName.safeParse(bad).success).toBe(false);
    for (const ok of ["files/a.png", "files/emote-1_x.webp"]) expect(BundleFileName.safeParse(ok).success).toBe(true);
  });

  test("the schedule is carried and must be well formed", () => {
    expect(
      PortabilityBundle.safeParse({
        ...bundle(),
        schedule: [{ startsAt: "tomorrow", endsAt: null, title: "", category: null }],
      }).success,
    ).toBe(false);
  });
});
