// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W3-portability, pure parts (ADR 0037): the bundle archive (versions, caps, hash mismatch, path
 * traversal), the standing check against the `standing` vectors and tamper cases, the category
 * mapping, the mature rule and the studio-edit normalisation.
 */
import {
  BUNDLE_FILES,
  PORTABILITY_BUNDLE_VERSION,
  PORTABILITY_LIMITS,
  type PortabilityBundle,
} from "@commonair/contracts/portability";
import vectors from "@commonair/tokens/vectors.json" with { type: "json" };
import type { StandingKey } from "@commonair/tokens/standing";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, test } from "vite-plus/test";
import { isSafeEntryName, readBundleArchive, sha256Hex, writeBundleArchive } from "../src/portability/archive.ts";
import { sniffImageType } from "../src/portability/import/apply.ts";
import { previewItems } from "../src/portability/import/preview.ts";
import {
  channelPatch,
  mapCategory,
  matureAfterImport,
  normalizeTags,
  panelText,
  redactStreamKeys,
} from "../src/portability/import/rules.ts";
import {
  checkStanding,
  claimedIssuer,
  refusesImport,
  standingVerifiedColumn,
} from "../src/portability/import/standing-check.ts";
import { movedHost } from "../src/portability/moved.ts";
import { standingWindowStart } from "../src/portability/standing.ts";
import { imageKeyOf } from "../src/exports/bundle.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GIF = new Uint8Array([...strToU8("GIF89a"), 0, 0]);

const baseBundle = (over: Partial<PortabilityBundle> = {}): PortabilityBundle => ({
  v: 1,
  source: "commonair",
  exportedAt: "2026-11-01T00:00:00.000Z",
  instance: { domain: "old.example", software: "commonair", version: "abc" },
  channel: {
    title: "Night owls",
    description: "Late streams",
    tags: ["chill"],
    language: "en",
    mature: false,
    categorySlug: "just-chatting",
    categoryName: "Just Chatting",
  },
  panels: [{ title: "About", body: "Hi", link: "https://old.example/about", image: { file: "files/panel-1.png" } }],
  emotes: [{ code: "wave", tier: 0, animated: false, file: "files/emote-wave.png" }],
  schedule: [],
  standing: null,
  ...over,
});
const files = () =>
  new Map([
    ["files/panel-1.png", { bytes: PNG, contentType: "image/png" as const }],
    ["files/emote-wave.png", { bytes: PNG, contentType: "image/png" as const }],
  ]);

/** A hand-made archive, to build what `writeBundleArchive` never would. */
async function rawArchive(
  bundle: unknown,
  entries: Record<string, Uint8Array>,
  manifest?: unknown,
): Promise<Uint8Array> {
  const listed = [];
  for (const [file, bytes] of Object.entries(entries))
    if (file.startsWith("files/"))
      listed.push({ file, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes), contentType: "image/png" });
  const z: Zippable = {
    [BUNDLE_FILES.bundle]: strToU8(JSON.stringify(bundle)),
    [BUNDLE_FILES.manifest]: strToU8(JSON.stringify(manifest ?? { v: 1, files: listed })),
  };
  for (const [name, bytes] of Object.entries(entries)) z[name] = bytes;
  return zipSync(z);
}

describe("bundle archive", () => {
  test("round trip: what is written reads back, bytes checked against the manifest", async () => {
    const { bytes, manifest } = await writeBundleArchive(baseBundle(), files(), new Date("2026-11-01T00:00:00Z"));
    expect(manifest.files.map((f) => f.file)).toEqual(["files/emote-wave.png", "files/panel-1.png"]);
    const read = await readBundleArchive(bytes);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bundle).toEqual(baseBundle());
    expect([...read.files.keys()].sort()).toEqual(["files/emote-wave.png", "files/panel-1.png"]);
    expect(read.files.get("files/panel-1.png")).toEqual(PNG);
  });

  test("an unknown version is refused before anything else", async () => {
    const bytes = await rawArchive(
      { ...baseBundle(), v: 2 },
      { "files/panel-1.png": PNG, "files/emote-wave.png": PNG },
    );
    expect(await readBundleArchive(bytes)).toEqual({ ok: false, error: "unsupported_version" });
    const m = await rawArchive(baseBundle(), {}, { v: 9, files: [] });
    expect(await readBundleArchive(m)).toEqual({ ok: false, error: "unsupported_version" });
  });

  test("not a zip, malformed JSON, a missing manifest", async () => {
    expect(await readBundleArchive(strToU8("hello"))).toEqual({ ok: false, error: "not_a_zip" });
    const bad = zipSync({ [BUNDLE_FILES.bundle]: strToU8("{"), [BUNDLE_FILES.manifest]: strToU8("{}") });
    expect(await readBundleArchive(bad)).toEqual({ ok: false, error: "malformed" });
    const noManifest = zipSync({ [BUNDLE_FILES.bundle]: strToU8(JSON.stringify(baseBundle())) });
    expect(await readBundleArchive(noManifest)).toEqual({ ok: false, error: "malformed" });
  });

  test("a file whose bytes differ from the manifest (a hash or size mismatch) is refused", async () => {
    const entries = { "files/panel-1.png": PNG, "files/emote-wave.png": PNG };
    const listed = [];
    for (const [file, b] of Object.entries(entries))
      listed.push({ file, sizeBytes: b.byteLength, sha256: await sha256Hex(b), contentType: "image/png" });
    const tampered = new Uint8Array(PNG);
    tampered[11] = 9;
    const bytes = await rawArchive(
      baseBundle(),
      { ...entries, "files/emote-wave.png": tampered },
      { v: 1, files: listed },
    );
    expect(await readBundleArchive(bytes)).toEqual({ ok: false, error: "hash_mismatch" });
    // A file the manifest does not list rides along: refused.
    const extra = await rawArchive(baseBundle(), entries, { v: 1, files: listed });
    const withExtra = zipSync({ ...unzipSync(extra), "files/smuggled.png": PNG });
    expect(await readBundleArchive(withExtra)).toEqual({ ok: false, error: "hash_mismatch" });
  });

  test("a referenced file missing from the manifest or the archive", async () => {
    const missing = await rawArchive(baseBundle(), { "files/panel-1.png": PNG });
    expect(await readBundleArchive(missing)).toEqual({ ok: false, error: "missing_file" });
    const listed = [
      { file: "files/panel-1.png", sizeBytes: PNG.byteLength, sha256: await sha256Hex(PNG), contentType: "image/png" },
      {
        file: "files/emote-wave.png",
        sizeBytes: PNG.byteLength,
        sha256: await sha256Hex(PNG),
        contentType: "image/png",
      },
    ];
    const notInZip = await rawArchive(baseBundle(), { "files/panel-1.png": PNG }, { v: 1, files: listed });
    expect(await readBundleArchive(notInZip)).toEqual({ ok: false, error: "missing_file" });
  });

  test.each([
    "../evil.png",
    "/etc/passwd",
    "files/../evil.png",
    "files/sub/evil.png",
    "files/.hidden",
    "other.json",
    "files\\evil.png",
  ])("an entry named %s is refused (path traversal and strays)", async (name) => {
    expect(isSafeEntryName(name)).toBe(false);
    const bytes = await rawArchive(baseBundle({ panels: [], emotes: [] }), { [name]: PNG });
    expect(await readBundleArchive(bytes)).toEqual({ ok: false, error: "unsafe_path" });
  });

  test("a file name with a parent reference in bundle.json is malformed", async () => {
    const b = baseBundle({ emotes: [{ code: "wave", tier: 0, animated: false, file: "files/..x.png" }], panels: [] });
    const bytes = await rawArchive(b, {});
    expect(await readBundleArchive(bytes)).toEqual({ ok: false, error: "malformed" });
  });

  test("caps: an emote over its byte cap, a file over the per-file cap, too many files, too many emotes", async () => {
    const big = new Uint8Array(PORTABILITY_LIMITS.maxEmoteBytes + 1);
    big.set(PNG);
    const overEmote = await rawArchive(baseBundle({ panels: [] }), { "files/emote-wave.png": big });
    expect(await readBundleArchive(overEmote)).toEqual({ ok: false, error: "file_too_large" });
    const huge = new Uint8Array(PORTABILITY_LIMITS.maxPanelImageBytes + 1);
    const overFile = await rawArchive(
      baseBundle({ emotes: [], panels: [] }),
      { "files/huge.png": huge },
      { v: 1, files: [] },
    );
    expect(await readBundleArchive(overFile)).toEqual({ ok: false, error: "file_too_large" });
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < PORTABILITY_LIMITS.maxFiles + 1; i++) many[`files/f${i}.png`] = PNG;
    const tooMany = await rawArchive(baseBundle({ emotes: [], panels: [] }), many, { v: 1, files: [] });
    expect(await readBundleArchive(tooMany)).toEqual({ ok: false, error: "too_many_files" });
    const emotes = Array.from({ length: PORTABILITY_LIMITS.maxEmotes + 1 }, (_, i) => ({
      code: `e${i}x`,
      tier: 0,
      animated: false,
      file: "files/emote-wave.png",
    }));
    const tooManyEmotes = await rawArchive(baseBundle({ emotes, panels: [] }), { "files/emote-wave.png": PNG });
    expect(await readBundleArchive(tooManyEmotes)).toEqual({ ok: false, error: "malformed" });
    expect(PORTABILITY_BUNDLE_VERSION).toBe(1);
  });

  test("an archive over the archive cap is refused unread", async () => {
    const r = await readBundleArchive(new Uint8Array(PORTABILITY_LIMITS.maxArchiveBytes + 1));
    expect(r).toEqual({ ok: false, error: "archive_too_large" });
  });
});

describe("standing check (vectors)", () => {
  const s = vectors.standing as unknown as {
    keys: StandingKey[];
    bundle: PortabilityBundle;
    signed: { payload: string; signature: string };
    cases: {
      name: string;
      signed: { payload: string; signature: string };
      keys?: StandingKey[];
      now: string;
      error: string | null;
    }[];
  };
  const deps = (now: string, keys: StandingKey[] = s.keys) => ({
    db: {} as never,
    ownOrigin: "https://here.example",
    fetch: { allowInsecure: false },
    fetchKeys: async (issuer: string) => {
      expect(issuer).toBe("https://instance.example");
      return { ok: true as const, keys };
    },
    now: new Date(now),
  });

  test.each(s.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const check = await checkStanding({ ...s.bundle, standing: c.signed }, deps(c.now, c.keys ?? s.keys));
    const statement = check.state === "verified" ? check.statement : null;
    const expectedRefusal = statement?.activeSuspension
      ? "standing_suspended"
      : statement?.legalHold
        ? "standing_legal_hold"
        : null;
    expect({ state: check.state, reason: check.state === "unverified" ? check.reason : null }).toEqual(
      c.error === null ? { state: "verified", reason: null } : { state: "unverified", reason: c.error },
    );
    expect(refusesImport(check)).toBe(expectedRefusal);
  });

  test("bound to its bundle: a statement spliced into another bundle is unverified, never clean", async () => {
    const now = "2023-11-20T00:00:00.000Z";
    const other = { ...s.bundle, channel: { ...s.bundle.channel, title: "Someone else" }, standing: s.signed };
    expect(await checkStanding(other, deps(now))).toEqual({
      state: "unverified",
      issuer: "https://instance.example",
      reason: "bundle_mismatch",
    });
    const moved = { ...s.bundle, instance: { ...s.bundle.instance, domain: "evil.example" }, standing: s.signed };
    expect(await checkStanding(moved, deps(now))).toMatchObject({ state: "unverified", reason: "issuer_mismatch" });
  });

  test("missing, unreachable keys and garbage", async () => {
    const now = "2023-11-20T00:00:00.000Z";
    expect(await checkStanding({ ...s.bundle, standing: null }, deps(now))).toEqual({ state: "missing" });
    const down = { ...deps(now), fetchKeys: async () => ({ ok: false as const, error: "unreachable" }) };
    expect(await checkStanding({ ...s.bundle, standing: s.signed }, down)).toMatchObject({
      state: "unverified",
      reason: "keys_unreachable",
    });
    const garbage = { payload: "bm90IGpzb24", signature: s.signed.signature };
    expect(claimedIssuer(garbage.payload)).toBeNull();
    expect(await checkStanding({ ...s.bundle, standing: garbage }, deps(now))).toMatchObject({
      state: "unverified",
      issuer: null,
      reason: "malformed",
    });
  });

  test("standing_verified: null for Twitch bundles, else whether it verified", () => {
    expect(standingVerifiedColumn("twitch", { state: "missing" })).toBeNull();
    expect(standingVerifiedColumn("commonair", { state: "missing" })).toBe(false);
    expect(standingVerifiedColumn("commonair", { state: "unverified", issuer: null, reason: "expired" })).toBe(false);
  });

  test("the counting window is 12 calendar months", () => {
    expect(standingWindowStart(new Date("2026-11-01T12:00:00Z")).toISOString()).toBe("2025-11-01T12:00:00.000Z");
  });
});

describe("import rules", () => {
  const cats = [
    { id: "c1", slug: "just-chatting", name: "Just Chatting", mature: false },
    { id: "c2", slug: "art", name: "Art", mature: false },
    { id: "c3", slug: "after-dark", name: "After Dark", mature: true },
  ];

  test("category: by slug, then by exact name, else unset", () => {
    expect(mapCategory(cats, "art", "Just Chatting")?.id).toBe("c2");
    expect(mapCategory(cats, "missing", "Just Chatting")?.id).toBe("c1");
    expect(mapCategory(cats, "missing", "just chatting")).toBeNull();
    expect(mapCategory(cats, null, null)).toBeNull();
    expect(mapCategory([], "art", "Art")).toBeNull();
  });

  test("mature: never cleared, set by the bundle or a mature category", () => {
    expect(matureAfterImport(true, false, false)).toBe(true);
    expect(matureAfterImport(false, true, false)).toBe(true);
    expect(matureAfterImport(false, false, true)).toBe(true);
    expect(matureAfterImport(false, false, false)).toBe(false);
    const b = baseBundle().channel;
    expect(channelPatch({ mature: true }, { ...b, mature: false }, null).mature).toBe(true);
    expect(channelPatch({ mature: false }, b, cats[2]!)).toMatchObject({ mature: true, categoryId: "c3" });
    expect("categoryId" in channelPatch({ mature: false }, b, null)).toBe(false);
  });

  test("the studio edit's normalisation: tags, language, keys redacted, links http(s) only", () => {
    expect(normalizeTags(["Chill", "chill", "two words", "ok-1", "", "x".repeat(26), "日本"])).toEqual([
      "chill",
      "ok-1",
      "日本",
    ]);
    const key = `live_${"a".repeat(43)}`;
    expect(redactStreamKeys(`my key ${key}!`)).toBe("my key [redacted]!");
    const p = channelPatch(
      { mature: false },
      { ...baseBundle().channel, title: `  T ${key} `, language: "PT-BR" },
      null,
    );
    expect(p).toMatchObject({ title: "T [redacted]", language: "pt-br" });
    expect(panelText({ title: "a", body: "b", link: "ftp://x.example", image: null }).linkUrl).toBeNull();
    expect(panelText({ title: "a", body: "b", link: "https://x.example/", image: null }).linkUrl).toBe(
      "https://x.example/",
    );
  });

  test("preview lines: a known code is skipped as taken, the schedule as carried", () => {
    const b = baseBundle({
      schedule: [{ startsAt: "2026-11-02T20:00:00.000Z", endsAt: null, title: "Show", category: null }],
    });
    expect(previewItems(b, new Set(["wave"]))).toEqual([
      { kind: "channel", ref: "channel", label: "Night owls", outcome: null, reason: null },
      { kind: "panel", ref: "1", label: "About", outcome: null, reason: null },
      { kind: "emote", ref: "wave", label: "wave", outcome: "skipped", reason: "code_taken" },
      { kind: "schedule", ref: "schedule", label: "1", outcome: "skipped", reason: "carried_not_applied" },
    ]);
  });

  test("image sniffing, image keys and the moved host", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(strToU8("<svg/>"))).toBeNull();
    const ch = "01890000-0000-7000-8000-00000000c001";
    const k = `channels/${ch}/panel/01890000-0000-7000-8000-0000000000aa.png`;
    expect(imageKeyOf(k, ch, "panel")).toBe(k);
    expect(imageKeyOf(`https://media.example/${k}`, ch, "panel")).toBe(k);
    expect(imageKeyOf(k, ch, "emote")).toBeNull();
    expect(imageKeyOf(k.replace(ch, "01890000-0000-7000-8000-00000000c002"), ch, "panel")).toBeNull();
    expect(imageKeyOf(null, ch, "panel")).toBeNull();
    expect(movedHost("https://video.example.org/c/ada")).toBe("video.example.org");
    expect(movedHost("nope")).toBe("");
  });
});
