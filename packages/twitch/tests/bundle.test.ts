// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `snapshotOf`, `toBundle` and `previewItems`: every mapping, the tier table, skipped types, the mature suggestion, the schedule. */
import { parseBundle, PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import { describe, expect, test } from "vite-plus/test";
import {
  capText,
  emoteFile,
  emoteImageUrl,
  emoteTier,
  HelixChannelsResponse,
  HelixEmotesResponse,
  HelixScheduleResponse,
  HelixUsersResponse,
  mapLanguage,
  mapTags,
  matureSuggested,
  previewItems,
  snapshotOf,
  toBundle,
  TwitchSnapshot,
  type TwitchSnapshot as Snapshot,
} from "../src/index.ts";
import { CHANNEL, EMOTES, SCHEDULE_PAGE_1, SCHEDULE_PAGE_2, USER } from "./fixtures.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

function snapshot(): Snapshot {
  return snapshotOf({
    user: HelixUsersResponse.parse({ data: [USER] }).data[0]!,
    channel: HelixChannelsResponse.parse({ data: [CHANNEL] }).data[0]!,
    emotes: HelixEmotesResponse.parse(EMOTES),
    schedule: [
      ...(HelixScheduleResponse.parse(SCHEDULE_PAGE_1).data.segments ?? []),
      ...(HelixScheduleResponse.parse(SCHEDULE_PAGE_2).data.segments ?? []),
    ],
  });
}

const opts = { domain: "commonair.test", exportedAt: NOW, fallbackLanguage: "de" };

describe("snapshotOf", () => {
  test("keeps public fields only, and parses as the stored preview", () => {
    const s = snapshot();
    expect(TwitchSnapshot.parse(s)).toEqual(s);
    expect(s.user).toEqual({
      id: "90000001",
      login: "pixelgardener",
      displayName: "PixelGardener",
      description: USER.description,
    });
    expect(JSON.stringify(s)).not.toContain("profile_image_url");
    expect(s.emotes.find((e) => e.id === "e2")).toMatchObject({ animated: true });
    expect(s.schedule).toEqual([
      {
        startsAt: "2026-11-03T18:00:00Z",
        endsAt: "2026-11-03T21:00:00Z",
        title: "Seed swap Tuesday",
        category: "Pixel Art Gardening",
      },
      { startsAt: "2026-11-05T18:00:00Z", endsAt: null, title: "Harvest stream", category: null },
    ]);
  });

  test("the image: the largest static one, or the animated template", () => {
    const [still, animated] = HelixEmotesResponse.parse(EMOTES).data;
    expect(emoteImageUrl(still!, EMOTES.template)).toBe(
      "https://static-cdn.jtvnw.net/emoticons/v2/e1/static/light/3.0",
    );
    expect(emoteImageUrl(animated!, EMOTES.template)).toBe(
      "https://static-cdn.jtvnw.net/emoticons/v2/e2/animated/dark/3.0",
    );
    expect(emoteImageUrl(animated!, undefined)).toContain("/static/light/3.0");
    expect(emoteImageUrl({ ...still!, images: { url_1x: "https://x.test/1" } }, undefined)).toBe("https://x.test/1");
    expect(emoteImageUrl({ ...still!, images: {} }, undefined)).toBeNull();
  });
});

describe("field rules", () => {
  test("tags go through the studio's rules", () => {
    expect(mapTags(["PixelArt", "Cozy", "pixelart", "has space", "x".repeat(26), "", "日本語", "a-b", "bad!"])).toEqual(
      ["pixelart", "cozy", "日本語", "a-b"],
    );
    expect(mapTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
    expect(mapTags([])).toEqual([]);
  });

  test("language through the studio's codes, with a fallback", () => {
    expect(mapLanguage("en", "de")).toBe("en");
    expect(mapLanguage("ZH-HK", "de")).toBe("zh-hk");
    expect(mapLanguage("other", "de")).toBe("de");
    expect(mapLanguage("", "de")).toBe("de");
    expect(mapLanguage("e", "de")).toBe("de");
  });

  test("any content classification label suggests mature", () => {
    expect(matureSuggested([])).toBe(false);
    expect(matureSuggested(["Gambling"])).toBe(true);
  });

  test("the tier table", () => {
    expect(emoteTier({ type: "subscriptions", tier: "1000" })).toEqual({ tier: 1 });
    expect(emoteTier({ type: "subscriptions", tier: "2000" })).toEqual({ tier: 2 });
    expect(emoteTier({ type: "subscriptions", tier: "3000" })).toEqual({ tier: 3 });
    expect(emoteTier({ type: "subscriptions", tier: "4000" })).toEqual({ skip: "unsupported_emote_type" });
    expect(emoteTier({ type: "subscriptions", tier: "" })).toEqual({ skip: "unsupported_emote_type" });
    expect(emoteTier({ type: "follower", tier: "" })).toEqual({ tier: 0 });
    expect(emoteTier({ type: "bitstier", tier: "" })).toEqual({ skip: "bits_emote" });
    expect(emoteTier({ type: "limitedtime", tier: "" })).toEqual({ skip: "unsupported_emote_type" });
    expect(emoteTier({ type: "globals", tier: "" })).toEqual({ skip: "unsupported_emote_type" });
  });

  test("capText never splits a surrogate pair", () => {
    expect(capText("abc", 5)).toBe("abc");
    expect(capText("ab😀", 3)).toBe("ab");
    expect(capText("ab😀c", 4)).toBe("ab😀");
  });

  test("emote file names are flat and safe", () => {
    expect(emoteFile("emotesv2_abc")).toBe("files/emote-emotesv2_abc");
    expect(emoteFile("../x/y")).toBe("files/emote-__x_y");
    expect(emoteFile("a".repeat(200))).toHaveLength("files/emote-".length + 90);
  });
});

describe("toBundle", () => {
  test("maps every field into a valid twitch bundle", () => {
    const { bundle, sources, skipped } = toBundle(snapshot(), opts);
    expect(bundle.v).toBe(1);
    expect(bundle.source).toBe("twitch");
    expect(bundle.standing).toBeNull();
    expect(bundle.exportedAt).toBe(NOW.toISOString());
    expect(bundle.instance).toEqual({ domain: "commonair.test", software: "commonair", version: "" });
    expect(bundle.channel).toEqual({
      title: CHANNEL.title,
      description: USER.description,
      tags: ["pixelart", "cozy", "english"],
      language: "en",
      mature: true,
      categorySlug: null,
      categoryName: "Pixel Art Gardening",
    });
    expect(bundle.panels).toEqual([]);
    expect(bundle.emotes).toEqual([
      { code: "pgWave", tier: 1, animated: false, file: "files/emote-e1" },
      { code: "pgHype", tier: 2, animated: true, file: "files/emote-e2" },
      { code: "pgLove", tier: 3, animated: false, file: "files/emote-e3" },
      { code: "pgHi", tier: 0, animated: false, file: "files/emote-e4" },
    ]);
    expect(sources.map((s) => [s.code, s.file])).toEqual(bundle.emotes.map((e) => [e.code, e.file]));
    expect(sources[1]?.url).toContain("/animated/");
    expect(skipped).toEqual([
      { ref: "pgBits", reason: "bits_emote" },
      { ref: "pgOdd", reason: "unsupported_emote_type" },
      { ref: "pg-bad!", reason: "invalid_code" },
      { ref: "PGWAVE", reason: "duplicate_code" },
    ]);
    // The schedule is carried in the bundle (never applied: applyBundle reports it).
    expect(bundle.schedule).toEqual([
      {
        startsAt: "2026-11-03T18:00:00Z",
        endsAt: "2026-11-03T21:00:00Z",
        title: "Seed swap Tuesday",
        category: "Pixel Art Gardening",
      },
      { startsAt: "2026-11-05T18:00:00Z", endsAt: null, title: "Harvest stream", category: null },
    ]);
    // The bundle passes the shared parser with a manifest listing its files.
    const manifest = {
      v: 1,
      files: bundle.emotes.map((e) => ({
        file: e.file,
        sizeBytes: 10,
        sha256: "0".repeat(64),
        contentType: "image/png",
      })),
    };
    expect(parseBundle(bundle, manifest).ok).toBe(true);
  });

  test("no labels, no category, `other` language, empty description", () => {
    const s = snapshot();
    s.channel.classificationLabels = [];
    s.channel.gameName = "";
    s.channel.language = "other";
    s.user.description = "";
    s.channel.title = `  ${"t".repeat(200)}  `;
    const { bundle } = toBundle(s, opts);
    expect(bundle.channel.mature).toBe(false);
    expect(bundle.channel.categoryName).toBeNull();
    expect(bundle.channel.language).toBe("de");
    expect(bundle.channel.description).toBe("");
    expect(bundle.channel.title).toHaveLength(140);
    expect(toBundle(s, { ...opts, fallbackLanguage: "bogus!" }).bundle.channel.language).toBe("en");
  });

  test("taken codes are left out; the emote cap holds; the domain is checked", () => {
    const { bundle, skipped } = toBundle(snapshot(), { ...opts, takenCodes: new Set(["pgLove"]) });
    expect(bundle.emotes.map((e) => e.code)).not.toContain("pgLove");
    expect(skipped).toContainEqual({ ref: "pgLove", reason: "code_taken" });
    const many = snapshot();
    many.emotes = Array.from({ length: 120 }, (_, i) => ({
      id: `m${i}`,
      name: `pg${i}`,
      tier: "",
      type: "follower",
      animated: false,
      imageUrl: `https://static-cdn.jtvnw.net/x/${i}`,
    }));
    const big = toBundle(many, opts);
    expect(big.bundle.emotes).toHaveLength(PORTABILITY_LIMITS.maxEmotes);
    expect(big.skipped.filter((x) => x.reason === "emote_limit")).toHaveLength(20);
    expect(toBundle(snapshot(), { ...opts, domain: "Bad Domain!" }).bundle.instance.domain).toBe("localhost");
    expect(toBundle(snapshot(), { ...opts, domain: "LOCALHOST:8080" }).bundle.instance.domain).toBe("localhost:8080");
  });

  test("an emote with no image is not offered", () => {
    const s = snapshot();
    s.emotes = [{ id: "z", name: "pgNone", tier: "", type: "follower", animated: false, imageUrl: null }];
    const r = toBundle(s, opts);
    expect(r.bundle.emotes).toEqual([]);
    expect(r.skipped).toEqual([{ ref: "pgNone", reason: "invalid_code" }]);
  });
});

describe("previewItems", () => {
  test("the channel, every emote with its skip reason, the schedule carried", () => {
    const items = previewItems(snapshot(), new Set(["pgHi"]));
    expect(items[0]).toEqual({ kind: "channel", ref: "channel", label: CHANNEL.title, outcome: null, reason: null });
    const emotes = items.filter((i) => i.kind === "emote");
    expect(emotes.map((e) => [e.ref, e.outcome, e.reason])).toEqual([
      ["pgWave", null, null],
      ["pgHype", null, null],
      ["pgLove", null, null],
      ["pgHi", "skipped", "code_taken"],
      ["pgBits", "skipped", "bits_emote"],
      ["pgOdd", "skipped", "unsupported_emote_type"],
      ["pg-bad!", "skipped", "invalid_code"],
      ["PGWAVE", "skipped", "duplicate_code"],
    ]);
    expect(items.at(-1)).toEqual({
      kind: "schedule",
      ref: "schedule",
      label: "2",
      outcome: "skipped",
      reason: "carried_not_applied",
    });
  });

  test("no schedule, no schedule item", () => {
    const s = snapshot();
    s.schedule = [];
    expect(previewItems(s).some((i) => i.kind === "schedule")).toBe(false);
  });
});
