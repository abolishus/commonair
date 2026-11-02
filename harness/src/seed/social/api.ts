// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's API steps, signed in as the seeded owners: channel emotes through the upload
 * pipeline (so the images exist in the media bucket), and the batch 7 portability rows (move links,
 * follows through a link, "tell me if they move" grants, one channel's moved notice). These write
 * their own `events` and `audit_log` rows, as any client's calls would. Each user signs in once.
 */
import { encodePng } from "../../png.ts";
import { putPresigned } from "../../safety-io.ts";
import { type SignedInUser, UserFactory } from "../../users.ts";
import { seedApiFactory } from "../clients.ts";
import type { HarnessEnv } from "../../env.ts";
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import type { AccountSpec, SocialPlan } from "./plan.ts";
import type { EmoteDef } from "./write.ts";

/** Lifetime of the link created to show the "expired" state (it lapses while the seed runs on). */
const EXPIRING_LINK_MS = 30_000;
export const EMOTE_PNG_SIZE = 64;

/** Who the API steps act as: a signed-in client per seeded handle. */
export interface SessionSource {
  as(handle: string): Promise<Pick<SignedInUser, "api">>;
}

/** Signs each seeded account in once and keeps the session. */
export class SeedSessions implements SessionSource {
  private readonly cache = new Map<string, Promise<SignedInUser>>();
  private readonly factory: UserFactory;

  constructor(
    env: HarnessEnv,
    private readonly password: string,
    private readonly accounts: ReadonlyMap<string, AccountSpec>,
  ) {
    this.factory = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: DEMO_FIXTURES.emailDomain,
      apiFactory: seedApiFactory(env, "social"),
    });
  }

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      const a = this.accounts.get(handle);
      if (!a) throw new Error(`seed-social: no planned account "${handle}" to sign in`);
      p = this.factory
        .signIn({
          username: a.username,
          displayName: a.displayName,
          email: a.email,
          password: this.password,
          birthDate: a.birthDate ?? "",
        })
        .catch((err: unknown) => {
          throw new Error(`seed-social: sign-in as ${handle} failed: ${String(err)}`);
        });
      this.cache.set(handle, p);
    }
    return p;
  }

  get signedIn(): number {
    return this.cache.size;
  }
}

/** 32-bit FNV-1a of `s`, for a stable per-emote colour. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small synthetic emote image: a coloured disc with a ring, unique per code. Pure. */
export function emotePng(code: string, size = EMOTE_PNG_SIZE): Uint8Array {
  const h = hash(code);
  const fg = [(h & 0xff) | 0x40, ((h >>> 8) & 0xff) | 0x40, ((h >>> 16) & 0xff) | 0x40];
  const ring = [255 - (fg[0] ?? 0), 255 - (fg[1] ?? 0), 255 - (fg[2] ?? 0)];
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const px = d > 1 ? null : d > 0.8 ? ring : fg;
      const o = (y * size + x) * 4;
      if (!px) continue;
      data.set([px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, 255], o);
    }
  return encodePng({ width: size, height: size, data });
}

/** Upload and create every planned emote; returns owner handle → code → emote. */
export async function createEmotes(
  sessions: SessionSource,
  plan: SocialPlan,
  signal: AbortSignal,
): Promise<Map<string, Map<string, EmoteDef>>> {
  const out = new Map<string, Map<string, EmoteDef>>();
  for (const owner of plan.api.emoteChannels) {
    const c = plan.channels.find((x) => x.ownerHandle === owner);
    if (!c) continue;
    const u = await sessions.as(owner);
    const mine = new Map<string, EmoteDef>();
    for (const e of c.emotes) {
      signal.throwIfAborted();
      try {
        const png = emotePng(e.code);
        const up = await u.api.client.channels.uploadUrl({
          channel: c.slug,
          purpose: "emote",
          contentType: "image/png",
          sizeBytes: png.byteLength,
        });
        await putPresigned(up.uploadUrl, up.headers, png, signal);
        const committed = await u.api.client.channels.commitUpload({ channel: c.slug, key: up.key });
        const created = await u.api.client.chat.emotes.create({
          channel: c.slug,
          code: e.code,
          imageKey: committed.key,
          tier: e.tier,
        });
        mine.set(e.code, { id: created.id, code: created.code, tier: created.tier });
      } catch (err) {
        throw new Error(`seed-social: emote ${e.code} for ${owner} failed: ${String(err)}`);
      }
    }
    out.set(owner, mine);
  }
  return out;
}

export interface PortabilityResult {
  rows: Record<string, number>;
  /** The active link's nonce (`/m/<slug>/<nonce>`). */
  moveLinkNonce: string;
}

/** streamer1's move links, follows through the active one, grants, and the moved bulk channel. */
export async function seedPortability(
  sessions: SessionSource,
  plan: SocialPlan,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<PortabilityResult> {
  const s1 = plan.channels.find((c) => c.ownerHandle === "streamer1");
  if (!s1) throw new Error("seed-social: streamer1 has no planned channel");
  const channel = s1.slug;
  const step = async <T>(who: string, what: string, f: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    try {
      return await f();
    } catch (err) {
      throw new Error(`seed-social: ${what} as ${who} failed: ${String(err)}`);
    }
  };
  const owner = await sessions.as("streamer1");
  const links = owner.api.client.portability.links;
  // Expired: created with a short expiry that passes while the seed carries on.
  await step("streamer1", "create the expiring move link", () =>
    links.create({ channel, expiresAt: new Date(now() + EXPIRING_LINK_MS).toISOString() }),
  );
  const revoked = await step("streamer1", "create the move link to revoke", () =>
    links.create({ channel, expiresAt: null }),
  );
  await step("streamer1", "revoke a move link", () => links.revoke({ channel, id: revoked.id }));
  const active = await step("streamer1", "create the active move link", () =>
    links.create({ channel, expiresAt: null }),
  );
  let follows = 0;
  for (const h of plan.api.moveLinkFollowers) {
    const u = await sessions.as(h);
    await step(h, "follow streamer1 through the move link", () =>
      u.api.client.channels.follow({ channel, notify: true, moveLink: { nonce: active.nonce } }),
    );
    follows++;
  }
  let grants = 0;
  for (const h of plan.api.grantHolders) {
    const u = await sessions.as(h);
    await step(h, "ask to be told if streamer1 moves", () =>
      u.api.client.portability.grants.set({ channel, enabled: true }),
    );
    grants++;
  }
  const movedHandle = plan.api.movedStreamer;
  const movedTo = plan.api.movedTo;
  if (movedHandle && movedTo) {
    const c = plan.channels.find((x) => x.ownerHandle === movedHandle);
    if (!c) throw new Error(`seed-social: moved streamer ${movedHandle} has no planned channel`);
    const u = await sessions.as(movedHandle);
    await step(movedHandle, "set moved to", () => u.api.client.portability.move.set({ channel: c.slug, movedTo }));
  }
  return {
    rows: { move_links: 3, follows, follow_portability_grants: grants },
    moveLinkNonce: active.nonce,
  };
}
