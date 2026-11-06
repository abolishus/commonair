// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's identity step (D1-seed, design review F10): generated avatars, banners and panels,
 * uploaded through the public API exactly as the dashboard's appearance card does it (presigned
 * upload, the scanning commit, then `channels.update` with the merged theme), plus the profile
 * image (`/update-user`) so chat and member lists show the avatar too. The art is `../art.ts`'s,
 * drawn from the unit's PRNG with the user id as the salt, so a resume draws the same pictures.
 *
 * The showcase channels also get social links (`channels.update` with `socials`, the About tab),
 * all under RFC 2606 reserved hosts.
 *
 * Idempotent: an avatar, banner, panel set or social list already on the channel is never set again.
 * Category box art is planned but not uploaded: no procedure sets `categories.box_art_key` yet.
 */
import { AUTH_BASE_PATH } from "@commonair/contracts/auth";
import type { ChannelSocial, ChannelTheme, UploadPurpose } from "@commonair/contracts/shapes";
import type { DbHandle } from "@commonair/db";
import type { Api } from "../../api/client.ts";
import { putPresigned } from "../../safety-io.ts";
import { type ArtFormat, artPng, artRng, artScene } from "../art.ts";
import type { Rng } from "../prng.ts";
import type { SocialPlan } from "./plan.ts";

/** Share of viewer-only accounts (no streaming channel) with an avatar. */
export const VIEWER_AVATAR_SHARE = 0.7;
/** Logins that keep the initial-letter avatar: newbie shows every empty state for comparison. */
export const NO_AVATAR: readonly string[] = ["newbie"];
/** The channels that get a banner and API-made panels. */
export const SHOWCASE_STREAMERS = ["streamer1", "streamer2", "streamer3"] as const;
/** Where seeded panel links point (RFC 2606 reserved). */
export const PANEL_LINK_ORIGIN = "https://example.org";
/** Uploads in flight at once: each is a sign-in, a presigned PUT, a scanning commit and an update. */
export const IDENTITY_CONCURRENCY = 6;

export interface IdentityPanel {
  title: string;
  body: string;
  /** Upload a generated 2:1 image for this panel. */
  image: boolean;
  linkUrl: string | null;
}

export interface IdentityPlan {
  /** Handles that get an avatar (and the same image as their profile picture). */
  avatars: string[];
  banners: string[];
  panels: { handle: string; panels: IdentityPanel[] }[];
  /** The showcase channels' About-tab links, in display order. */
  socials: { handle: string; socials: ChannelSocial[] }[];
  /** Category slugs whose 3:4 box art the seed would upload once an API takes it. */
  boxArt: string[];
}

type PanelText = Omit<IdentityPanel, "image" | "linkUrl"> & { path: string | null };

/** Each showcase channel's panel texts, in its voice; a channel shows 3–5 of them. */
const PANEL_TEXTS: Record<(typeof SHOWCASE_STREAMERS)[number], readonly PanelText[]> = {
  streamer1: [
    {
      title: "About me",
      body: "Pixel artist and **cozy** streamer. I draw tiny worlds and chat about craft.",
      path: null,
    },
    {
      title: "Schedule",
      body: "- Monday: sketches\n- Wednesday: commissions\n- Friday: community art night",
      path: "schedule",
    },
    { title: "Chat rules", body: "1. Be kind.\n2. No spoilers.\n3. Moderators have the final word.", path: null },
    { title: "Palettes", body: "Every palette I use on stream, free to download and remix.", path: "palettes" },
    { title: "Art challenge", body: "A new prompt every month. Post yours with the community tag.", path: "challenge" },
  ],
  streamer2: [
    { title: "About", body: "Lo-fi beats made live, one loop at a time. Requests welcome.", path: null },
    { title: "Gear", body: "A small synth, a borrowed drum machine and too many cables.", path: "gear" },
    { title: "Song requests", body: "Use channel points to request a mood; I build a loop around it.", path: null },
    { title: "Releases", body: "Finished tracks from past streams, free for your own videos.", path: "releases" },
  ],
  streamer3: [
    { title: "Hello!", body: "New here and learning in public: small web projects, start to finish.", path: null },
    { title: "Project log", body: "What we built on each stream, with the code.", path: "log" },
    { title: "Ask me anything", body: "Questions in chat are the best part. No question is too small.", path: null },
  ],
};

/**
 * A showcase channel's links: a website and two or three platforms, every host under
 * `example.org` / `example.com` (reserved), so nothing points at a real account.
 */
const SOCIAL_SETS: Record<
  (typeof SHOWCASE_STREAMERS)[number],
  readonly (readonly [ChannelSocial["platform"], string])[]
> = {
  streamer1: [
    ["website", "https://example.org/{slug}"],
    ["mastodon", "https://mastodon.example.org/@{slug}"],
    ["bluesky", "https://bsky.example.org/profile/{slug}"],
    ["instagram", "https://instagram.example.com/{slug}"],
  ],
  streamer2: [
    ["website", "https://example.org/{slug}/music"],
    ["youtube", "https://youtube.example.com/@{slug}"],
    ["discord", "https://discord.example.com/invite/{slug}"],
  ],
  streamer3: [
    ["github", "https://github.example.com/{slug}"],
    ["mastodon", "https://mastodon.example.org/@{slug}"],
    ["other", "https://example.org/{slug}/notes"],
  ],
};

/** Who gets which art. Pure given `rng` (the unit's `identity` fork). */
export function planIdentity(rng: Rng, plan: Pick<SocialPlan, "accounts" | "channels" | "categories">): IdentityPlan {
  const streaming = new Set(plan.channels.filter((c) => c.streamer).map((c) => c.ownerHandle));
  const picks = rng.fork("avatars");
  const avatars = plan.accounts
    .filter((a) => a.kind !== "bot" && !NO_AVATAR.includes(a.handle))
    // Streamers always; fixed logins always (they are the showcase); bulk viewers at the share.
    .filter((a) => streaming.has(a.handle) || a.kind === "fixed" || picks.chance(VIEWER_AVATAR_SHARE))
    .map((a) => a.handle);
  const present = SHOWCASE_STREAMERS.filter((h) => streaming.has(h));
  const panels = present.map((handle) => {
    const r = rng.fork(`panels:${handle}`);
    const texts = PANEL_TEXTS[handle];
    const n = Math.min(texts.length, r.int(3, 5));
    const slug = plan.channels.find((c) => c.ownerHandle === handle)?.slug ?? handle;
    return {
      handle,
      panels: texts.slice(0, n).map((t, i) => ({
        title: t.title,
        body: t.body,
        // The first panel always has an image, so every showcase channel shows one.
        image: i === 0 || r.chance(0.4),
        linkUrl: t.path ? `${PANEL_LINK_ORIGIN}/${slug}/${t.path}` : null,
      })),
    };
  });
  const socials = present.map((handle) => {
    const slug = plan.channels.find((c) => c.ownerHandle === handle)?.slug ?? handle;
    return {
      handle,
      socials: SOCIAL_SETS[handle].map(([platform, url]) => ({ platform, url: url.replace("{slug}", slug) })),
    };
  });
  return { avatars, banners: [...present], panels, socials, boxArt: plan.categories.map((c) => c.slug) };
}

export function identityCounts(
  p: IdentityPlan,
): Record<"avatars" | "banners" | "panels" | "panelImages" | "socials" | "boxArt", number> {
  const all = p.panels.flatMap((x) => x.panels);
  return {
    avatars: p.avatars.length,
    banners: p.banners.length,
    panels: all.length,
    panelImages: all.filter((x) => x.image).length,
    socials: p.socials.reduce((n, x) => n + x.socials.length, 0),
    boxArt: p.boxArt.length,
  };
}

/** What one signed-in owner can do to their own channel (the real one wraps the API). */
export interface IdentityClient {
  /** Presigned PUT then the scanning commit; returns the committed key. */
  upload(channel: string, purpose: UploadPurpose, png: Uint8Array): Promise<string>;
  theme(channel: string): Promise<ChannelTheme>;
  setTheme(channel: string, theme: ChannelTheme): Promise<void>;
  /** better-auth's `/update-user`: the profile image is one of the member's own avatar uploads. */
  setProfileImage(key: string): Promise<void>;
  setPanels(
    channel: string,
    panels: { title: string; body: string; imageKey: string | null; linkUrl: string | null }[],
  ): Promise<void>;
  /** `channels.update` with `socials` (replaces the whole list). */
  setSocials(channel: string, socials: ChannelSocial[]): Promise<void>;
}

export function apiIdentityClient(api: Api, signal: AbortSignal): IdentityClient {
  const c = api.client.channels;
  return {
    async upload(channel, purpose, png) {
      const up = await c.uploadUrl({ channel, purpose, contentType: "image/png", sizeBytes: png.byteLength });
      await putPresigned(up.uploadUrl, up.headers, png, signal);
      return (await c.commitUpload({ channel, key: up.key })).key;
    },
    theme: async (channel) => (await c.get({ channel })).theme,
    async setTheme(channel, theme) {
      await c.update({ channel, theme });
    },
    async setProfileImage(key) {
      const res = await api.fetch(
        new Request(`${api.baseUrl}${AUTH_BASE_PATH}/update-user`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: key }),
        }),
      );
      if (!res.ok) throw new Error(`update-user answered HTTP ${res.status}`);
    },
    async setPanels(channel, panels) {
      await c.setPanels({ channel, panels });
    },
    async setSocials(channel, socials) {
      await c.update({ channel, socials });
    },
  };
}

/** What the database already has (a resumed or repeated step skips these). */
export interface IdentityExisting {
  /** Channels whose theme has an avatar, by owner handle. */
  avatars: ReadonlySet<string>;
  /** Users with a profile image. */
  profileImages: ReadonlySet<string>;
  banners: ReadonlySet<string>;
  /** Channels already showing this step's panels (links under `PANEL_LINK_ORIGIN`). */
  panels: ReadonlySet<string>;
  /** Channels with any social link already. */
  socials: ReadonlySet<string>;
}

/** Reads `IdentityExisting` for the planned accounts (by username). */
export async function readIdentityExisting(
  db: DbHandle,
  accounts: readonly { handle: string; username: string }[],
): Promise<IdentityExisting> {
  const handleOf = new Map(accounts.map((a) => [a.username, a.handle]));
  const rows = await db.sql<
    { username: string; avatar: boolean; image: boolean; banner: boolean; panels: boolean; socials: boolean }[]
  >`
    select u.username,
           c.theme ->> 'avatarKey' is not null as avatar,
           u.image is not null as image,
           c.theme ->> 'bannerKey' is not null as banner,
           exists (select 1 from channel_panels p
                    where p.channel_id = c.id and p.link_url like ${`${PANEL_LINK_ORIGIN}/%`}) as panels,
           jsonb_array_length(c.socials) > 0 as socials
      from users u join channels c on c.owner_id = u.id
     where u.username = any(${[...handleOf.keys()]}::text[])`;
  const set = (pick: (r: (typeof rows)[number]) => boolean) =>
    new Set(rows.filter(pick).flatMap((r) => handleOf.get(r.username) ?? []));
  return {
    avatars: set((r) => r.avatar),
    profileImages: set((r) => r.image),
    banners: set((r) => r.banner),
    panels: set((r) => r.panels),
    socials: set((r) => r.socials),
  };
}

export interface IdentityInput {
  plan: IdentityPlan;
  /** Owner handle → channel slug. */
  slugOf: (handle: string) => string;
  /** Owner handle → user id (the art's salt). */
  idOf: (handle: string) => string;
  clientFor: (handle: string) => Promise<IdentityClient>;
  existing: IdentityExisting;
  /** The unit's identity PRNG; each piece forks it by salt, so order and concurrency never matter. */
  rng: Rng;
  signal: AbortSignal;
  concurrency?: number;
}

export interface IdentityResult {
  avatars: number;
  profileImages: number;
  banners: number;
  panels: number;
  panelImages: number;
  /** Social links set (summed over channels). */
  socials: number;
  /** Already there, so not uploaded again. */
  skipped: number;
}

const art = (rng: Rng, salt: string, format: ArtFormat) => artPng(artScene(artRng(rng, salt), format));

/** Runs `fn` over `items`, at most `n` at once; the first failure stops the rest. */
export async function inPool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (failed !== null) throw failed;
}

/** Uploads the plan's art through the API, skipping what exists. */
export async function seedIdentity(i: IdentityInput): Promise<IdentityResult> {
  const out: IdentityResult = {
    avatars: 0,
    profileImages: 0,
    banners: 0,
    panels: 0,
    panelImages: 0,
    socials: 0,
    skipped: 0,
  };
  const step = async <T>(who: string, what: string, f: () => Promise<T>): Promise<T> => {
    i.signal.throwIfAborted();
    try {
      return await f();
    } catch (err) {
      throw new Error(`seed-social: ${what} for ${who} failed: ${String(err)}`);
    }
  };
  /** Merge into the theme as the server has it now, as the appearance card does. */
  const setThemeKey = async (c: IdentityClient, channel: string, key: "avatarKey" | "bannerKey", value: string) =>
    c.setTheme(channel, { ...(await c.theme(channel)), [key]: value });

  await inPool(i.plan.avatars, i.concurrency ?? IDENTITY_CONCURRENCY, async (handle) => {
    const hasAvatar = i.existing.avatars.has(handle);
    if (hasAvatar && i.existing.profileImages.has(handle)) {
      out.skipped++;
      return;
    }
    const c = await step(handle, "sign-in", () => i.clientFor(handle));
    const channel = i.slugOf(handle);
    let key: string;
    if (hasAvatar) {
      // The channel has one (an interrupted earlier attempt): reuse it as the profile image.
      const current = (await step(handle, "read the theme", () => c.theme(channel))).avatarKey;
      if (!current) throw new Error(`seed-social: ${handle}'s avatar vanished between the check and the update`);
      key = current;
      out.skipped++;
    } else {
      const png = art(i.rng, i.idOf(handle), "avatar");
      key = await step(handle, "avatar upload", () => c.upload(channel, "avatar", png));
      await step(handle, "set the avatar", () => setThemeKey(c, channel, "avatarKey", key));
      out.avatars++;
    }
    if (!i.existing.profileImages.has(handle)) {
      await step(handle, "set the profile image", () => c.setProfileImage(key));
      out.profileImages++;
    }
  });

  for (const handle of i.plan.banners) {
    if (i.existing.banners.has(handle)) {
      out.skipped++;
      continue;
    }
    const c = await step(handle, "sign-in", () => i.clientFor(handle));
    const channel = i.slugOf(handle);
    const png = art(i.rng, `${i.idOf(handle)}:banner`, "banner");
    const key = await step(handle, "banner upload", () => c.upload(channel, "banner", png));
    await step(handle, "set the banner", () => setThemeKey(c, channel, "bannerKey", key));
    out.banners++;
  }

  for (const { handle, panels } of i.plan.panels) {
    if (i.existing.panels.has(handle)) {
      out.skipped++;
      continue;
    }
    const c = await step(handle, "sign-in", () => i.clientFor(handle));
    const channel = i.slugOf(handle);
    const rows: { title: string; body: string; imageKey: string | null; linkUrl: string | null }[] = [];
    for (const [n, p] of panels.entries()) {
      let imageKey: string | null = null;
      if (p.image) {
        const png = art(i.rng, `${i.idOf(handle)}:panel:${n}`, "panel");
        imageKey = await step(handle, `panel ${n + 1} image upload`, () => c.upload(channel, "panel", png));
        out.panelImages++;
      }
      rows.push({ title: p.title, body: p.body, imageKey, linkUrl: p.linkUrl });
    }
    await step(handle, "set the panels", () => c.setPanels(channel, rows));
    out.panels += rows.length;
  }

  for (const { handle, socials } of i.plan.socials) {
    if (i.existing.socials.has(handle)) {
      out.skipped++;
      continue;
    }
    const c = await step(handle, "sign-in", () => i.clientFor(handle));
    await step(handle, "set the social links", () => c.setSocials(i.slugOf(handle), socials));
    out.socials += socials.length;
  }
  return out;
}
