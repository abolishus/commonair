// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { NOTIFICATION_TYPES } from "@commonair/contracts/enums";
import { EVENTS } from "@commonair/contracts/events";
import { GoLiveNotificationPayload } from "@commonair/contracts/notify";
import { OAUTH_LIMITS, PKCE_CHALLENGE, USER_CODE_ALPHABET, redirectUriProblem } from "@commonair/contracts/oauth";
import { describe, expect, test } from "vite-plus/test";
import { TWITCH_FIXTURE } from "../../src/mocks/twitch/server.ts";
import { FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { unit } from "../../src/seed/platform.ts";
import { rateLimitWait } from "../../src/seed/platform/api.ts";
import {
  BULK_APP_OWNERS,
  DAY_MS,
  HOUR_MS,
  INBOX_HORIZON_DAYS,
  type PlatformPlan,
  type PlatformWorld,
  READ_GO_LIVE_HORIZON_DAYS,
  isLocalUrl,
  planPlatform,
  planUrls,
  platformCounts,
  plannedDirectRows,
  rngUuid,
  subscriptionCondition,
} from "../../src/seed/platform/plan.ts";
import { TWITCH_MOCK_PORT, importableEmotes, twitchMockBases } from "../../src/seed/platform/portability.ts";
import { buildActivateQuery, buildAuthorizeQuery, parseUnsubscribeLink } from "../../src/seed/platform/queries.ts";
import { classifyDeliveries, newUserCode } from "../../src/seed/platform/write.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_ROUTES } from "../../src/seed/routes.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import type { SeedAccountKind } from "../../src/seed/types.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const WEBHOOK_HOST = "host.containers.internal";

/** Hex id from a counter (stable, uuid-shaped). */
const fakeId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A world shaped like seed-social's: fixed logins, bulk accounts, every human with a channel. */
function world(scale: SeedScale): PlatformWorld {
  let n = 1;
  const t = NOW.getTime();
  const users: PlatformWorld["users"] = [];
  const add = (handle: string, kind: SeedAccountKind, ageDays: number) =>
    users.push({ handle, id: fakeId(n++), kind, createdAt: new Date(t - ageDays * DAY_MS) });
  for (const a of FIXED_ACCOUNTS) add(a.handle, a.bot ? "bot" : "fixed", scale.historyDays);
  for (let i = 1; i <= scale.streamers; i++) add(bulkStreamerHandle(i), "bulk-streamer", 20 + (i % 40));
  for (let i = 1; i <= scale.viewers; i++) add(bulkViewerHandle(i), "bulk-viewer", 5 + (i % 50));
  const channels = users
    .filter((u) => u.kind !== "bot")
    .map((u) => ({
      ownerHandle: u.handle,
      id: fakeId(n++),
      slug: `demo_${u.handle}`,
      createdAt: new Date(u.createdAt.getTime() + DAY_MS),
    }));
  const ch = (h: string) => channels.find((c) => c.ownerHandle === h);
  const follows: PlatformWorld["follows"] = [];
  const follow = (follower: string, owner: string, daysAgo: number, notify = true) => {
    const c = ch(owner);
    if (c)
      follows.push({
        followerHandle: follower,
        channelId: c.id,
        createdAt: new Date(t - daysAgo * DAY_MS),
        notify,
      });
  };
  for (const owner of ["streamer1", "streamer2", "streamer3"]) follow("viewer1", owner, 30);
  // Bell off, as seed-social leaves about 15% of follows: never a go-live row.
  follow("viewer1", "chanmod", 40, false);
  follow("viewer2", "streamer1", 20);
  for (let i = 1; i <= Math.min(scale.viewers, 30); i += 2) follow(bulkViewerHandle(i), "streamer1", 3, i % 4 !== 3);
  // Recordings before and after the follows, so a go-live row must pick one it could announce.
  const broadcasts = ["streamer1", "streamer2", "chanmod"].flatMap((h, i) => {
    const c = ch(h);
    return c
      ? [60 * DAY_MS, 10 * DAY_MS, HOUR_MS].map((ago, j) => ({
          id: fakeId(9000 + i * 10 + j),
          channelId: c.id,
          title: `Recorded ${h}`,
          startedAt: new Date(t - ago),
        }))
      : [];
  });
  return { users, channels, follows, broadcasts, proposalIds: [fakeId(8000), fakeId(8001)], restrictedUserIds: [] };
}

const small = SEED_SCALES.small;
const W = world(small);
const plan = (seed = 7, scale: SeedScale = small, w: PlatformWorld = W) =>
  planPlatform(createRng(seed).fork("platform"), scale, w, NOW);
const P = plan();
const userOf = (w: PlatformWorld, h: string) => {
  const u = w.users.find((x) => x.handle === h);
  if (!u) throw new Error(h);
  return u;
};
const counts = (p: PlatformPlan) => ({
  apps: p.apps.length,
  grants: p.grants.length,
  subscriptions: p.subscriptions.length,
  followers: p.triggers.followers.length,
  push: p.push.length,
  peers: p.federation.peers.length,
  ...plannedDirectRows(p),
});

describe("seed-platform unit", () => {
  test("claims its stub's tables, runs after social, media, safety and coop, and leaves nothing pending", () => {
    expect(unit.name).toBe("platform");
    // coop: the proposal notifications link its proposals.
    expect(unit.after).toEqual(["social", "media", "safety", "coop"]);
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toHaveLength(21);
    expect(unit.tables).toContain("federation_actor_keys");
    expect(unit.tables).toContain("portability_signing_keys");
  });

  test("the routes it fills read only the keys it publishes", () => {
    const keys = new Set(["appId", "authorizeQuery", "activateQuery", "unsubscribeQuery"]);
    const read = Object.values(SEED_ROUTES)
      .flatMap((r) => [r.query, ...Object.values(r.params ?? {})])
      .flatMap((v) => (v && "extra" in v && v.extra[0] === "platform" ? [v.extra[1]] : []));
    expect(new Set(read)).toEqual(keys);
  });
});

describe("planPlatform", () => {
  test("is deterministic: the same seed and scale give the same plan", () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(P));
  });

  test("a different seed changes content but not counts", () => {
    const other = plan(8);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(P));
    expect(counts(other)).toEqual(counts(P));
  });

  test("counts scale with factor (capped by the API's per-user app limit)", () => {
    const s = platformCounts(SEED_SCALES.small);
    const m = platformCounts(SEED_SCALES.medium);
    const l = platformCounts(SEED_SCALES.large);
    expect(m.inboxPerType).toBeGreaterThan(s.inboxPerType);
    expect(l.inboxPerType).toBeGreaterThan(m.inboxPerType);
    expect(m.appsPerBulkOwner).toBeGreaterThan(s.appsPerBulkOwner);
    expect(m.bulkPreferenceUsers).toBeGreaterThan(s.bulkPreferenceUsers);
    expect(l.appsPerBulkOwner).toBeLessThanOrEqual(OAUTH_LIMITS.appsPerUser);
    expect(l.developerExtraApps + 3).toBeLessThanOrEqual(OAUTH_LIMITS.appsPerUser);
    const medium = { ...SEED_SCALES.medium, streamers: 20, viewers: 60 };
    const pm = plan(7, medium, world(medium));
    expect(pm.notifications.filter((x) => x.user === "viewer1").length).toBeGreaterThan(
      P.notifications.filter((x) => x.user === "viewer1").length,
    );
    expect(pm.apps.length).toBeGreaterThan(P.apps.length);
  });

  test("the largest preset's counts, computed without writing", () => {
    const l = platformCounts(SEED_SCALES.large);
    expect(l.inboxPerType).toBe(102);
    expect(l.bulkPreferenceUsers).toBe(1_000);
    expect(l.appsPerBulkOwner).toBe(OAUTH_LIMITS.appsPerUser);
    expect(l.testEvents).toBe(12);
  });

  test("zero bulk accounts: no bulk apps, no bundle, every fixed login still served", () => {
    const zero: SeedScale = { streamers: 0, viewers: 0, chatLines: 0, historyDays: 30, factor: 1 };
    const p = plan(7, zero, world(zero));
    expect(p.apps.filter((a) => a.kind === "bulk")).toHaveLength(0);
    expect(p.apps.some((a) => a.suspend)).toBe(false);
    expect(p.portability.bundle).toBeNull();
    expect(p.notifications.filter((n) => n.user === "viewer1").length).toBe(3 * NOTIFICATION_TYPES.length);
    expect(p.triggers.followers.length).toBeGreaterThan(0);
    expect(p.emailQueue.length).toBeGreaterThan(0);
  });

  test("developer: a confidential web app, a public PKCE app, a device app, a bot and webhook subscriptions", () => {
    const dev = P.apps.filter((a) => a.owner === "developer");
    expect(dev.find((a) => a.key === "dev-web")?.confidential).toBe(true);
    expect(dev.find((a) => a.key === "dev-pkce")?.confidential).toBe(false);
    expect(dev.find((a) => a.key === "dev-device")?.confidential).toBe(false);
    expect(dev.find((a) => a.key === "dev-web")?.rotate).toBe(true);
    expect(P.bot.owner).toBe("developer");
    // me.bots.create refuses the reserved `demo_` prefix.
    expect(P.bot.username.startsWith("demo_")).toBe(false);
    expect(P.device.appKey).toBe("dev-device");
    for (const s of P.subscriptions) expect(P.apps.find((a) => a.key === s.appKey)?.owner).toBe("developer");
  });

  test("streamer1 registers its bot app; admin suspends exactly one bulk developer's app", () => {
    expect(P.apps.find((a) => a.owner === "streamer1")?.kind).toBe("bot");
    const suspended = P.apps.filter((a) => a.suspend !== null);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.kind).toBe("bulk");
    expect(P.apps.some((a) => a.kind === "bulk" && a.suspend === null)).toBe(true);
    expect(new Set(P.apps.filter((a) => a.kind === "bulk").map((a) => a.owner)).size).toBe(BULK_APP_OWNERS);
  });

  test("every app name and redirect URI is one the API accepts", () => {
    for (const a of P.apps) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.name.length).toBeLessThanOrEqual(50);
      for (const u of a.redirectUris) expect(redirectUriProblem(u), u).toBeNull();
    }
    const perOwner = new Map<string, number>();
    for (const a of P.apps) perOwner.set(a.owner, (perOwner.get(a.owner) ?? 0) + 1);
    for (const n of perOwner.values()) expect(n).toBeLessThanOrEqual(OAUTH_LIMITS.appsPerUser);
  });

  test("viewer1 authorizes two apps and revokes one; the consent query names an app it never authorized", () => {
    const mine = P.grants.filter((g) => g.user === "viewer1");
    expect(mine).toHaveLength(2);
    expect(mine.filter((g) => g.revoke)).toHaveLength(1);
    expect(mine.map((g) => g.appKey)).not.toContain(P.authorize.appKey);
    expect(P.authorize.user).toBe("viewer1");
  });

  test("subscriptions point at the receiver, a flaky receiver and a closed port", () => {
    const targets = new Set(P.subscriptions.map((s) => s.target));
    expect(targets).toEqual(new Set(["receiver", "flaky", "closed"]));
    expect(P.triggers.followers.length).toBeGreaterThan(0);
    const followsS1 = new Set(
      W.follows
        .filter((f) => f.channelId === W.channels.find((c) => c.ownerHandle === "streamer1")?.id)
        .map((f) => f.followerHandle),
    );
    for (const h of P.triggers.followers) expect(followsS1.has(h), h).toBe(false);
    expect(P.triggers.followers).not.toContain("newbie");
    expect(P.triggers.followers[0]).toBe("developer");
    for (const n of P.notifications) expect(n.user).not.toBe("newbie");
    for (const p of P.preferences) expect(p.user).not.toBe("newbie");
    // The flaky subscription covers the follows the triggers make.
    expect(P.subscriptions.find((s) => s.target === "flaky")?.type).toBe("channel.follow");
  });

  test("every subscription's condition has exactly its catalog keys (channel.raid: to_broadcaster_user_id)", () => {
    for (const s of P.subscriptions)
      expect(Object.keys(subscriptionCondition(s.type, "b")).sort(), s.key).toEqual(
        [...EVENTS[s.type].condition].sort(),
      );
    expect(subscriptionCondition("channel.raid", "b")).toEqual({ to_broadcaster_user_id: "b" });
    expect(P.subscriptions.some((s) => s.type === "channel.raid")).toBe(true);
  });

  test("go-live rows and sends only for bell-on follows, dated at the broadcast they name", () => {
    const bellOn = (user: string, channelId: unknown) =>
      W.follows.find((f) => f.followerHandle === user && f.channelId === channelId)?.notify === true;
    const gl = P.notifications.filter((n) => n.type === "go_live");
    expect(gl.length).toBeGreaterThan(0);
    let named = 0;
    for (const n of gl) {
      expect(bellOn(n.user, n.payload.channelId), `${n.user} ${String(n.payload.channelId)}`).toBe(true);
      const b = W.broadcasts.find((x) => x.id === n.payload.broadcastId);
      if (!b) continue;
      named++;
      expect(b.channelId).toBe(n.payload.channelId);
      expect(n.createdAt.getTime()).toBeGreaterThanOrEqual(b.startedAt.getTime());
      expect(n.createdAt.getTime()).toBeLessThanOrEqual(b.startedAt.getTime() + 5 * 60_000);
    }
    expect(named).toBeGreaterThan(0);
    for (const s of P.goLiveSends) expect(bellOn(s.user, s.channelId), `${s.user} ${s.channelId}`).toBe(true);
    // Bulk viewers with no bell-on follow get no go-live row (never a fallback channel).
    for (const n of gl) expect(W.follows.some((f) => f.followerHandle === n.user && f.notify)).toBe(true);
  });

  test("restricted accounts (seed-safety's) are never planned to sign in, act or receive rows", () => {
    const restricted = [bulkStreamerHandle(1), bulkStreamerHandle(2), bulkViewerHandle(1), bulkViewerHandle(2)];
    const w = { ...W, restrictedUserIds: restricted.map((h) => userOf(W, h).id) };
    const p = plan(7, small, w);
    const json = JSON.stringify(p);
    for (const h of restricted) expect(json.includes(`"${h}"`), h).toBe(false);
    expect(new Set(p.apps.filter((a) => a.kind === "bulk").map((a) => a.owner)).size).toBe(BULK_APP_OWNERS);
  });

  test("viewer1's inbox has every type, read and unread, and go-live payloads the web parses", () => {
    const v1 = P.notifications.filter((n) => n.user === "viewer1");
    for (const type of NOTIFICATION_TYPES) {
      const of = v1.filter((n) => n.type === type);
      expect(of.length, type).toBe(platformCounts(small).inboxPerType);
      expect(
        of.some((n) => n.readAt === null),
        type,
      ).toBe(true);
    }
    expect(v1.some((n) => n.readAt !== null)).toBe(true);
    for (const n of v1.filter((x) => x.type === "go_live"))
      expect(GoLiveNotificationPayload.safeParse(n.payload).success).toBe(true);
    for (const n of v1.filter((x) => x.type === "proposal" || x.type === "vote_open"))
      expect(W.proposalIds).toContain(n.payload.proposalId);
  });

  test("no notification predates its user or follow, and none falls outside the prune horizons", () => {
    const t = NOW.getTime();
    for (const n of P.notifications) {
      const u = userOf(W, n.user);
      expect(n.createdAt.getTime()).toBeGreaterThanOrEqual(u.createdAt.getTime());
      expect(n.createdAt.getTime()).toBeLessThanOrEqual(t);
      expect(n.createdAt.getTime()).toBeGreaterThanOrEqual(t - INBOX_HORIZON_DAYS * DAY_MS);
    }
    for (const n of P.notifications.filter((x) => x.readAt !== null)) {
      expect(n.readAt?.getTime()).toBeGreaterThanOrEqual(n.createdAt.getTime());
      expect(n.readAt?.getTime()).toBeLessThanOrEqual(t);
    }
    for (const n of P.notifications.filter((x) => x.readAt !== null && x.type === "go_live"))
      expect(n.createdAt.getTime()).toBeGreaterThan(t - READ_GO_LIVE_HORIZON_DAYS * DAY_MS);
    const followed = (n: (typeof P.notifications)[number]) =>
      W.follows.find((x) => x.followerHandle === n.user && x.channelId === n.payload.channelId);
    for (const n of P.notifications.filter((x) => x.type === "go_live" && followed(x)))
      expect(n.createdAt.getTime()).toBeGreaterThan(followed(n)?.createdAt.getTime() ?? Infinity);
  });

  test("preferences, go-live sends and Discord rows never predate their user, follow or channel", () => {
    for (const p of P.preferences) expect(p.updatedAt.getTime()).toBeGreaterThan(userOf(W, p.user).createdAt.getTime());
    const overrides = P.preferences.filter((p) => p.channelId !== null);
    expect(overrides.length).toBeGreaterThan(0);
    for (const p of overrides) {
      const f = W.follows.find((x) => x.followerHandle === p.user && x.channelId === p.channelId);
      expect(f, `${p.user} follows ${String(p.channelId)}`).toBeDefined();
      expect(p.updatedAt.getTime()).toBeGreaterThan(f?.createdAt.getTime() ?? Infinity);
    }
    expect(P.goLiveSends.some((s) => s.user === "viewer1")).toBe(true);
    for (const s of P.goLiveSends) {
      const f = W.follows.find((x) => x.followerHandle === s.user && x.channelId === s.channelId);
      expect(f, `${s.user} follows ${s.channelId}`).toBeDefined();
      expect(s.lastSentAt.getTime()).toBeGreaterThan(f?.createdAt.getTime() ?? 0);
      expect(s.lastSentAt.getTime()).toBeGreaterThan(userOf(W, s.user).createdAt.getTime());
    }
    const keys = P.goLiveSends.map((s) => `${s.user}/${s.channelId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of P.discord) {
      const c = W.channels.find((x) => x.id === d.channelId);
      expect(d.setAt.getTime()).toBeGreaterThan(c?.createdAt.getTime() ?? Infinity);
    }
    for (const d of P.discord.filter((x) => x.lastPostedAt !== null))
      expect(d.lastPostedAt?.getTime()).toBeGreaterThan(d.setAt.getTime());
  });

  test("viewer1 has email on by default, so the queued digest sends; it queues followed, recorded channels", () => {
    expect(P.preferences).toContainEqual(
      expect.objectContaining({ user: "viewer1", channelId: null, medium: "email", enabled: true }),
    );
    expect(P.emailQueue.length).toBeGreaterThan(0);
    for (const q of P.emailQueue) {
      expect(q.user).toBe("viewer1");
      expect(W.broadcasts.find((b) => b.id === q.broadcastId)?.channelId).toBe(q.channelId);
    }
    const prefKeys = P.preferences.map((p) => `${p.user}/${p.medium}/${p.channelId ?? ""}`);
    expect(new Set(prefKeys).size).toBe(prefKeys.length);
  });

  test("push, Discord and federation states", () => {
    expect(P.push.filter((p) => p.user === "viewer1").length).toBeGreaterThan(0);
    for (const p of P.push) expect(p.sinkId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(P.discord.find((d) => d.owner === "streamer1")).toBeDefined();
    expect(P.discord.some((d) => d.lastError !== null && d.failures > 0)).toBe(true);
    expect(P.discord.some((d) => d.lastPostedAt === null)).toBe(true);
    for (const d of P.discord) expect(d.sinkPath).toMatch(/^\/api\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,100}$/);
    expect(P.federation.owner).toBe("streamer1");
    expect(P.federation.peers.some((p) => p.closeBeforeActivity)).toBe(true);
    expect(P.federation.peers.some((p) => !p.closeBeforeActivity)).toBe(true);
    expect(P.portability.twitchImporter).toBe("streamer3");
    expect(P.portability.bundle).not.toBeNull();
    expect(P.portability.bundle?.from).not.toBe(P.portability.bundle?.to);
  });

  test("nothing personal in payloads: ids, slugs and enums only", () => {
    const text = JSON.stringify(P.notifications.map((n) => n.payload));
    expect(text).not.toMatch(/@/);
    for (const a of FIXED_ACCOUNTS) expect(text.includes(a.displayName), a.displayName).toBe(false);
  });
});

describe("local peers only", () => {
  test("every URL in the plan is local", () => {
    for (const u of planUrls(P)) expect(isLocalUrl(u), u).toBe(true);
    for (const d of P.discord)
      expect(isLocalUrl(`http://${WEBHOOK_HOST}:4000${d.sinkPath}`, [WEBHOOK_HOST])).toBe(true);
  });

  test("isLocalUrl accepts loopback, .invalid, .test and the named host gateway, nothing else", () => {
    for (const ok of [
      "http://127.0.0.1:1/x",
      "http://localhost/",
      "http://[::1]:9/",
      "https://a.invalid/",
      "http://fed-blocked.test/",
    ])
      expect(isLocalUrl(ok), ok).toBe(true);
    expect(isLocalUrl(`http://${WEBHOOK_HOST}:5/hook`, [WEBHOOK_HOST])).toBe(true);
    for (const bad of [
      "https://discord.com/api/webhooks/1/x",
      "https://example.com/",
      `http://${WEBHOOK_HOST}:5/`,
      "not a url",
    ])
      expect(isLocalUrl(bad), bad).toBe(false);
  });

  test("the Twitch import is planned only against the mock", () => {
    const bases = twitchMockBases(WEBHOOK_HOST);
    for (const u of Object.values(bases)) expect(isLocalUrl(u, [WEBHOOK_HOST])).toBe(true);
    const overlay = readFileSync(new URL("../../compose.n3.yaml", import.meta.url), "utf8");
    expect(overlay).toContain(`TWITCH_API_BASE_URL: ${bases.api}`);
    expect(overlay).toContain(`TWITCH_AUTH_BASE_URL: ${bases.auth}`);
    expect(TWITCH_MOCK_PORT).toBe(4791);
  });

  test("staging seed mode points the stack at the mock by the harness container's name (ADR 0040)", () => {
    const sh = readFileSync(new URL("../../../scripts/selfhost.sh", import.meta.url), "utf8");
    const host = /^SEED_HARNESS_HOST=(\S+)$/m.exec(sh)?.[1];
    expect(host).toBe("seed-harness");
    const unit = readFileSync(
      new URL("../../../infra/quadlet/commonair-seed-harness.container", import.meta.url),
      "utf8",
    );
    // The mock's public host is HARNESS_WEBHOOK_HOST, which the harness unit sets to that name.
    expect(unit).toContain(`\nEnvironment=HARNESS_WEBHOOK_HOST=${host}\n`);
    const bases = twitchMockBases(host!);
    const line = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(sh)?.[1]?.replaceAll("$SEED_HARNESS_HOST", host!);
    expect(line("TWITCH_API_BASE_URL")).toBe(bases.api);
    expect(line("TWITCH_AUTH_BASE_URL")).toBe(bases.auth);
    expect(line("TWITCH_IMAGE_HOSTS")).toBe(host);
    for (const u of Object.values(bases)) expect(isLocalUrl(u, [host!])).toBe(true);
  });

  test("the T0 fixture emote is never imported", () => {
    const offered = Object.keys(TWITCH_FIXTURE.emotes);
    const chosen = importableEmotes(offered);
    expect(chosen).not.toContain(TWITCH_FIXTURE.t0Emote);
    expect(chosen.length).toBe(offered.length - 1);
  });
});

describe("published queries", () => {
  test("authorizeQuery carries every OAuth parameter the consent page reads", () => {
    const q = buildAuthorizeQuery({
      clientId: "abcdefghijklmnopqrstuvwxyz0123",
      redirectUri: "http://127.0.0.1:8976/bot/callback",
      scopes: ["chat:read", "chat:edit"],
      state: P.authorize.state,
      codeChallenge: "a".repeat(43),
    });
    const parsed = Object.fromEntries(new URLSearchParams(q));
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
    expect(parsed.response_type).toBe("code");
    expect(parsed.code_challenge_method).toBe("S256");
    expect(parsed.scope).toBe("chat:read chat:edit");
    expect(PKCE_CHALLENGE.test(parsed.code_challenge ?? "")).toBe(true);
    expect(parsed.state).toMatch(/^seed\d{6}$/);
  });

  test("activateQuery is a ?code= with a well-formed user code", () => {
    const code = newUserCode();
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    for (const c of code.replace("-", "")) expect(USER_CODE_ALPHABET).toContain(c);
    expect(new URLSearchParams(buildActivateQuery(code)).get("code")).toBe(code);
    // Bytes at or above 240 are skipped (no modulo bias).
    const fixed = newUserCode(() => new Uint8Array([255, 240, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(fixed).toBe("BCDF-GHJK");
  });

  test("unsubscribeQuery keeps list and token of a mailed one-click link", () => {
    const q = parseUnsubscribeLink("http://localhost:3000/api/email/unsubscribe?list=go_live&token=abc.def");
    expect(q).not.toBeNull();
    const p = new URLSearchParams(q ?? "");
    expect(p.get("list")).toBe("go_live");
    expect(p.get("token")).toBe("abc.def");
    expect(parseUnsubscribeLink("http://localhost/api/email/unsubscribe?list=spam&token=x")).toBeNull();
    expect(parseUnsubscribeLink("http://localhost/api/email/unsubscribe?list=go_live")).toBeNull();
    expect(parseUnsubscribeLink("not a link")).toBeNull();
  });
});

describe("helpers", () => {
  test("delivery states: delivered, failed for good, failed with a retry scheduled", () => {
    const at = new Date();
    expect(
      classifyDeliveries([
        { status: "succeeded", nextAttemptAt: null },
        { status: "failed", nextAttemptAt: null },
        { status: "failed", nextAttemptAt: at },
        { status: "failed", nextAttemptAt: at },
        { status: "pending", nextAttemptAt: null },
      ]),
    ).toEqual({ delivered: 1, failed: 1, retrying: 2 });
  });

  test("rate-limit refusals are recognized and waited out; other errors are not", () => {
    expect(rateLimitWait({ code: "RATE_LIMITED", data: { retryAfterSeconds: 7 } })).toBe(7);
    expect(rateLimitWait({ status: 429 })).toBe(15);
    expect(rateLimitWait(new Error("sign-in failed: HTTP 429 {}"))).toBe(15);
    expect(rateLimitWait(new Error("sign-in failed: HTTP 401"))).toBeNull();
    expect(rateLimitWait({ code: "FORBIDDEN" })).toBeNull();
    expect(rateLimitWait(null)).toBeNull();
  });

  test("rngUuid is uuid-shaped and deterministic", () => {
    const a = rngUuid(createRng(1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rngUuid(createRng(1))).toBe(a);
  });
});
