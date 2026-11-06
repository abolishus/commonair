// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-social's identity step: who gets which art, and the API calls (against a fake), resume-safe. */
import { ChannelSocial, type ChannelTheme } from "@commonair/contracts/shapes";
import { describe, expect, test } from "vite-plus/test";
import { decodePng } from "../../src/png.ts";
import { selectUnits } from "../../src/seed/checkpoint.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import {
  type IdentityClient,
  type IdentityExisting,
  type IdentityPlan,
  NO_AVATAR,
  PANEL_LINK_ORIGIN,
  SHOWCASE_STREAMERS,
  VIEWER_AVATAR_SHARE,
  identityCounts,
  inPool,
  planIdentity,
  seedIdentity,
} from "../../src/seed/social/identity.ts";
import { planSocial } from "../../src/seed/social/plan.ts";
import { SEED_UNITS, orderUnits } from "../../src/seed/units.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const social = (scale: SeedScale) => planSocial(createRng(7).fork("social"), scale, NOW);
const SMALL = social(SEED_SCALES.small);
const MEDIUM = social(SEED_SCALES.medium);
const identity = (p = SMALL, seed = 7) => planIdentity(createRng(seed).fork("social").fork("identity"), p);

describe("planIdentity", () => {
  test("every streamer has an avatar; about 70% of viewer-only accounts; never the bot or newbie", () => {
    for (const p of [SMALL, MEDIUM]) {
      const plan = identity(p);
      const has = new Set(plan.avatars);
      for (const c of p.channels.filter((x) => x.streamer)) expect(has.has(c.ownerHandle), c.ownerHandle).toBe(true);
      for (const h of NO_AVATAR) expect(has.has(h)).toBe(false);
      expect(has.has("bot1")).toBe(false);
      const bulkViewers = p.accounts.filter((a) => a.kind === "bulk-viewer");
      const share = bulkViewers.filter((a) => has.has(a.handle)).length / bulkViewers.length;
      expect(share).toBeGreaterThan(VIEWER_AVATAR_SHARE - 0.15);
      expect(share).toBeLessThan(VIEWER_AVATAR_SHARE + 0.15);
      expect(new Set(plan.avatars).size).toBe(plan.avatars.length);
    }
  });

  test("counts per scale: avatars, banners, panels and box art", () => {
    const counts = (scale: SeedScale) => identityCounts(identity(social(scale)));
    const small = counts(SEED_SCALES.small);
    const medium = counts(SEED_SCALES.medium);
    for (const c of [small, medium]) {
      expect(c.banners).toBe(SHOWCASE_STREAMERS.length);
      expect(c.panels).toBeGreaterThanOrEqual(3 * SHOWCASE_STREAMERS.length);
      expect(c.panels).toBeLessThanOrEqual(5 * SHOWCASE_STREAMERS.length);
      expect(c.panelImages).toBeGreaterThanOrEqual(SHOWCASE_STREAMERS.length);
      expect(c.boxArt).toBe(SMALL.categories.length);
    }
    // Streamers and fixed logins always; bulk viewers at the share.
    const floor = (p: typeof SMALL) =>
      p.accounts.filter((a) => a.kind !== "bulk-viewer" && a.kind !== "bot").length - 1;
    expect(small.avatars).toBeGreaterThanOrEqual(floor(SMALL) + Math.round(0.5 * SEED_SCALES.small.viewers));
    expect(small.avatars).toBeLessThanOrEqual(floor(SMALL) + SEED_SCALES.small.viewers);
    expect(medium.avatars).toBeGreaterThan(floor(MEDIUM) + Math.round(0.6 * SEED_SCALES.medium.viewers));
  });

  test("showcase panels: 3–5 each, titles within the contract, links to example.org only, one with an image", () => {
    const plan = identity();
    expect(plan.panels.map((p) => p.handle)).toEqual([...SHOWCASE_STREAMERS]);
    for (const { handle, panels } of plan.panels) {
      expect(panels.length).toBeGreaterThanOrEqual(3);
      expect(panels.length).toBeLessThanOrEqual(5);
      expect(panels[0]?.image).toBe(true);
      // The resume check finds a channel's API panels by their links.
      expect(
        panels.some((p) => p.linkUrl !== null),
        handle,
      ).toBe(true);
      for (const p of panels) {
        expect(p.title.length).toBeLessThanOrEqual(60);
        expect(p.body.length).toBeLessThanOrEqual(5_000);
      }
      for (const link of panels.flatMap((p) => (p.linkUrl ? [new URL(p.linkUrl)] : []))) {
        expect(link.origin).toBe(PANEL_LINK_ORIGIN);
        expect(link.pathname.startsWith("/demo_")).toBe(true);
      }
    }
  });

  test("showcase socials: each channel's links pass the contract and stay on reserved hosts", () => {
    const plan = identity();
    expect(plan.socials.map((p) => p.handle)).toEqual([...SHOWCASE_STREAMERS]);
    for (const { handle, socials } of plan.socials) {
      expect(socials.length, handle).toBeGreaterThanOrEqual(3);
      for (const social of socials) {
        expect(ChannelSocial.safeParse(social).success, social.url).toBe(true);
        expect(new URL(social.url).hostname).toMatch(/(^|\.)example\.(org|com)$/);
        expect(social.url).toContain("demo_");
      }
    }
    expect(identityCounts(plan).socials).toBe(plan.socials.reduce((n, p) => n + p.socials.length, 0));
  });

  test("deterministic per seed", () => {
    expect(identity(SMALL, 7)).toEqual(identity(SMALL, 7));
    expect(identity(SMALL, 7).avatars).not.toEqual(identity(SMALL, 8).avatars);
  });
});

/** An in-memory API: channels with themes and panels, uploads that hand back keys. */
function fakeApi() {
  const calls: string[] = [];
  const themes = new Map<string, ChannelTheme>();
  const panels = new Map<string, { imageKey: string | null; linkUrl: string | null }[]>();
  const images = new Map<string, string>();
  const socials = new Map<string, ChannelSocial[]>();
  const uploads: { channel: string; purpose: string; png: Uint8Array }[] = [];
  const clientFor = async (handle: string): Promise<IdentityClient> => {
    calls.push(`sign-in ${handle}`);
    return {
      async upload(channel, purpose, png) {
        uploads.push({ channel, purpose, png });
        return `channels/${channel}/${purpose}/${uploads.length}.png`;
      },
      theme: async (channel) => ({ accent: "teal", ...themes.get(channel) }),
      async setTheme(channel, theme) {
        themes.set(channel, theme);
      },
      async setProfileImage(key) {
        images.set(handle, key);
      },
      async setPanels(channel, rows) {
        panels.set(channel, rows);
      },
      async setSocials(channel, list) {
        socials.set(channel, list);
      },
    };
  };
  return { calls, themes, panels, images, socials, uploads, clientFor };
}

const NONE: IdentityExisting = {
  avatars: new Set(),
  profileImages: new Set(),
  banners: new Set(),
  panels: new Set(),
  socials: new Set(),
};
const PLAN: IdentityPlan = {
  avatars: ["streamer1", "v00001", "v00002"],
  banners: ["streamer1"],
  panels: [
    {
      handle: "streamer1",
      panels: [
        { title: "About", body: "Hi", image: true, linkUrl: null },
        { title: "Links", body: "More", image: false, linkUrl: `${PANEL_LINK_ORIGIN}/demo_streamer1/links` },
      ],
    },
  ],
  socials: [{ handle: "streamer1", socials: [{ platform: "website", url: "https://example.org/demo_streamer1" }] }],
  boxArt: ["art"],
};
const input = (api: ReturnType<typeof fakeApi>, existing = NONE, plan = PLAN) => ({
  plan,
  slugOf: (h: string) => `demo_${h}`,
  idOf: (h: string) => `id-${h}`,
  clientFor: api.clientFor,
  existing,
  rng: createRng(1).fork("identity-art"),
  signal: new AbortController().signal,
});

describe("seedIdentity", () => {
  test("uploads each avatar, banner and panel image as a PNG and points the theme and profile at it", async () => {
    const api = fakeApi();
    const r = await seedIdentity(input(api));
    expect(r).toEqual({ avatars: 3, profileImages: 3, banners: 1, panels: 2, panelImages: 1, socials: 1, skipped: 0 });
    expect(api.socials.get("demo_streamer1")).toEqual([
      { platform: "website", url: "https://example.org/demo_streamer1" },
    ]);
    expect(api.uploads.map((u) => u.purpose).sort()).toEqual(["avatar", "avatar", "avatar", "banner", "panel"]);
    for (const u of api.uploads) expect(decodePng(u.png).width).toBeGreaterThan(0);
    const t = api.themes.get("demo_streamer1");
    // The rest of the theme survives (the merge the appearance card does).
    expect(t?.accent).toBe("teal");
    expect(t?.avatarKey).toMatch(/^channels\/demo_streamer1\/avatar\//);
    expect(t?.bannerKey).toMatch(/^channels\/demo_streamer1\/banner\//);
    expect(api.images.get("v00002")).toBe(api.themes.get("demo_v00002")?.avatarKey);
    const rows = api.panels.get("demo_streamer1");
    expect(rows?.[0]?.imageKey).toMatch(/\/panel\//);
    expect(rows?.[1]).toEqual({
      title: "Links",
      body: "More",
      imageKey: null,
      linkUrl: `${PANEL_LINK_ORIGIN}/demo_streamer1/links`,
    });
  });

  test("the same plan uploads the same bytes (a resume redraws identical art)", async () => {
    const a = fakeApi();
    const b = fakeApi();
    await seedIdentity({ ...input(a), concurrency: 1 });
    await seedIdentity({ ...input(b), concurrency: 3 });
    const bytes = (x: ReturnType<typeof fakeApi>) =>
      new Map(x.uploads.map((u) => [`${u.channel}/${u.purpose}`, Buffer.from(u.png).toString("base64")]));
    expect(bytes(a)).toEqual(bytes(b));
  });

  test("a repeat (or a resume) uploads nothing that already exists", async () => {
    const api = fakeApi();
    const done: IdentityExisting = {
      avatars: new Set(["streamer1", "v00001", "v00002"]),
      profileImages: new Set(["streamer1", "v00001", "v00002"]),
      banners: new Set(["streamer1"]),
      panels: new Set(["streamer1"]),
      socials: new Set(["streamer1"]),
    };
    const r = await seedIdentity(input(api, done));
    expect(api.uploads).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(r).toEqual({ avatars: 0, profileImages: 0, banners: 0, panels: 0, panelImages: 0, socials: 0, skipped: 6 });
  });

  test("an avatar set without the profile image (an interrupted attempt) is reused, not re-uploaded", async () => {
    const api = fakeApi();
    api.themes.set("demo_v00001", { avatarKey: "channels/demo_v00001/avatar/old.png" });
    const r = await seedIdentity(
      input(
        api,
        { ...NONE, avatars: new Set(["v00001"]) },
        { ...PLAN, avatars: ["v00001"], banners: [], panels: [], socials: [] },
      ),
    );
    expect(api.uploads).toEqual([]);
    expect(api.images.get("v00001")).toBe("channels/demo_v00001/avatar/old.png");
    expect(r.profileImages).toBe(1);
  });

  test("a failed upload names the account and the step", async () => {
    const api = fakeApi();
    const failing = async (h: string) => ({
      ...(await api.clientFor(h)),
      upload: async () => {
        throw new Error("commit refused");
      },
    });
    await expect(seedIdentity({ ...input(api), clientFor: failing })).rejects.toThrow(/avatar upload for .* failed/);
  });

  test("a resume after seed-social never runs seed-social (its avatars stay as uploaded)", () => {
    const resumed = selectUnits(orderUnits(SEED_UNITS), "interact");
    expect(resumed.resumeAfter).toBe("social");
    expect(resumed.run.map((u) => u.name)).not.toContain("social");
  });
});

describe("inPool", () => {
  test("bounded concurrency, every item once, the first failure rethrown", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await inPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      seen.push(n);
      active--;
    });
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await expect(
      inPool([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("two");
      }),
    ).rejects.toThrow("two");
    await inPool([], 4, async () => undefined);
  });
});
