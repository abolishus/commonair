// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-platform's pure plan: which apps, grants, subscriptions, notifications, preferences, push
 * and Discord rows, federation peers and imports the unit makes, for whom, when and in which
 * state. Everything comes from `rng` forks, the scale and a read-only snapshot of what seed-social
 * (and the units before this one) left in the database (`PlatformWorld`), so the same seed and
 * scale give the same plan. The writers (`write.ts`, `api.ts`, `federation.ts`, `portability.ts`)
 * turn it into rows. No row predates the account or follow it references.
 */
import { NOTIFICATION_TYPES, type APP_SUSPENSION_REASONS, type NOTIFY_MEDIA } from "@commonair/contracts/enums";
import { EVENTS } from "@commonair/contracts/events";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { OAUTH_LIMITS } from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeedAccountKind } from "../types.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotifyMedium = (typeof NOTIFY_MEDIA)[number];
export type SuspensionReason = (typeof APP_SUSPENSION_REASONS)[number];

/** What the plan reads from the database (seed-social's rows and the earlier units'). */
export interface WorldUser {
  handle: string;
  id: string;
  kind: SeedAccountKind;
  createdAt: Date;
}
export interface WorldChannel {
  ownerHandle: string;
  id: string;
  slug: string;
  createdAt: Date;
}
export interface WorldFollow {
  followerHandle: string;
  channelId: string;
  createdAt: Date;
  notify: boolean;
}
export interface WorldBroadcast {
  id: string;
  channelId: string;
  title: string;
  startedAt: Date;
}
export interface PlatformWorld {
  users: WorldUser[];
  /** Every channel of a seeded human (streamers and viewers alike). */
  channels: WorldChannel[];
  /** The fixed logins' follows, and every follow of streamer1. */
  follows: WorldFollow[];
  /** Ended broadcasts (seed-media's), newest first. */
  broadcasts: WorldBroadcast[];
  /** Proposals seed-coop made (for `proposal`/`vote_open` links). */
  proposalIds: string[];
  /**
   * Accounts seed-safety restricted (`store.extra.safety.restrictedUserIds`: banned, suspended,
   * scheduled for deletion). The plan never signs in or acts as them.
   */
  restrictedUserIds: string[];
}

// ------------------------------------------------------------------------- apps

export type AppKind = "web" | "pkce" | "device" | "bot" | "bulk";

export interface AppSpec {
  /** Stable key the later specs refer to (`dev-web`, `s1-bot`, `bulk-s0001-0`). */
  key: string;
  owner: string;
  kind: AppKind;
  name: string;
  description: string;
  confidential: boolean;
  redirectUris: string[];
  /** Admin suspends it with this reason. */
  suspend: SuspensionReason | null;
  /** Rotate the secret once after creating it (confidential only). */
  rotate: boolean;
}

export interface GrantSpec {
  user: string;
  appKey: string;
  scopes: Scope[];
  /** Revoked through `developer.grants.revoke` after the token exchange. */
  revoke: boolean;
}

export interface BotSpec {
  owner: string;
  /** Slug-valid; carries the demo anchor. */
  username: string;
  displayName: string;
  scopes: Scope[];
  expiresInDays: number;
}

export interface AuthorizeSpec {
  user: string;
  appKey: string;
  scopes: Scope[];
  /** The `state` the consent page round-trips (deterministic, not a secret). */
  state: string;
}

// ------------------------------------------------------------------- eventsub

/** Where a webhook subscription points: the live receiver, one closed after verification, or a closed port. */
export type SubscriptionTarget = "receiver" | "flaky" | "closed";

export interface SubscriptionSpec {
  key: string;
  appKey: string;
  type: "channel.follow" | "channel.update" | "stream.online" | "stream.offline" | "channel.raid";
  broadcaster: string;
  target: SubscriptionTarget;
}

/** The subscribe condition for a type: its catalog keys (`channel.raid` takes `to_broadcaster_user_id`), all set to the broadcaster. */
export function subscriptionCondition(type: SubscriptionSpec["type"], broadcasterId: string): Record<string, string> {
  return Object.fromEntries(EVENTS[type].condition.map((k) => [k, broadcasterId]));
}

export interface TriggerSpec {
  /** Accounts that follow streamer1 through the API (each one `channel.follow` event). */
  followers: string[];
  /** streamer1 changes its title and back (`channel.update` events). */
  titleChanges: number;
  /** `developer.events.sendTest` calls per receiver subscription. */
  testEvents: number;
}

// --------------------------------------------------------------- notifications

export interface NotificationSpec {
  user: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
}

export interface PreferenceSpec {
  user: string;
  /** null: the member's default for the medium. */
  channelId: string | null;
  medium: NotifyMedium;
  enabled: boolean;
  updatedAt: Date;
}

export interface GoLiveSendSpec {
  user: string;
  channelId: string;
  lastSentAt: Date;
}

/** A go-live email row due for the digest sweep; `queuedAt` is set at write time from the governance window. */
export interface EmailQueueSpec {
  user: string;
  channelId: string;
  broadcastId: string;
  /** The follow's channel slug (its bell is turned on through the API first). */
  slug: string;
}

export interface PushSpec {
  user: string;
  /** The `/push/<id>` path segment on the local push sink. */
  sinkId: string;
}

export interface DiscordSpec {
  owner: string;
  channelId: string;
  /** Path on the local Discord sink, shaped like a Discord webhook path. */
  sinkPath: string;
  setAt: Date;
  lastPostedAt: Date | null;
  failures: number;
  lastError: "unauthorized" | "not_found" | "rate_limited" | "rejected" | "network" | null;
}

// ------------------------------------------------------------ federation, imports

export interface PeerSpec {
  username: string;
  /** Closed before the channel activity, so its inbox's delivery fails. */
  closeBeforeActivity: boolean;
}

export interface FederationSpec {
  owner: string;
  peers: PeerSpec[];
  /** Never resolves: the API refuses it before any fetch. */
  blockedDomain: string;
  /** Admin rotates the federated channel's key. */
  rotateKey: boolean;
}

export interface PortabilitySpec {
  twitchImporter: string;
  /** A bulk channel exports, another imports; null when there are fewer than two bulk streamers. */
  bundle: { from: string; to: string } | null;
}

export interface PlatformPlan {
  apps: AppSpec[];
  bot: BotSpec;
  grants: GrantSpec[];
  authorize: AuthorizeSpec;
  /** The device-flow app the API starts a device authorization for, and the long-lived direct one. */
  device: { appKey: string; scopes: Scope[]; directExpiresInDays: number };
  subscriptions: SubscriptionSpec[];
  triggers: TriggerSpec;
  notifications: NotificationSpec[];
  preferences: PreferenceSpec[];
  goLiveSends: GoLiveSendSpec[];
  emailQueue: EmailQueueSpec[];
  push: PushSpec[];
  discord: DiscordSpec[];
  federation: FederationSpec;
  portability: PortabilitySpec;
}

// ---------------------------------------------------------------------- constants

/** Loopback redirect URIs (RFC 8252: any port matches); nothing listens on them. */
export const REDIRECT_BASE = "http://127.0.0.1:8976";
export const DEVICE_REDIRECT = "http://127.0.0.1/device/done";
/** The domain the admin blocks (n4 step 7's): `.test`, so it never resolves. */
export const BLOCKED_PEER_DOMAIN = "fed-blocked.test";
/** Keep backdated rows inside the prune job's horizons, with a margin. */
export const INBOX_HORIZON_DAYS = NOTIFY_RULES.retentionDays - 5;
export const READ_GO_LIVE_HORIZON_DAYS = NOTIFY_RULES.readGoLiveRetentionDays - 2;
/** A direct device code that outlives any coverage run. */
export const DIRECT_DEVICE_CODE_DAYS = 30;
/** Bulk accounts that register apps (sign-ins are rate limited per address: keep it small). */
export const BULK_APP_OWNERS = 3;

export const GRANT_SCOPES: readonly Scope[] = ["chat:read", "channel:read:subscriptions"];
export const CONSENT_SCOPES: readonly Scope[] = ["chat:read", "chat:edit"];

const between = (r: Rng, lo: number, hi: number) => (hi <= lo ? lo : lo + Math.floor(r.next() * (hi - lo)));
const at = (ms: number) => new Date(ms);

/** A version-4-shaped UUID from the stream (payload references that need no row). */
export function rngUuid(r: Rng): string {
  const hex = Array.from({ length: 32 }, () => r.int(0, 15).toString(16));
  hex[12] = "4";
  hex[16] = ((r.int(0, 15) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Counts derived from the scale (pure; the tests compute the largest preset without writing). */
export function platformCounts(scale: SeedScale) {
  const f = scale.factor;
  return {
    /** Each of viewer1's notification types. */
    inboxPerType: 2 + f,
    /** Extra apps per bulk owner (capped by the API's per-user limit). */
    appsPerBulkOwner: Math.min(OAUTH_LIMITS.appsPerUser, 1 + f),
    /** Extra apps `developer` registers beyond the three named ones. */
    developerExtraApps: Math.min(OAUTH_LIMITS.appsPerUser - 3, 2 * f),
    /** Notifications per bulk viewer (go-live plus a system notice). */
    perBulkViewer: 2,
    /** Bulk viewers with preferences and go-live send history. */
    bulkPreferenceUsers: Math.min(scale.viewers, 10 * f),
    followTriggers: 3,
    testEvents: 2 + Math.min(10, f),
  };
}

const PAYLOAD_KINDS: Record<Exclude<NotificationType, "go_live" | "proposal" | "vote_open">, string[]> = {
  raid: ["raid_incoming"],
  export_ready: ["data_export"],
  payout: ["payout_paid", "payout_held"],
  moderation: ["enforcement_statement", "report_received"],
  system: ["stream_key_leaked", "discord_webhook_removed", "giveaway_won", "notice"],
};

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`seed-platform: ${what}`);
  return v;
}

/** The whole plan. Pure: `world` is a snapshot, `now` the run's start. */
export function planPlatform(rng: Rng, scale: SeedScale, world: PlatformWorld, now: Date): PlatformPlan {
  const t = now.getTime();
  const counts = platformCounts(scale);
  const user = (h: string) =>
    need(
      world.users.find((u) => u.handle === h),
      `no user "${h}" (seed-social runs first)`,
    );
  const channelOf = (h: string) => world.channels.find((c) => c.ownerHandle === h);
  const s1 = need(channelOf("streamer1"), "streamer1 has no channel");
  // Restricted accounts (seed-safety's) never sign in or act; every bulk role is drawn from these lists.
  const restricted = new Set(world.restrictedUserIds);
  const bulkOf = (kind: SeedAccountKind) =>
    world.users.filter((u) => u.kind === kind && !restricted.has(u.id)).map((u) => u.handle);
  const bulkStreamers = bulkOf("bulk-streamer");
  const bulkViewers = bulkOf("bulk-viewer");

  // Apps ------------------------------------------------------------------------------------
  const ar = rng.fork("apps");
  const apps: AppSpec[] = [
    {
      key: "dev-web",
      owner: "developer",
      kind: "web",
      name: "Stream Notes",
      description: "Show notes and timestamps for your broadcasts (confidential web app).",
      confidential: true,
      redirectUris: [`${REDIRECT_BASE}/oauth/callback`],
      suspend: null,
      rotate: true,
    },
    {
      key: "dev-pkce",
      owner: "developer",
      kind: "pkce",
      name: "Chat Overlay Studio",
      description: "A browser overlay editor that signs in with PKCE (public client).",
      confidential: false,
      redirectUris: [`${REDIRECT_BASE}/pkce/callback`],
      suspend: null,
      rotate: false,
    },
    {
      key: "dev-device",
      owner: "developer",
      kind: "device",
      name: "Couch Remote",
      description: "A TV remote for your channel that links with a device code.",
      confidential: false,
      redirectUris: [DEVICE_REDIRECT],
      suspend: null,
      rotate: false,
    },
    {
      key: "s1-bot",
      owner: "streamer1",
      kind: "bot",
      name: "Aurora Bot",
      description: "streamer1's own chat bot integration.",
      confidential: true,
      redirectUris: [`${REDIRECT_BASE}/bot/callback`],
      suspend: null,
      rotate: false,
    },
  ];
  const TOOL_WORDS = ["Clip", "Poll", "Raid", "Emote", "Schedule", "Alert", "Stats", "Caption", "Queue", "Timer"];
  const TOOL_SUFFIX = ["Helper", "Board", "Kit", "Relay", "Desk", "Lens"];
  for (let i = 0; i < counts.developerExtraApps; i++)
    apps.push({
      key: `dev-extra-${i}`,
      owner: "developer",
      kind: "web",
      name: `${ar.pick(TOOL_WORDS)} ${ar.pick(TOOL_SUFFIX)} ${i + 1}`,
      description: "A side project.",
      confidential: ar.chance(0.6),
      redirectUris: [`${REDIRECT_BASE}/extra/${i}`],
      suspend: null,
      rotate: false,
    });
  const owners = bulkStreamers.slice(0, BULK_APP_OWNERS);
  const reasons: SuspensionReason[] = ["spam", "abuse", "terms_violation", "impersonation", "security"];
  owners.forEach((owner, o) => {
    for (let i = 0; i < counts.appsPerBulkOwner; i++)
      apps.push({
        key: `bulk-${owner}-${i}`,
        owner,
        kind: "bulk",
        name: `${ar.pick(TOOL_WORDS)} ${ar.pick(TOOL_SUFFIX)} ${owner}`.slice(0, 50),
        description: "",
        confidential: ar.chance(0.5),
        redirectUris: [`${REDIRECT_BASE}/${owner}/${i}`],
        // One bulk developer's first app is suspended, so /admin/apps shows both states.
        suspend: o === 0 && i === 0 ? ar.pick(reasons) : null,
        rotate: false,
      });
  });

  // Grants, consent, device, bot -----------------------------------------------------------
  const grants: GrantSpec[] = [
    { user: "viewer1", appKey: "dev-web", scopes: [...GRANT_SCOPES], revoke: false },
    { user: "viewer1", appKey: "dev-pkce", scopes: ["chat:read"], revoke: true },
    // streamer1 authorizes the developer's main app, so its scoped subscriptions have a grant.
    { user: "streamer1", appKey: "dev-web", scopes: [...GRANT_SCOPES], revoke: false },
  ];
  const cr = rng.fork("consent");
  const authorize: AuthorizeSpec = {
    user: "viewer1",
    appKey: "s1-bot",
    scopes: [...CONSENT_SCOPES],
    state: `seed${String(cr.int(100_000, 999_999))}`,
  };
  const bot: BotSpec = {
    owner: "developer",
    // Not `demo_`: the API reserves that prefix for every account it creates (bots included). A bot
    // has no email, so it never carries both fixture anchors anyway.
    username: "seeddevbot",
    displayName: "Dev Bot",
    scopes: ["chat:read", "chat:edit"],
    expiresInDays: 90,
  };

  // EventSub ----------------------------------------------------------------------------------
  const subscriptions: SubscriptionSpec[] = [
    { key: "follow", appKey: "dev-web", type: "channel.follow", broadcaster: "streamer1", target: "receiver" },
    { key: "update", appKey: "dev-web", type: "channel.update", broadcaster: "streamer1", target: "receiver" },
    { key: "online", appKey: "dev-web", type: "stream.online", broadcaster: "streamer1", target: "receiver" },
    { key: "raid", appKey: "dev-web", type: "channel.raid", broadcaster: "streamer1", target: "receiver" },
    { key: "flaky", appKey: "dev-web", type: "channel.follow", broadcaster: "streamer1", target: "flaky" },
    { key: "closed", appKey: "dev-web", type: "stream.offline", broadcaster: "streamer1", target: "closed" },
  ];
  const followingS1 = new Set(world.follows.filter((f) => f.channelId === s1.id).map((f) => f.followerHandle));
  // Accounts that sign in anyway come first (sign-ins are rate limited); never `newbie`, whose
  // empty states must stay empty.
  const free = (h: string) => !followingS1.has(h) && world.users.some((u) => u.handle === h);
  const owners0 = bulkStreamers.slice(0, BULK_APP_OWNERS);
  const rest = [...bulkViewers, ...bulkStreamers.slice(BULK_APP_OWNERS)].filter(free);
  const candidates = [...["developer", ...owners0].filter(free), ...rng.fork("triggers").shuffle(rest)];
  const triggers: TriggerSpec = {
    followers: candidates.slice(0, counts.followTriggers),
    titleChanges: 2,
    testEvents: counts.testEvents,
  };

  // Notifications ---------------------------------------------------------------------------
  const nr = rng.fork("notifications");
  const v1 = user("viewer1");
  const notifications: NotificationSpec[] = [];
  const followsOf = (h: string) => world.follows.filter((f) => f.followerHandle === h);
  // Go-live fanout only reaches follows with the bell on (worker notify/fanout/go-live.ts).
  const bellOf = (h: string) => followsOf(h).filter((f) => f.notify);
  /** A go-live row for one of `h`'s bell-on follows, dated at or just after the broadcast it names. */
  const goLive = (r: Rng, h: string, lo: number) => {
    const fs = bellOf(h);
    if (fs.length === 0) return null;
    const f = r.pick(fs);
    const ch = world.channels.find((c) => c.id === f.channelId);
    if (!ch) return null;
    const from = Math.max(lo, f.createdAt.getTime() + MINUTE_MS);
    const end = t - MINUTE_MS;
    if (from > end) return null;
    // Only a broadcast that started after the follow and before now can be the one announced.
    const bs = world.broadcasts.filter(
      (b) => b.channelId === ch.id && b.startedAt.getTime() >= from && b.startedAt.getTime() <= end,
    );
    const b = bs.length > 0 ? r.pick(bs) : null;
    const s = b?.startedAt.getTime();
    const createdAt = s === undefined ? between(r, from, end) : between(r, s, Math.min(end, s + 5 * MINUTE_MS));
    return {
      payload: { channelId: ch.id, slug: ch.slug, broadcastId: b?.id ?? rngUuid(r), title: b?.title ?? "Live now" },
      createdAt,
    };
  };
  const otherPayload = (r: Rng, type: NotificationType): Record<string, unknown> => {
    switch (type) {
      case "go_live":
        return {};
      case "proposal":
      case "vote_open":
        return world.proposalIds.length > 0 ? { proposalId: r.pick(world.proposalIds) } : {};
      case "system": {
        const kind = r.pick(PAYLOAD_KINDS.system);
        return kind === "giveaway_won" ? { kind, giveawayId: rngUuid(r), channel: s1.slug, rank: 1 } : { kind };
      }
      case "raid":
        return { kind: r.pick(PAYLOAD_KINDS.raid), channel: s1.slug };
      default:
        return { kind: r.pick(PAYLOAD_KINDS[type]) };
    }
  };
  const inboxFor = (h: string, perType: number, types: readonly NotificationType[]) => {
    const u = user(h);
    const lo = Math.max(u.createdAt.getTime() + HOUR_MS, t - INBOX_HORIZON_DAYS * DAY_MS);
    for (const type of types)
      for (let i = 0; i < perType; i++) {
        const gl = type === "go_live" ? goLive(nr, h, lo) : null;
        // No bell-on follow (or none old enough): no go-live row rather than one for a muted channel.
        if (type === "go_live" && gl === null) continue;
        const created = gl ? gl.createdAt : between(nr, lo, t - MINUTE_MS);
        // Read go-live rows are pruned after 30 days: keep read ones inside that.
        const readable = type !== "go_live" || created > t - READ_GO_LIVE_HORIZON_DAYS * DAY_MS;
        // The newest of each type stays unread, so the badge and the unread state both show.
        const read = readable && i > 0 && nr.chance(0.55);
        notifications.push({
          user: h,
          type,
          payload: gl ? gl.payload : otherPayload(nr, type),
          createdAt: at(created),
          readAt: read ? at(between(nr, created + MINUTE_MS, t)) : null,
        });
      }
  };
  inboxFor(v1.handle, counts.inboxPerType, NOTIFICATION_TYPES);
  for (const h of ["viewer2", "streamer1", "member1", "developer"])
    if (world.users.some((u) => u.handle === h)) inboxFor(h, 1, NOTIFICATION_TYPES);
  for (const h of bulkViewers) inboxFor(h, 1, ["go_live", "system"]);

  // Preferences and go-live sends -------------------------------------------------------------
  const pr = rng.fork("preferences");
  const preferences: PreferenceSpec[] = [];
  const prefAt = (h: string) => at(between(pr, user(h).createdAt.getTime() + HOUR_MS, t - HOUR_MS));
  // viewer1: every medium on by default (email so the digest sends), and per-channel overrides.
  for (const medium of ["in_app", "email", "push"] as const)
    preferences.push({ user: "viewer1", channelId: null, medium, enabled: true, updatedAt: prefAt("viewer1") });
  const v1Follows = followsOf("viewer1");
  for (const f of pr.sample(v1Follows, 2))
    preferences.push({
      user: "viewer1",
      channelId: f.channelId,
      medium: "push",
      enabled: false,
      // An override configures a follow, so it never predates it.
      updatedAt: at(
        between(pr, Math.max(user("viewer1").createdAt.getTime(), f.createdAt.getTime()) + MINUTE_MS, t - MINUTE_MS),
      ),
    });
  if (world.users.some((u) => u.handle === "viewer2"))
    preferences.push({
      user: "viewer2",
      channelId: null,
      medium: "in_app",
      enabled: false,
      updatedAt: prefAt("viewer2"),
    });
  for (const h of ["member1", "streamer2"].filter((x) => world.users.some((u) => u.handle === x)))
    preferences.push({ user: h, channelId: null, medium: "email", enabled: true, updatedAt: prefAt(h) });
  for (const h of bulkViewers.slice(0, counts.bulkPreferenceUsers))
    preferences.push({
      user: h,
      channelId: null,
      medium: pr.pick(["email", "push"] as const),
      enabled: pr.chance(0.7),
      updatedAt: prefAt(h),
    });

  const gr = rng.fork("goLiveSends");
  const goLiveSends: GoLiveSendSpec[] = [];
  const sendFor = (h: string, f: WorldFollow) => {
    const lo = Math.max(user(h).createdAt.getTime(), f.createdAt.getTime()) + MINUTE_MS;
    goLiveSends.push({ user: h, channelId: f.channelId, lastSentAt: at(between(gr, lo, t - MINUTE_MS)) });
  };
  for (const f of bellOf("viewer1")) sendFor("viewer1", f);
  for (const h of bulkViewers.slice(0, counts.bulkPreferenceUsers)) for (const f of bellOf(h)) sendFor(h, f);

  // The digest: viewer1's followed channels that have a recorded broadcast.
  const emailQueue: EmailQueueSpec[] = [];
  for (const f of bellOf("viewer1")) {
    const b = world.broadcasts.find((x) => x.channelId === f.channelId);
    const ch = world.channels.find((c) => c.id === f.channelId);
    if (b && ch && emailQueue.length < 3)
      emailQueue.push({ user: "viewer1", channelId: f.channelId, broadcastId: b.id, slug: ch.slug });
  }
  if (emailQueue.length === 0) {
    // viewer1 follows nobody with a recording yet: queue streamer1's (its bell is turned on first).
    const b = world.broadcasts.find((x) => x.channelId === s1.id);
    if (b) emailQueue.push({ user: "viewer1", channelId: s1.id, broadcastId: b.id, slug: s1.slug });
  }

  // Push and Discord ----------------------------------------------------------------------------
  const push: PushSpec[] = [
    { user: "viewer1", sinkId: "seed-viewer1-a" },
    { user: "viewer1", sinkId: "seed-viewer1-b" },
  ];
  const dr = rng.fork("discord");
  const discord: DiscordSpec[] = [];
  const discordFor = (h: string, state: "ok" | "failing" | "fresh") => {
    const ch = channelOf(h);
    if (!ch) return;
    const setAt = between(dr, ch.createdAt.getTime() + DAY_MS, t - 2 * DAY_MS);
    const posted = state === "fresh" ? null : at(between(dr, setAt + HOUR_MS, t - HOUR_MS));
    discord.push({
      owner: h,
      channelId: ch.id,
      sinkPath: `/api/webhooks/${String(dr.int(100_000_000, 999_999_999))}/seed${h}`,
      setAt: at(setAt),
      lastPostedAt: posted,
      failures: state === "failing" ? 2 : 0,
      lastError: state === "failing" ? "not_found" : null,
    });
  };
  discordFor("streamer1", "ok");
  discordFor("streamer2", "fresh");
  if (bulkStreamers[0]) discordFor(bulkStreamers[0], "failing");

  // Federation and imports ---------------------------------------------------------------------
  const federation: FederationSpec = {
    owner: "streamer1",
    peers: [
      { username: "gardener", closeBeforeActivity: false },
      { username: "archivist", closeBeforeActivity: false },
      { username: "wanderer", closeBeforeActivity: true },
    ],
    blockedDomain: BLOCKED_PEER_DOMAIN,
    rotateKey: true,
  };
  const pick2 = rng.fork("bundle").sample(bulkStreamers.slice(BULK_APP_OWNERS), 2);
  const fallback = bulkStreamers.length >= 2 ? bulkStreamers.slice(-2) : [];
  const pair = pick2.length === 2 ? pick2 : fallback;
  const portability: PortabilitySpec = {
    twitchImporter: "streamer3",
    bundle: pair.length === 2 ? { from: pair[0] as string, to: pair[1] as string } : null,
  };

  return {
    apps,
    bot,
    grants,
    authorize,
    device: { appKey: "dev-device", scopes: ["chat:read"], directExpiresInDays: DIRECT_DEVICE_CODE_DAYS },
    subscriptions,
    triggers,
    notifications,
    preferences,
    goLiveSends,
    emailQueue,
    push,
    discord,
    federation,
    portability,
  };
}

/** Counts per table the plan's direct inserts write (the API-driven tables are counted live). */
export function plannedDirectRows(plan: PlatformPlan): Record<string, number> {
  return {
    notifications: plan.notifications.length,
    notification_preferences: plan.preferences.length,
    notification_go_live_sends: plan.goLiveSends.length,
    notification_email_queue: plan.emailQueue.length,
    discord_webhooks: plan.discord.length,
  };
}

/** Hosts a seeded row may point at: loopback, the reserved test TLDs, and the host-gateway name the stack's containers use for this machine. */
export function isLocalUrl(url: string, extraHosts: readonly string[] = []): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".invalid") ||
    host.endsWith(".test") ||
    extraHosts.includes(host)
  );
}

/** Every URL the plan itself names (the live receiver and peer URLs are built from `HARNESS_WEBHOOK_HOST`). */
export function planUrls(plan: PlatformPlan): string[] {
  return [...plan.apps.flatMap((a) => a.redirectUris), `http://${plan.federation.blockedDomain}/`];
}
