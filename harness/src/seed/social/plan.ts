// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's plan: every account, channel, follow, block, ban, session, consent, chat window and
 * API step, as specs keyed by handle. Pure and deterministic for a given PRNG, scale and `now`; ids
 * and secrets (session tokens, key material) are minted by the writers, never here. Chat lines are
 * generated lazily per window (`chatLines`) so the large preset never holds 2 M lines in memory.
 */
import { demoIdentity } from "@commonair/db/demo";
import { BOT_OWNER, FIXED_ACCOUNTS, type PlatformRole, bulkStreamerHandle, bulkViewerHandle } from "../accounts.ts";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeedAccountKind, SeededChannel, SeededUser } from "../types.ts";
import {
  BAN_REASONS,
  CATEGORIES,
  CHAT_ACTIONS,
  CHAT_MENTIONS,
  CHAT_PLAIN,
  CHAT_REPLIES,
  DESCRIPTIONS,
  EMOTE_SUFFIXES,
  FIXED_STREAMER_CHANNELS,
  MOVED_TO_HOST,
  NAME_ADJECTIVES,
  NAME_NOUNS,
  OWNER_LINES,
  PANELS,
  PASSKEY_NAMES,
  SEED_LINK_HOST,
  TAGS,
  TIER_BENEFITS,
  TIER_NAMES,
  TIER_PRICES_CENTS,
  TITLE_TEMPLATES,
  TRIP_LINES,
  USED_CATEGORIES,
  USER_AGENTS,
  WORD_FILTERS,
} from "./content.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Chat is only written into windows newer than this: the worker deletes chat with no live VOD after
 * `CHAT_RETENTION_DAYS` (default 30), and seed-media's backdated broadcasts have no VOD.
 */
export const CHAT_HORIZON_DAYS = 28;
/** The oldest accounts must clear `payout.rules.splitRecipientMinAccountAgeDays` (30, seed-money). */
export const ACCOUNT_AGE_GATE_DAYS = 30;
/** Share of bulk accounts at least `ACCOUNT_AGE_GATE_DAYS + 1` days old. */
export const AGED_BULK_SHARE = 0.8;
/** Better-auth's session lifetime in services/api (`session.expiresIn`). */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** `chat.bans.ban`'s longest timeout (1 209 600 s, 14 days). */
export const MAX_TIMEOUT_SECONDS = 1_209_600;

export const LOCALES = ["en", "es", "en-XA"] as const;
export type SeedLocale = (typeof LOCALES)[number];
/** Bulk locale weights (fixed logins are always `en`). */
const LOCALE_WEIGHTS: Readonly<Record<SeedLocale, number>> = { en: 0.6, es: 0.25, "en-XA": 0.15 };

/** Fixed streamers in follower and chat rank order; streamer3 is the new channel and stays small. */
const RANKED_FIXED_STREAMERS = ["streamer1", "streamer2", "council1", "council2"] as const;
const NEW_STREAMER = "streamer3";
const CHAT_WEIGHTS: Readonly<Record<string, number>> = { streamer1: 10, streamer2: 6, council1: 4, council2: 3 };
/** streamer3's followers (viewer1 plus bulk viewers): "few followers". */
export const NEW_STREAMER_FOLLOWERS = 3;

export interface AccountSpec {
  handle: string;
  username: string;
  email: string;
  displayName: string;
  kind: SeedAccountKind;
  platformRole: PlatformRole;
  streamer: boolean;
  createdAt: Date;
  /** Null for the bot (bots never choose a language). */
  locale: SeedLocale | null;
  /** ISO date; null for the bot. */
  birthDate: string | null;
  adult: boolean;
  matureConfirmedAt: Date | null;
  shareEmail: boolean;
  botOwner: string | null;
}

export interface PanelSpec {
  title: string;
  body: string;
  linkUrl: string | null;
}

export interface TierSpec {
  tier: 1 | 2 | 3;
  name: string;
  priceCents: number;
  benefits: string;
}

export interface WordFilterSpec {
  pattern: string;
  isRegex: boolean;
  action: "block" | "hold" | "replace";
  replacement: string | null;
}

export interface EmoteSpec {
  code: string;
  tier: number;
}

export interface ChannelSpec {
  ownerHandle: string;
  slug: string;
  displayName: string;
  /** False for the bare channel every human account gets at signup (`ensureChannel`). */
  streamer: boolean;
  title: string;
  description: string;
  category: string | null;
  tags: string[];
  language: string;
  createdAt: Date;
  panels: PanelSpec[];
  tiers: TierSpec[];
  wordFilters: WordFilterSpec[];
  /** Created through the API (the upload pipeline puts the image in the media bucket). */
  emotes: EmoteSpec[];
}

export interface RoleSpec {
  channel: string;
  user: string;
  role: "moderator" | "vip" | "editor";
  grantedBy: string;
}

export interface FollowSpec {
  follower: string;
  channel: string;
  createdAt: Date;
  notify: boolean;
}

export interface BlockSpec {
  user: string;
  blocked: string;
  createdAt: Date;
}

export interface BanSpec {
  channel: string;
  target: string;
  moderator: string;
  /** Null: a permanent ban. */
  durationSeconds: number | null;
  reason: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface SessionSpec {
  user: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string;
}

export interface PasskeySpec {
  user: string;
  name: string;
  createdAt: Date;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports: string;
}

export interface ConsentSpec {
  /** Null: a signed-out visitor (the writer mints the cookie id). */
  user: string | null;
  preferences: boolean;
  createdAt: Date;
}

export interface ChatWindowSpec {
  index: number;
  /** Channel owner handle. */
  channel: string;
  start: Date;
  end: Date;
  /** Lines written into this window (0 for windows older than `CHAT_HORIZON_DAYS`). */
  lines: number;
  /** Filter-tripping lines among `lines` (streamer1's newest window only). */
  trips: ("replace" | "hold")[];
}

export interface SocialApiPlan {
  /** Owners whose channel emotes go through the upload pipeline. */
  emoteChannels: string[];
  /** Bulk viewers that follow streamer1 through its active move link. */
  moveLinkFollowers: string[];
  /** Viewers (following streamer1) who ask to be told if it moves. */
  grantHolders: string[];
  /** The one bulk streamer whose channel says it moved; null without bulk streamers. */
  movedStreamer: string | null;
  movedTo: string | null;
}

export interface SocialPlan {
  now: Date;
  accounts: AccountSpec[];
  categories: { slug: string; name: string; mature: boolean }[];
  channels: ChannelSpec[];
  roles: RoleSpec[];
  follows: FollowSpec[];
  blocks: BlockSpec[];
  bans: BanSpec[];
  sessions: SessionSpec[];
  twoFactors: string[];
  passkeys: PasskeySpec[];
  consents: ConsentSpec[];
  chatWindows: ChatWindowSpec[];
  api: SocialApiPlan;
}

const at = (ms: number) => new Date(Math.round(ms));
const between = (rng: Rng, lo: number, hi: number) => (hi <= lo ? lo : lo + rng.next() * (hi - lo));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Largest-remainder apportionment: non-negative integers proportional to `weights`, summing to `total`. Pure. */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (Math.max(0, w) / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return out;
}

function pickLocale(rng: Rng): SeedLocale {
  const r = rng.next();
  let acc = 0;
  for (const l of LOCALES) {
    acc += LOCALE_WEIGHTS[l];
    if (r < acc) return l;
  }
  return "en";
}

function birthDate(rng: Rng, now: Date, adult: boolean): string {
  const years = adult ? rng.int(19, 55) : rng.int(14, 17);
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - rng.int(1, 300));
  return isoDate(d);
}

const displayName = (rng: Rng) => `${rng.pick(NAME_ADJECTIVES)} ${rng.pick(NAME_NOUNS)}`;

function planAccounts(rng: Rng, scale: SeedScale, now: Date): AccountSpec[] {
  const t = now.getTime();
  const oldest = t - scale.historyDays * DAY_MS;
  const out: AccountSpec[] = [];
  const base = (handle: string) => ({ handle, ...demoIdentity(handle) });

  FIXED_ACCOUNTS.forEach((a, i) => {
    if (a.bot) return;
    const r = rng.fork(`account:${a.handle}`);
    out.push({
      ...base(a.handle),
      displayName: a.displayName,
      kind: "fixed",
      platformRole: a.platformRole,
      streamer: a.streamer,
      // Exactly `historyDays` old (minutes apart, in list order), so every age gate passes.
      createdAt: at(oldest - (FIXED_ACCOUNTS.length - i) * MINUTE_MS),
      locale: "en",
      birthDate: birthDate(r, now, true),
      adult: true,
      matureConfirmedAt: a.handle === "viewer1" || a.handle === "streamer1" ? at(oldest + DAY_MS) : null,
      shareEmail: a.handle === "viewer1",
      botOwner: null,
    });
  });

  const bulk: { handle: string; streamer: boolean }[] = [
    ...Array.from({ length: scale.streamers }, (_, i) => ({ handle: bulkStreamerHandle(i + 1), streamer: true })),
    ...Array.from({ length: scale.viewers }, (_, i) => ({ handle: bulkViewerHandle(i + 1), streamer: false })),
  ];
  // Exactly half the bulk accounts are adults (the age attestation the jury and mature gate read).
  const adultSet = new Set(
    rng.fork("adults").sample(
      bulk.map((b) => b.handle),
      Math.ceil(bulk.length / 2),
    ),
  );
  const agedSet = new Set(
    rng.fork("aged").sample(
      bulk.map((b) => b.handle),
      Math.ceil(bulk.length * AGED_BULK_SHARE),
    ),
  );
  const agedTo = t - (ACCOUNT_AGE_GATE_DAYS + 1) * DAY_MS;
  for (const b of bulk) {
    const r = rng.fork(`account:${b.handle}`);
    const adult = adultSet.has(b.handle);
    const aged = agedSet.has(b.handle) && agedTo > oldest;
    const createdAt = aged ? between(r, oldest, agedTo) : between(r, Math.max(oldest, t - 30 * DAY_MS), t - 3 * DAY_MS);
    out.push({
      ...base(b.handle),
      displayName: displayName(r),
      kind: b.streamer ? "bulk-streamer" : "bulk-viewer",
      platformRole: "user",
      streamer: b.streamer,
      createdAt: at(createdAt),
      locale: pickLocale(r),
      birthDate: birthDate(r, now, adult),
      adult,
      matureConfirmedAt: adult && r.chance(0.3) ? at(between(r, createdAt, t - HOUR_MS)) : null,
      shareEmail: r.chance(0.2),
      botOwner: null,
    });
  }

  for (const a of FIXED_ACCOUNTS.filter((x) => x.bot)) {
    const owner = out.find((o) => o.handle === BOT_OWNER);
    if (!owner) throw new Error(`seed-social: bot owner ${BOT_OWNER} is not a fixed account`);
    out.push({
      ...base(a.handle),
      displayName: a.displayName,
      kind: "bot",
      platformRole: a.platformRole,
      streamer: false,
      createdAt: at(owner.createdAt.getTime() + DAY_MS),
      locale: null,
      birthDate: null,
      adult: false,
      matureConfirmedAt: null,
      shareEmail: false,
      botOwner: BOT_OWNER,
    });
  }
  return out;
}

function planChannels(rng: Rng, accounts: readonly AccountSpec[]): ChannelSpec[] {
  const used = CATEGORIES.slice(0, USED_CATEGORIES);
  return accounts
    .filter((a) => a.kind !== "bot")
    .map((a): ChannelSpec => {
      const bare: ChannelSpec = {
        ownerHandle: a.handle,
        slug: a.username,
        displayName: a.displayName.slice(0, 40),
        streamer: false,
        title: "",
        description: "",
        category: null,
        tags: [],
        language: "en",
        createdAt: a.createdAt,
        panels: [],
        tiers: [],
        wordFilters: [],
        emotes: [],
      };
      if (!a.streamer) return bare;
      const r = rng.fork(`channel:${a.handle}`);
      const fixed = FIXED_STREAMER_CHANNELS[a.handle];
      const tiers = TIER_NAMES.map((name, i) => ({
        tier: (i + 1) as 1 | 2 | 3,
        name,
        priceCents: TIER_PRICES_CENTS[i] ?? TIER_PRICES_CENTS[0],
        benefits: TIER_BENEFITS[i] ?? "",
      }));
      const panelCount =
        a.handle === "streamer1" ? PANELS.length : a.handle === NEW_STREAMER ? 0 : fixed ? 3 : r.int(0, 2);
      const panels = PANELS.slice(0, panelCount).map((p, i) => ({
        title: p.title,
        body: p.body,
        linkUrl: p.link ? `https://${SEED_LINK_HOST}/${a.username}/${i + 1}` : null,
      }));
      const cat = fixed ? fixed.category : r.pick(used).slug;
      const catName = CATEGORIES.find((c) => c.slug === cat)?.name ?? cat;
      const title = fixed
        ? fixed.title
        : r
            .pick(TITLE_TEMPLATES)
            .replace("{cat}", catName)
            .replace("{n}", String(r.int(2, 300)));
      const emotes = fixed
        ? EMOTE_SUFFIXES.slice(
            0,
            a.handle === NEW_STREAMER ? 1 : a.handle === "streamer1" ? EMOTE_SUFFIXES.length : 4,
          ).map((e) => ({ code: `${fixed.emotePrefix}${e.suffix}`, tier: e.tier }))
        : [];
      const wordFilters: WordFilterSpec[] =
        a.handle === "streamer1"
          ? [{ ...WORD_FILTERS.block }, { ...WORD_FILTERS.replace }, { ...WORD_FILTERS.hold }]
          : a.handle === "streamer2"
            ? [{ ...WORD_FILTERS.block }]
            : [];
      return {
        ...bare,
        streamer: true,
        title,
        description: fixed ? fixed.description : r.pick(DESCRIPTIONS),
        category: cat,
        tags: fixed ? [...fixed.tags] : r.sample(TAGS, r.int(1, 3)),
        language: a.locale === "es" ? "es" : "en",
        panels,
        tiers,
        wordFilters,
        emotes,
      };
    });
}

/** Streamer channels in rank order: the fixed streamers by size, then bulk; streamer3 last. */
export function rankedStreamers(accounts: readonly AccountSpec[]): string[] {
  const bulk = accounts.filter((a) => a.kind === "bulk-streamer").map((a) => a.handle);
  const fixed = RANKED_FIXED_STREAMERS.filter((h) => accounts.some((a) => a.handle === h));
  return [...fixed, ...bulk, ...(accounts.some((a) => a.handle === NEW_STREAMER) ? [NEW_STREAMER] : [])];
}

/** The follow probability of the channel at `rank` (1-based): a power law. */
export const followProbability = (rank: number) => Math.min(0.95, 0.9 * rank ** -0.75);

function planFollows(
  rng: Rng,
  accounts: readonly AccountSpec[],
  channels: readonly ChannelSpec[],
  now: Date,
  excludedFromStreamer1: ReadonlySet<string>,
): FollowSpec[] {
  const byHandle = new Map(accounts.map((a) => [a.handle, a]));
  const channelOf = new Map(channels.map((c) => [c.ownerHandle, c]));
  // newbie keeps its empty states; bots never follow.
  const followers = accounts.filter((a) => a.kind !== "bot" && a.handle !== "newbie");
  const out: FollowSpec[] = [];
  const hi = now.getTime() - HOUR_MS;
  const push = (r: Rng, follower: AccountSpec, owner: string) => {
    const c = channelOf.get(owner);
    if (!c) return;
    const lo = Math.max(follower.createdAt.getTime(), c.createdAt.getTime()) + HOUR_MS;
    out.push({ follower: follower.handle, channel: owner, createdAt: at(between(r, lo, hi)), notify: r.chance(0.85) });
  };
  for (const [i, owner] of rankedStreamers(accounts).entries()) {
    const r = rng.fork(`follows:${owner}`);
    if (owner === NEW_STREAMER) {
      const viewer1 = byHandle.get("viewer1");
      if (viewer1) push(r, viewer1, owner);
      const bulk = followers.filter((f) => f.kind === "bulk-viewer");
      for (const f of r.sample(bulk, NEW_STREAMER_FOLLOWERS - (viewer1 ? 1 : 0))) push(r, f, owner);
      continue;
    }
    const p = followProbability(i + 1);
    for (const f of followers) {
      if (f.handle === owner) continue;
      if (owner === "streamer1" && excludedFromStreamer1.has(f.handle)) continue;
      // viewer1 is the heavy viewer: every fixed channel and most bulk ones.
      const follows =
        f.handle === "viewer1" ? (byHandle.get(owner)?.kind === "fixed" ? true : r.chance(0.6)) : r.chance(p);
      if (follows) push(r, f, owner);
    }
  }
  return out;
}

/** A span in which a user may not chat in a channel (`to` null: permanent). */
interface BanSpan {
  target: string;
  from: number;
  to: number | null;
}

/** Owner and role holders first, then followers: who talks in a channel. */
interface ChatPools {
  /** Owner handle → chatters (owner, roles, followers), deduplicated. */
  chatters: Map<string, string[]>;
  /**
   * Owner handle → chatter → the earliest time (ms) they may talk there: the account's creation for
   * the owner and role holders, the follow for followers.
   */
  since: Map<string, Map<string, number>>;
  /** Owner handle → chat bans and timeouts on that channel. */
  bans: Map<string, BanSpan[]>;
  /** Owner handle → chatters the word filters apply to (not the owner, moderators or VIPs). */
  filtered: Map<string, string[]>;
  usernames: Map<string, string>;
  /** Owner handle → emote codes usable by everyone, and all codes (the broadcaster). */
  freeEmotes: Map<string, string[]>;
  allEmotes: Map<string, string[]>;
}

export function chatPools(plan: Pick<SocialPlan, "accounts" | "channels" | "roles" | "follows" | "bans">): ChatPools {
  const quiet = new Set(plan.accounts.filter((a) => a.kind === "bot" || a.handle === "newbie").map((a) => a.handle));
  const createdOf = new Map(plan.accounts.map((a) => [a.handle, a.createdAt.getTime()]));
  const chatters = new Map<string, string[]>();
  const since = new Map<string, Map<string, number>>();
  const filtered = new Map<string, string[]>();
  const privileged = new Map<string, Set<string>>();
  const add = (owner: string, h: string, from: number) => {
    const list = chatters.get(owner);
    const s = since.get(owner);
    if (!list || !s || s.has(h) || quiet.has(h)) return;
    list.push(h);
    s.set(h, from);
  };
  for (const c of plan.channels.filter((x) => x.streamer)) {
    chatters.set(c.ownerHandle, []);
    since.set(c.ownerHandle, new Map());
    add(c.ownerHandle, c.ownerHandle, c.createdAt.getTime());
    privileged.set(c.ownerHandle, new Set([c.ownerHandle]));
  }
  // A role holder who also follows talks from the follow on, like any follower.
  const followedAt = new Map(plan.follows.map((f) => [`${f.channel}\0${f.follower}`, f.createdAt.getTime()]));
  for (const r of plan.roles) {
    add(
      r.channel,
      r.user,
      followedAt.get(`${r.channel}\0${r.user}`) ?? createdOf.get(r.user) ?? Number.POSITIVE_INFINITY,
    );
    if (r.role !== "editor") privileged.get(r.channel)?.add(r.user);
  }
  for (const f of plan.follows) add(f.channel, f.follower, f.createdAt.getTime());
  const bans = new Map<string, BanSpan[]>();
  for (const b of plan.bans) {
    const list = bans.get(b.channel) ?? [];
    list.push({ target: b.target, from: b.createdAt.getTime(), to: b.expiresAt?.getTime() ?? null });
    bans.set(b.channel, list);
  }
  for (const [owner, list] of chatters)
    filtered.set(
      owner,
      list.filter((h) => !privileged.get(owner)?.has(h)),
    );
  const freeEmotes = new Map<string, string[]>();
  const allEmotes = new Map<string, string[]>();
  for (const c of plan.channels) {
    freeEmotes.set(
      c.ownerHandle,
      c.emotes.filter((e) => e.tier === 0).map((e) => e.code),
    );
    allEmotes.set(
      c.ownerHandle,
      c.emotes.map((e) => e.code),
    );
  }
  return {
    chatters,
    since,
    bans,
    filtered,
    usernames: new Map(plan.accounts.map((a) => [a.handle, a.username])),
    freeEmotes,
    allEmotes,
  };
}

function planChatWindows(
  rng: Rng,
  scale: SeedScale,
  now: Date,
  accounts: readonly AccountSpec[],
  channels: readonly ChannelSpec[],
): ChatWindowSpec[] {
  const t = now.getTime();
  const horizon = t - CHAT_HORIZON_DAYS * DAY_MS;
  const created = new Map(channels.map((c) => [c.ownerHandle, c.createdAt.getTime()]));
  const kindOf = new Map(accounts.map((a) => [a.handle, a.kind]));
  const windows: Omit<ChatWindowSpec, "index">[] = [];
  const weights = new Map<string, number>();
  let bulkRank = 0;
  for (const owner of rankedStreamers(accounts)) {
    // streamer3's first broadcast is seed-media's real recording: no history before it.
    if (owner === NEW_STREAMER) continue;
    const r = rng.fork(`windows:${owner}`);
    const fixed = kindOf.get(owner) === "fixed";
    const lo = (created.get(owner) ?? t - scale.historyDays * DAY_MS) + DAY_MS;
    const maxOffset = Math.max(1, Math.floor((t - lo) / DAY_MS));
    const want = fixed
      ? Math.max(4, Math.round(scale.historyDays / 3))
      : Math.max(1, Math.round(scale.historyDays / 12));
    const offsets = new Set<number>();
    // The newest window is always inside the chat horizon, so every channel has recent chat.
    offsets.add(r.int(1, Math.min(maxOffset, CHAT_HORIZON_DAYS - 1)));
    const pool = Array.from({ length: maxOffset }, (_, i) => i + 1).filter((d) => !offsets.has(d));
    for (const d of r.sample(pool, want - 1)) offsets.add(d);
    for (const d of [...offsets].sort((a, b) => b - a)) {
      const end = t - d * DAY_MS - r.int(0, 6 * 60) * MINUTE_MS;
      const start = end - r.int(60, 240) * MINUTE_MS;
      windows.push({ channel: owner, start: at(start), end: at(end), lines: 0, trips: [] });
    }
    weights.set(owner, fixed ? (CHAT_WEIGHTS[owner] ?? 1) : 2 / (++bulkRank) ** 0.6);
  }
  const owners = [...weights.keys()];
  const perChannel = apportion(
    scale.chatLines,
    owners.map((o) => weights.get(o) ?? 0),
  );
  owners.forEach((owner, i) => {
    const mine = windows.filter((w) => w.channel === owner && w.start.getTime() > horizon);
    const split = apportion(
      perChannel[i] ?? 0,
      mine.map((w) => w.end.getTime() - w.start.getTime()),
    );
    mine.forEach((w, j) => {
      w.lines = split[j] ?? 0;
    });
  });
  // streamer1's newest window carries the filter trips (two replaced, two held), within its count.
  const s1 = windows
    .filter((w) => w.channel === "streamer1" && w.lines > 0)
    .sort((a, b) => b.end.getTime() - a.end.getTime())[0];
  if (s1) {
    const kinds: ("replace" | "hold")[] = ["replace", "hold", "replace", "hold"];
    s1.trips = kinds.slice(0, Math.min(kinds.length, s1.lines));
  }
  windows.sort((a, b) => a.start.getTime() - b.start.getTime() || a.channel.localeCompare(b.channel));
  return windows.map((w, index) => ({ ...w, index }));
}

export interface ChatLineSpec {
  author: string;
  body: string;
  isAction: boolean;
  /** Index of an earlier line in the same window. */
  replyTo: number | null;
  createdAt: Date;
  /** Held by a word filter (`held_at` = `created_at`), as chat records a hold. */
  held: boolean;
}

/**
 * The lines of one window, in time order. Deterministic per (plan seed, window index): each window
 * has its own PRNG stream. Authors are skewed toward the front of the chatter pool (owner, roles,
 * early followers). Trip lines sit at even positions and are stored as chat would store them:
 * replaced text, or held.
 */
export function* chatLines(rng: Rng, w: ChatWindowSpec, pools: ChatPools): Generator<ChatLineSpec> {
  if (w.lines <= 0) return;
  const r = rng.fork(`chat:${w.index}`);
  // Per window, not per line: whoever existed (and followed) by its start and has no ban touching
  // it. Lines all fall inside the window, so every line is then valid for its author.
  const start = w.start.getTime();
  const end = w.end.getTime();
  const since = pools.since.get(w.channel);
  const bans = pools.bans.get(w.channel) ?? [];
  const barred = new Set(bans.filter((b) => b.from <= end && (b.to === null || b.to > start)).map((b) => b.target));
  const eligible = (h: string) => (since?.get(h) ?? Number.POSITIVE_INFINITY) <= start && !barred.has(h);
  const pool = (pools.chatters.get(w.channel) ?? []).filter(eligible);
  const chatters = pool.length > 0 ? pool : [w.channel];
  const filtered = (pools.filtered.get(w.channel) ?? []).filter(eligible);
  const free = pools.freeEmotes.get(w.channel) ?? [];
  const all = pools.allEmotes.get(w.channel) ?? [];
  const nameOf = (h: string) => pools.usernames.get(h) ?? h;
  const tripAt = new Map<number, "replace" | "hold">();
  w.trips.forEach((k, i) => tripAt.set(Math.floor(((i + 1) * w.lines) / (w.trips.length + 1)), k));
  const span = Math.max(1, w.end.getTime() - w.start.getTime() - 2 * MINUTE_MS);
  const times = Array.from({ length: w.lines }, () => r.next())
    .sort((a, b) => a - b)
    .map((u) => at(w.start.getTime() + MINUTE_MS + u * span));
  const authors: string[] = [];
  for (let i = 0; i < w.lines; i++) {
    const createdAt = times[i] ?? w.start;
    const trip = tripAt.get(i);
    if (trip && filtered.length > 0) {
      const author = r.pick(filtered);
      authors.push(author);
      const text = r.pick(TRIP_LINES[trip]);
      // Replace filters rewrite the stored body; holds keep it and set held_at.
      const body = trip === "replace" ? text.replace(/frick/giu, "fr*ck") : text;
      yield { author, body, isAction: false, replyTo: null, createdAt, held: trip === "hold" };
      continue;
    }
    const author = chatters[Math.floor(chatters.length * r.next() ** 2)] ?? w.channel;
    authors.push(author);
    const owner = author === w.channel;
    const emotes = owner ? all : free;
    const kind = r.next();
    let body: string;
    let isAction = false;
    let replyTo: number | null = null;
    if (owner && kind < 0.5) body = r.pick(OWNER_LINES);
    else if (kind < 0.5) body = r.pick(CHAT_PLAIN);
    else if (kind < 0.7 && emotes.length > 0)
      body = r.chance(0.3) ? `${r.pick(emotes)} ${r.pick(emotes)}` : `${r.pick(CHAT_PLAIN)} ${r.pick(emotes)}`;
    else if (kind < 0.8 && chatters.length > 1) {
      // Any other chatter (one pick, then the next one along if it was the author).
      const j = r.int(0, chatters.length - 1);
      const other = chatters[j] === author ? chatters[(j + 1) % chatters.length] : chatters[j];
      body = r.pick(CHAT_MENTIONS).replace("{mention}", `@${nameOf(other ?? w.channel)}`);
    } else if (kind < 0.92 && i > 0) {
      replyTo = r.int(Math.max(0, i - 20), i - 1);
      body = `@${nameOf(authors[replyTo] ?? w.channel)} ${r.pick(CHAT_REPLIES)}`;
    } else if (kind < 0.97) {
      body = r.pick(CHAT_ACTIONS);
      isAction = true;
    } else body = r.pick(CHAT_PLAIN);
    yield { author, body, isAction, replyTo, createdAt, held: false };
  }
}

/** Every planned row of seed-social. Pure. */
export function planSocial(rng: Rng, scale: SeedScale, now: Date): SocialPlan {
  const t = now.getTime();
  const accounts = planAccounts(rng.fork("accounts"), scale, now);
  const has = (h: string) => accounts.some((a) => a.handle === h);
  const createdOf = new Map(accounts.map((a) => [a.handle, a.createdAt.getTime()]));
  // Backdated rows never predate an account they reference: at least an hour after the newest one.
  const notBefore = (when: number, ...handles: string[]) =>
    at(Math.max(when, ...handles.map((h) => (createdOf.get(h) ?? 0) + HOUR_MS)));
  const channels = planChannels(rng.fork("channels"), accounts);
  const bulkViewers = accounts.filter((a) => a.kind === "bulk-viewer").map((a) => a.handle);
  const bulkStreamers = accounts.filter((a) => a.kind === "bulk-streamer").map((a) => a.handle);

  // People with a fixed part to play are drawn first, from disjoint slices of a shuffled list.
  const shuffled = rng.fork("cast").shuffle(bulkViewers);
  const take = (n: number) => shuffled.splice(0, Math.max(0, Math.min(n, shuffled.length)));
  const moveLinkFollowers = take(clamp(3 * scale.factor, 3, 20));
  const bulkMods = take(3);
  // A few bulk channels have a bulk moderator too (more at larger scales).
  const bulkChannelMods = take(Math.min(bulkStreamers.length, 2 * scale.factor));
  const bulkVip = take(1);
  const banTargets = take(2);
  const blocked = take(3);

  const roles: RoleSpec[] = [];
  const role = (channel: string, user: string, r: RoleSpec["role"]) => {
    if (has(channel) && has(user)) roles.push({ channel, user, role: r, grantedBy: channel });
  };
  role("streamer1", "chanmod", "moderator");
  role("streamer1", "chanmod", "vip");
  role("streamer2", "chanmod", "editor");
  ["streamer1", "streamer2", "council1"].forEach((c, i) => {
    const u = bulkMods[i];
    if (u) role(c, u, "moderator");
  });
  if (bulkVip[0]) role("streamer1", bulkVip[0], "vip");
  bulkChannelMods.forEach((u, i) => {
    const c = bulkStreamers[i];
    if (c) role(c, u, "moderator");
  });

  const follows = planFollows(rng.fork("follows"), accounts, channels, now, new Set(moveLinkFollowers));
  const followsS1 = new Set(follows.filter((f) => f.channel === "streamer1").map((f) => f.follower));

  const rb = rng.fork("blocks");
  const blocks: BlockSpec[] = [];
  const block = (user: string, target: string | undefined) => {
    if (target && has(user) && has(target) && user !== target)
      blocks.push({ user, blocked: target, createdAt: notBefore(t - rb.int(1, 20) * DAY_MS, user, target) });
  };
  block("viewer1", blocked[0]);
  block("viewer1", blocked[1]);
  block("viewer1", "banned");
  block("viewer2", blocked[2]);
  block("viewer2", "banned");

  const bans: BanSpec[] = [];
  const ban = (p: Omit<BanSpec, "expiresAt" | "reason">) => {
    if (!has(p.channel) || !has(p.target) || !has(p.moderator)) return;
    const createdAt = notBefore(p.createdAt.getTime(), p.channel, p.target, p.moderator);
    bans.push({
      ...p,
      createdAt,
      reason: p.durationSeconds === null ? BAN_REASONS.ban : BAN_REASONS.timeout,
      expiresAt: p.durationSeconds === null ? null : at(createdAt.getTime() + p.durationSeconds * 1000),
    });
  };
  // viewer2's timeout on streamer1 runs the longest the API allows, so it is still on when testers look.
  ban({
    channel: "streamer1",
    target: "viewer2",
    moderator: "chanmod",
    durationSeconds: MAX_TIMEOUT_SECONDS,
    createdAt: at(t - HOUR_MS),
  });
  ban({
    channel: "streamer1",
    target: banTargets[0] ?? "banned",
    moderator: "streamer1",
    durationSeconds: null,
    createdAt: at(t - 3 * DAY_MS),
  });
  ban({
    channel: "streamer2",
    target: "banned",
    moderator: "streamer2",
    durationSeconds: null,
    createdAt: at(t - 5 * DAY_MS),
  });
  if (banTargets[1])
    ban({
      channel: "streamer1",
      target: banTargets[1],
      moderator: "chanmod",
      durationSeconds: 600,
      createdAt: at(t - 10 * DAY_MS),
    });

  const rs = rng.fork("sessions");
  const sessions: SessionSpec[] = [];
  const session = (user: string, when: number) => {
    const createdAt = notBefore(when, user);
    sessions.push({
      user,
      createdAt,
      expiresAt: at(createdAt.getTime() + SESSION_TTL_MS),
      userAgent: rs.pick(USER_AGENTS),
    });
  };
  const signedIn = accounts.filter((a) => a.kind === "fixed" && a.handle !== "newbie");
  for (const a of signedIn) session(a.handle, t - rs.int(1, 20) * DAY_MS - rs.int(0, 23) * HOUR_MS);
  if (has("viewer1")) {
    session("viewer1", t - rs.int(1, 6) * HOUR_MS);
    // A device that signed in long ago and was never used again: expired.
    session("viewer1", t - 60 * DAY_MS);
  }
  for (const h of rs.sample(bulkViewers, Math.min(bulkViewers.length, 5 * scale.factor)))
    session(h, t - rs.int(1, 25) * DAY_MS);

  const passkeys: PasskeySpec[] = has("viewer1")
    ? PASSKEY_NAMES.map((name, i) => ({
        user: "viewer1",
        name,
        createdAt: at(t - (40 - i * 15) * DAY_MS),
        deviceType: i === 0 ? "singleDevice" : "multiDevice",
        backedUp: i !== 0,
        transports: i === 0 ? "internal" : "internal,hybrid",
      }))
    : [];

  const rc = rng.fork("consents");
  const consents: ConsentSpec[] = [];
  for (const a of signedIn)
    consents.push({
      user: a.handle,
      preferences: a.handle !== "viewer2",
      createdAt: at(a.createdAt.getTime() + HOUR_MS),
    });
  for (const h of rc.sample(bulkViewers, Math.ceil(bulkViewers.length * 0.3))) {
    const a = accounts.find((x) => x.handle === h);
    if (a)
      consents.push({
        user: h,
        preferences: rc.chance(0.5),
        createdAt: at(between(rc, a.createdAt.getTime(), t - HOUR_MS)),
      });
  }
  for (let i = 0; i < 3 * scale.factor; i++)
    consents.push({ user: null, preferences: rc.chance(0.4), createdAt: at(t - rc.int(1, 20) * DAY_MS) });

  const grantHolders = [
    ...(followsS1.has("viewer1") ? ["viewer1"] : []),
    ...rng.fork("grants").sample(
      bulkViewers.filter((h) => followsS1.has(h)),
      clamp(5 * scale.factor, 5, 20) - 1,
    ),
  ];
  const movedStreamer = bulkStreamers.at(-1) ?? null;
  const movedAccount = accounts.find((a) => a.handle === movedStreamer);

  const chatWindows = planChatWindows(rng.fork("windows"), scale, now, accounts, channels);
  return {
    now,
    accounts,
    categories: CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, mature: c.mature ?? false })),
    channels,
    roles,
    follows,
    blocks,
    bans,
    sessions,
    twoFactors: ["admin", "viewer1"].filter(has),
    passkeys,
    consents,
    chatWindows,
    api: {
      emoteChannels: channels.filter((c) => c.emotes.length > 0).map((c) => c.ownerHandle),
      moveLinkFollowers,
      grantHolders,
      movedStreamer,
      movedTo: movedAccount ? `https://${MOVED_TO_HOST}/${movedAccount.username}` : null,
    },
  };
}

/** Row counts the plan implies, without generating chat lines (for the large preset). Pure. */
export function planCounts(plan: SocialPlan): Record<string, number> {
  return {
    users: plan.accounts.length,
    accounts: plan.accounts.filter((a) => a.kind !== "bot").length,
    channels: plan.channels.length,
    streamerChannels: plan.channels.filter((c) => c.streamer).length,
    channel_panels: plan.channels.reduce((n, c) => n + c.panels.length, 0),
    channel_sub_tiers: plan.channels.reduce((n, c) => n + c.tiers.length, 0),
    word_filters: plan.channels.reduce((n, c) => n + c.wordFilters.length, 0),
    emotes: plan.channels.reduce((n, c) => n + c.emotes.length, 0),
    channel_roles: plan.roles.length,
    follows: plan.follows.length,
    user_blocks: plan.blocks.length,
    chat_bans: plan.bans.length,
    sessions: plan.sessions.length,
    two_factors: plan.twoFactors.length,
    passkeys: plan.passkeys.length,
    consent_records: plan.consents.length,
    chat_messages: plan.chatWindows.reduce((n, w) => n + w.lines, 0),
  };
}

/** The store entries for the plan, given the ids the writer minted. Streamer channels only. Pure. */
export function storeEntries(
  plan: Pick<SocialPlan, "accounts" | "channels">,
  ids: { users: ReadonlyMap<string, string>; channels: ReadonlyMap<string, string> },
): { users: SeededUser[]; channels: SeededChannel[] } {
  const idOf = (m: ReadonlyMap<string, string>, h: string, what: string) => {
    const id = m.get(h);
    if (!id) throw new Error(`seed-social: no ${what} id for ${h}`);
    return id;
  };
  return {
    users: plan.accounts.map((a) => ({
      id: idOf(ids.users, a.handle, "user"),
      handle: a.handle,
      username: a.username,
      email: a.email,
      kind: a.kind,
      platformRole: a.platformRole,
    })),
    channels: plan.channels
      .filter((c) => c.streamer)
      .map((c) => ({
        id: idOf(ids.channels, c.ownerHandle, "channel"),
        ownerId: idOf(ids.users, c.ownerHandle, "user"),
        ownerHandle: c.ownerHandle,
        slug: c.slug,
      })),
  };
}
