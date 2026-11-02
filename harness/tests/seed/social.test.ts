// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isDemoFixtureIdentity } from "@commonair/contracts/fixtures";
import { MONEY_LIMITS } from "@commonair/contracts/currency";
import { describe, expect, test } from "vite-plus/test";
import { applyFilters, compileFilters } from "../../../packages/chat-filter/src/filter.ts";
import { unsafeFilterRegexReason } from "../../../packages/safe-regex/src/index.ts";
import { decodePng } from "../../src/png.ts";
import { BOT_OWNER, FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_ROUTES } from "../../src/seed/routes.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import { unit } from "../../src/seed/social.ts";
import { type SessionSource, emotePng, seedPortability } from "../../src/seed/social/api.ts";
import { CATEGORIES, USED_CATEGORIES, WORD_FILTERS } from "../../src/seed/social/content.ts";
import {
  ACCOUNT_AGE_GATE_DAYS,
  AGED_BULK_SHARE,
  CHAT_HORIZON_DAYS,
  DAY_MS,
  LOCALES,
  MAX_TIMEOUT_SECONDS,
  NEW_STREAMER_FOLLOWERS,
  type SocialPlan,
  apportion,
  chatLines,
  chatPools,
  planCounts,
  planSocial,
  rankedStreamers,
  storeEntries,
} from "../../src/seed/social/plan.ts";
import { currentLegalDocuments, emoteRanges } from "../../src/seed/social/write.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const small = SEED_SCALES.small;
const plan = (seed = 7, scale: SeedScale = small) => planSocial(createRng(seed).fork("social"), scale, NOW);
const lines = (p: SocialPlan, seed = 7) => {
  const pools = chatPools(p);
  const rng = createRng(seed).fork("lines");
  return p.chatWindows.flatMap((w) => [...chatLines(rng, w, pools)].map((l) => ({ ...l, channel: w.channel })));
};
const P = plan();
const L = lines(P);
const acct = (h: string) => {
  const a = P.accounts.find((x) => x.handle === h);
  if (!a) throw new Error(h);
  return a;
};
const followersOf = (p: SocialPlan, h: string) => p.follows.filter((f) => f.channel === h).length;
const fixedHandles = FIXED_ACCOUNTS.map((a) => a.handle);

describe("seed-social unit", () => {
  test("claims its stub's tables and leaves nothing pending", () => {
    expect(unit.name).toBe("social");
    expect(unit.after).toEqual([]);
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toContain("move_links");
  });
});

describe("determinism", () => {
  test("the same seed and scale give the same plan and chat", () => {
    expect(plan()).toEqual(P);
    expect(lines(plan())).toEqual(L);
  });

  test("a different seed changes content but not the fixed counts", () => {
    const q = plan(8);
    expect(q.accounts.map((a) => a.displayName)).not.toEqual(P.accounts.map((a) => a.displayName));
    expect(lines(q, 8).map((l) => l.body)).not.toEqual(L.map((l) => l.body));
    const keep = ["users", "accounts", "channels", "streamerChannels", "chat_messages", "two_factors", "passkeys"];
    const pick = (c: Record<string, number>) => Object.fromEntries(keep.map((k) => [k, c[k]]));
    expect(pick(planCounts(q))).toEqual(pick(planCounts(P)));
    expect(q.api.moveLinkFollowers.length).toBe(P.api.moveLinkFollowers.length);
    expect(q.api.grantHolders.length).toBe(P.api.grantHolders.length);
  });
});

describe("accounts", () => {
  test("every fixed handle, the bulk counts and the bot, with their roles", () => {
    const fixed = P.accounts.filter((a) => a.kind === "fixed" || a.kind === "bot");
    expect(fixed.map((a) => a.handle).sort()).toEqual([...fixedHandles].sort());
    for (const f of FIXED_ACCOUNTS) expect(acct(f.handle).platformRole).toBe(f.platformRole);
    expect(P.accounts.filter((a) => a.kind === "bulk-streamer").map((a) => a.handle)).toEqual(
      Array.from({ length: small.streamers }, (_, i) => bulkStreamerHandle(i + 1)),
    );
    expect(P.accounts.filter((a) => a.kind === "bulk-viewer").map((a) => a.handle)).toEqual(
      Array.from({ length: small.viewers }, (_, i) => bulkViewerHandle(i + 1)),
    );
    const bot = acct("bot1");
    expect(bot).toMatchObject({ kind: "bot", botOwner: BOT_OWNER, locale: null, birthDate: null });
    expect(P.accounts.filter((a) => a.kind === "bot")).toHaveLength(1);
  });

  test("the demo anchors hold for every user", () => {
    for (const a of P.accounts) {
      expect(isDemoFixtureIdentity(a.username, a.email), a.handle).toBe(true);
      expect(a.username).toBe(`demo_${a.handle}`);
      expect(a.email).toBe(`demo_${a.handle}@demo-seed.invalid`);
    }
    expect(new Set(P.accounts.map((a) => a.username)).size).toBe(P.accounts.length);
  });

  test("created_at backdating passes every age gate", () => {
    const age = (d: Date) => (NOW.getTime() - d.getTime()) / DAY_MS;
    for (const a of P.accounts.filter((x) => x.kind === "fixed")) {
      // Fixed logins are `historyDays` old: split recipients (30 d), integrity fallback (7 d), giveaways.
      expect(age(a.createdAt), a.handle).toBeGreaterThanOrEqual(small.historyDays);
      expect(a.adult, a.handle).toBe(true);
    }
    const bulk = P.accounts.filter((a) => a.kind === "bulk-streamer" || a.kind === "bulk-viewer");
    for (const a of bulk) {
      expect(age(a.createdAt)).toBeLessThanOrEqual(small.historyDays);
      expect(age(a.createdAt)).toBeGreaterThanOrEqual(1);
    }
    const aged = bulk.filter((a) => age(a.createdAt) > ACCOUNT_AGE_GATE_DAYS);
    expect(aged.length).toBe(Math.ceil(bulk.length * AGED_BULK_SHARE));
    expect(bulk.some((a) => age(a.createdAt) < ACCOUNT_AGE_GATE_DAYS)).toBe(true);
    expect(acct("bot1").createdAt.getTime()).toBeGreaterThan(acct(BOT_OWNER).createdAt.getTime());
  });

  test("about half the bulk accounts are adults, and birth dates match", () => {
    const bulk = P.accounts.filter((a) => a.kind.startsWith("bulk"));
    expect(bulk.filter((a) => a.adult)).toHaveLength(Math.ceil(bulk.length / 2));
    for (const a of P.accounts.filter((x) => x.birthDate)) {
      const years = (NOW.getTime() - Date.parse(a.birthDate ?? "")) / (365.25 * DAY_MS);
      expect(years >= 18, a.handle).toBe(a.adult);
      expect(years).toBeGreaterThanOrEqual(13);
    }
    for (const a of P.accounts.filter((x) => x.matureConfirmedAt)) expect(a.adult).toBe(true);
  });

  test("the locale spread: fixed logins on en, bulk across en, es and en-XA", () => {
    for (const a of P.accounts.filter((x) => x.kind === "fixed")) expect(a.locale).toBe("en");
    const m = plan(7, SEED_SCALES.medium);
    const bulk = m.accounts.filter((a) => a.kind.startsWith("bulk"));
    const share = (l: string) => bulk.filter((a) => a.locale === l).length / bulk.length;
    expect(Math.abs(share("en") - 0.6)).toBeLessThan(0.05);
    expect(Math.abs(share("es") - 0.25)).toBeLessThan(0.05);
    expect(Math.abs(share("en-XA") - 0.15)).toBeLessThan(0.05);
    for (const l of LOCALES)
      expect(
        P.accounts.some((a) => a.kind.startsWith("bulk") && a.locale === l),
        l,
      ).toBe(true);
    for (const a of P.accounts.filter((x) => x.locale !== null))
      expect(a.locale).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/);
  });
});

describe("channels", () => {
  test("every human has a channel, streamers the full set; bots none", () => {
    expect(P.channels.map((c) => c.ownerHandle).sort()).toEqual(
      P.accounts
        .filter((a) => a.kind !== "bot")
        .map((a) => a.handle)
        .sort(),
    );
    const streamers = P.channels.filter((c) => c.streamer).map((c) => c.ownerHandle);
    expect(streamers.sort()).toEqual(
      P.accounts
        .filter((a) => a.streamer)
        .map((a) => a.handle)
        .sort(),
    );
    for (const c of P.channels) expect(c.slug).toBe(acct(c.ownerHandle).username);
  });

  test("panels: several for streamer1, none for streamer3", () => {
    const ch = (h: string) => P.channels.find((c) => c.ownerHandle === h);
    expect(ch("streamer1")?.panels.length).toBeGreaterThanOrEqual(5);
    expect(ch("streamer3")?.panels).toEqual([]);
    for (const c of P.channels)
      for (const p of c.panels) {
        expect(p.title.length).toBeLessThanOrEqual(60);
        expect(p.linkUrl === null || new URL(p.linkUrl).hostname.endsWith(".invalid")).toBe(true);
      }
  });

  test("sub tiers 1–3 at or above the minimum on every streamer channel", () => {
    for (const c of P.channels.filter((x) => x.streamer)) {
      expect(c.tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
      for (const t of c.tiers) expect(t.priceCents).toBeGreaterThanOrEqual(MONEY_LIMITS.tierMinCents);
    }
  });

  test("categories: realistic, the last ones empty, every streamer in a used one", () => {
    const used = new Set(P.channels.filter((c) => c.streamer).map((c) => c.category));
    for (const c of CATEGORIES.slice(USED_CATEGORIES)) expect(used.has(c.slug)).toBe(false);
    for (const c of P.channels.filter((x) => x.streamer))
      expect(CATEGORIES.some((k) => k.slug === c.category)).toBe(true);
  });

  test("emotes on the fixed streamers, valid codes, unique per channel", () => {
    expect(P.api.emoteChannels.sort()).toEqual(["council1", "council2", "streamer1", "streamer2", "streamer3"]);
    for (const c of P.channels) {
      for (const e of c.emotes) expect(e.code).toMatch(/^[A-Za-z0-9]{2,20}$/);
      expect(new Set(c.emotes.map((e) => e.code)).size).toBe(c.emotes.length);
    }
    expect(P.channels.find((c) => c.ownerHandle === "streamer1")?.emotes.some((e) => e.tier > 0)).toBe(true);
  });

  test("the emote images are distinct 64 px PNGs", () => {
    const a = emotePng("auroraHi");
    const d = decodePng(a);
    expect([d.width, d.height]).toEqual([64, 64]);
    expect(Buffer.from(emotePng("auroraLove")).equals(Buffer.from(a))).toBe(false);
  });

  test("streamer1's regex word filter passes the API's safe-regex validator", () => {
    const filters = P.channels.find((c) => c.ownerHandle === "streamer1")?.wordFilters ?? [];
    expect(filters.map((f) => f.action).sort()).toEqual(["block", "hold", "replace"]);
    const regex = filters.filter((f) => f.isRegex);
    expect(regex).toHaveLength(1);
    for (const f of regex) expect(unsafeFilterRegexReason(f.pattern)).toBeNull();
    expect(WORD_FILTERS.replace.replacement).not.toBeNull();
  });
});

describe("roles, follows, blocks and bans", () => {
  test("chanmod: moderator and VIP on streamer1, editor on streamer2; a few bulk moderators", () => {
    const of = (u: string) =>
      P.roles
        .filter((r) => r.user === u)
        .map((r) => `${r.channel}:${r.role}`)
        .sort();
    expect(of("chanmod")).toEqual(["streamer1:moderator", "streamer1:vip", "streamer2:editor"]);
    const bulkMods = P.roles.filter((r) => /^v\d/.test(r.user) && r.role === "moderator");
    expect(bulkMods.length).toBeGreaterThanOrEqual(3);
    for (const r of P.roles) expect(r.grantedBy).toBe(r.channel);
  });

  test("follows are power-law: fixed streamers big, streamer3 small", () => {
    const ranked = rankedStreamers(P.accounts);
    expect(ranked[0]).toBe("streamer1");
    expect(ranked.at(-1)).toBe("streamer3");
    expect(followersOf(P, "streamer1")).toBeGreaterThan(followersOf(P, "streamer2"));
    expect(followersOf(P, "streamer2")).toBeGreaterThan(followersOf(P, "council2"));
    expect(followersOf(P, "streamer3")).toBe(NEW_STREAMER_FOLLOWERS);
    const m = plan(7, SEED_SCALES.medium);
    const counts = rankedStreamers(m.accounts)
      .map((h) => followersOf(m, h))
      .sort((a, b) => b - a);
    const total = counts.reduce((a, b) => a + b, 0);
    const top = counts.slice(0, Math.ceil(counts.length / 5)).reduce((a, b) => a + b, 0);
    expect(top / total).toBeGreaterThan(0.4);
    expect(counts[0] ?? 0).toBeGreaterThan(10 * (counts[Math.floor(counts.length / 2)] ?? 0));
  });

  test("follows are unique, never the owner, never newbie or the bot, and backdated in range", () => {
    const keys = P.follows.map((f) => `${f.follower}>${f.channel}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of P.follows) {
      expect(f.follower).not.toBe(f.channel);
      expect(["newbie", "bot1"]).not.toContain(f.follower);
      expect(f.createdAt.getTime()).toBeLessThan(NOW.getTime());
      expect(f.createdAt.getTime()).toBeGreaterThan(acct(f.follower).createdAt.getTime());
      expect(P.channels.find((c) => c.ownerHandle === f.channel)?.streamer).toBe(true);
    }
    expect(P.follows.some((f) => !f.notify)).toBe(true);
  });

  test("viewer1 follows every fixed streamer and many bulk ones", () => {
    const v1 = new Set(P.follows.filter((f) => f.follower === "viewer1").map((f) => f.channel));
    for (const a of FIXED_ACCOUNTS.filter((x) => x.streamer)) expect(v1.has(a.handle), a.handle).toBe(true);
    expect([...v1].filter((h) => h.startsWith("s0")).length).toBeGreaterThanOrEqual(small.streamers / 3);
  });

  test("move-link followers do not already follow streamer1; grant holders do", () => {
    const s1 = new Set(P.follows.filter((f) => f.channel === "streamer1").map((f) => f.follower));
    expect(P.api.moveLinkFollowers.length).toBeGreaterThanOrEqual(3);
    for (const h of P.api.moveLinkFollowers) expect(s1.has(h)).toBe(false);
    expect(P.api.grantHolders).toContain("viewer1");
    expect(P.api.grantHolders.length).toBeGreaterThanOrEqual(5);
    for (const h of P.api.grantHolders) expect(s1.has(h)).toBe(true);
    expect(P.api.movedStreamer).toBe(bulkStreamerHandle(small.streamers));
    expect(P.api.movedTo).toMatch(/^https:\/\/[a-z.-]+\.invalid\//);
  });

  test("viewer1 and viewer2 block others; never themselves", () => {
    const by = (u: string) => P.blocks.filter((b) => b.user === u);
    expect(by("viewer1").length).toBeGreaterThanOrEqual(2);
    expect(by("viewer2").length).toBeGreaterThanOrEqual(1);
    for (const b of P.blocks) expect(b.user).not.toBe(b.blocked);
  });

  test("bans: viewer2's live timeout on streamer1, permanent bans, an expired timeout", () => {
    const t = P.bans.find((b) => b.target === "viewer2" && b.channel === "streamer1");
    expect(t?.durationSeconds).toBe(MAX_TIMEOUT_SECONDS);
    expect((t?.expiresAt?.getTime() ?? 0) > NOW.getTime() + 13 * DAY_MS).toBe(true);
    expect(P.bans.filter((b) => b.durationSeconds === null).length).toBeGreaterThanOrEqual(2);
    expect(P.bans.some((b) => b.expiresAt !== null && b.expiresAt.getTime() < NOW.getTime())).toBe(true);
    const active = P.bans.map((b) => `${b.channel}>${b.target}`);
    expect(new Set(active).size).toBe(active.length);
  });
});

describe("sessions, 2FA, passkeys and consent", () => {
  test("a session per fixed login (not newbie), an expired one, a few bulk ones", () => {
    const users = new Set(P.sessions.map((s) => s.user));
    for (const h of fixedHandles.filter((x) => x !== "newbie" && x !== "bot1")) expect(users.has(h), h).toBe(true);
    expect(users.has("newbie")).toBe(false);
    expect(P.sessions.some((s) => s.expiresAt.getTime() < NOW.getTime())).toBe(true);
    expect(P.sessions.filter((s) => /^v\d/.test(s.user)).length).toBe(5 * small.factor);
  });

  test("two_factors for admin and viewer1, passkeys for viewer1", () => {
    expect(P.twoFactors.sort()).toEqual(["admin", "viewer1"]);
    expect(P.passkeys.length).toBeGreaterThanOrEqual(1);
    for (const p of P.passkeys) expect(p.user).toBe("viewer1");
  });

  test("consents: both choices, signed-in and anonymous, never newbie", () => {
    expect(P.consents.some((c) => c.preferences)).toBe(true);
    expect(P.consents.some((c) => !c.preferences)).toBe(true);
    expect(P.consents.filter((c) => c.user === null)).toHaveLength(3 * small.factor);
    expect(P.consents.some((c) => c.user === "newbie")).toBe(false);
  });

  test("newbie has nothing beyond the account", () => {
    const n = "newbie";
    expect(P.follows.some((f) => f.follower === n)).toBe(false);
    expect(P.roles.some((r) => r.user === n)).toBe(false);
    expect(P.blocks.some((b) => b.user === n || b.blocked === n)).toBe(false);
    expect(P.bans.some((b) => b.target === n)).toBe(false);
    expect(L.some((l) => l.author === n || l.author === "bot1")).toBe(false);
  });
});

describe("chat", () => {
  test("totals equal scale.chatLines", () => {
    expect(L).toHaveLength(small.chatLines);
    expect(planCounts(P).chat_messages).toBe(small.chatLines);
  });

  test("weighted toward the fixed streamers; streamer3 has no history", () => {
    const per = (h: string) => L.filter((l) => l.channel === h).length;
    expect(per("streamer1")).toBeGreaterThan(per("streamer2"));
    expect(per("streamer1")).toBeGreaterThan(per("s0001"));
    expect(per("streamer3")).toBe(0);
    expect(P.chatWindows.some((w) => w.channel === "streamer3")).toBe(false);
  });

  test("windows: every streamer but streamer3 has one, chat only inside the horizon, no overlap", () => {
    const horizon = NOW.getTime() - CHAT_HORIZON_DAYS * DAY_MS;
    for (const h of rankedStreamers(P.accounts).filter((x) => x !== "streamer3")) {
      const mine = P.chatWindows.filter((w) => w.channel === h).sort((a, b) => a.start.getTime() - b.start.getTime());
      expect(mine.length, h).toBeGreaterThan(0);
      expect(mine.some((w) => w.start.getTime() > horizon)).toBe(true);
      for (let i = 1; i < mine.length; i++)
        expect(mine[i]?.start.getTime() ?? 0).toBeGreaterThan(mine[i - 1]?.end.getTime() ?? 0);
    }
    for (const w of P.chatWindows) {
      expect(w.start.getTime() > horizon || w.lines === 0).toBe(true);
      expect(w.end.getTime()).toBeLessThan(NOW.getTime());
      expect(w.start.getTime()).toBeGreaterThan(acct(w.channel).createdAt.getTime());
    }
    for (const l of L) {
      const w = P.chatWindows.find((x) => x.channel === l.channel && x.start <= l.createdAt && l.createdAt <= x.end);
      expect(w).toBeDefined();
    }
  });

  test("lines fit chat's limits, replies point backwards, mentions name real users", () => {
    const usernames = new Set(P.accounts.map((a) => a.username));
    for (const l of L) {
      expect(l.body.length).toBeGreaterThan(0);
      expect(l.body.length).toBeLessThanOrEqual(500);
      for (const m of l.body.matchAll(/@([a-z0-9_]+)/g)) expect(usernames.has(m[1] ?? "")).toBe(true);
    }
    expect(L.some((l) => l.replyTo !== null)).toBe(true);
    expect(L.some((l) => l.isAction)).toBe(true);
    expect(L.some((l) => /@demo_/.test(l.body) && l.replyTo === null)).toBe(true);
    expect(L.some((l) => /aurora[A-Z]/.test(l.body))).toBe(true);
  });

  test("streamer1's filters: trips recorded as chat would, nothing else trips them", () => {
    const s1 = P.channels.find((c) => c.ownerHandle === "streamer1");
    const compiled = compileFilters((s1?.wordFilters ?? []).map((f, i) => ({ id: String(i), ...f })));
    expect(compiled).toHaveLength(3);
    const mine = L.filter((l) => l.channel === "streamer1");
    let held = 0;
    let replaced = 0;
    for (const l of mine) {
      const out = applyFilters(l.body, compiled, 1_000);
      expect(out.action, l.body).not.toBe("block");
      if (out.action === "block") continue;
      expect(out.body, l.body).toBe(l.body);
      expect(out.action === "hold", l.body).toBe(l.held);
      if (l.held) held++;
      if (l.body.includes("fr*ck")) replaced++;
    }
    expect(held).toBe(2);
    expect(replaced).toBe(2);
    // Filters skip the owner and moderators, so trips come from ordinary chatters.
    const privileged = new Set(["streamer1", ...P.roles.filter((r) => r.channel === "streamer1").map((r) => r.user)]);
    for (const l of mine.filter((x) => x.held || x.body.includes("fr*ck")))
      expect(privileged.has(l.author)).toBe(false);
    // Other channels never hold.
    expect(L.filter((l) => l.channel !== "streamer1").some((l) => l.held)).toBe(false);
  });

  test("emoteRanges follows chat's parser: whole words, tier-gated", () => {
    const emotes = new Map([
      ["auroraHi", { id: "a", code: "auroraHi", tier: 0 }],
      ["auroraVip", { id: "b", code: "auroraVip", tier: 1 }],
    ]);
    expect(emoteRanges("hey auroraHi auroraVip xauroraHi", emotes, 0)).toEqual([
      { emoteId: "a", code: "auroraHi", start: 4, end: 12 },
    ]);
    expect(emoteRanges("auroraVip", emotes, Number.POSITIVE_INFINITY)).toEqual([
      { emoteId: "b", code: "auroraVip", start: 0, end: 9 },
    ]);
  });
});

describe("store", () => {
  const ids = {
    users: new Map(P.accounts.map((a) => [a.handle, `u-${a.handle}`])),
    channels: new Map(P.channels.map((c) => [c.ownerHandle, `c-${c.ownerHandle}`])),
  };
  const store = storeEntries(P, ids);

  test("users complete with kinds, channels one per streamer", () => {
    expect(store.users).toHaveLength(P.accounts.length);
    expect(store.users.find((u) => u.handle === "bot1")?.kind).toBe("bot");
    expect(store.users.find((u) => u.handle === "admin")?.platformRole).toBe("admin");
    expect(store.channels.map((c) => c.ownerHandle).sort()).toEqual(
      P.accounts
        .filter((a) => a.streamer)
        .map((a) => a.handle)
        .sort(),
    );
    for (const c of store.channels) expect(c.ownerId).toBe(`u-${c.ownerHandle}`);
  });

  test("channelOf resolves for every streamer handle in SEED_ROUTES", () => {
    const handles = Object.values(SEED_ROUTES).flatMap((r) =>
      [...Object.values(r.params ?? {}), ...(r.query ? [r.query] : [])].flatMap((v) =>
        "channelOf" in v ? [v.channelOf] : [],
      ),
    );
    expect(handles.length).toBeGreaterThan(0);
    for (const h of handles)
      expect(
        store.channels.find((c) => c.ownerHandle === h),
        h,
      ).toBeDefined();
  });

  test("missing ids fail loudly", () => {
    expect(() => storeEntries(P, { users: new Map(), channels: ids.channels })).toThrow(/no user id/);
  });
});

describe("scale and edge cases", () => {
  test("counts scale with factor", () => {
    const m = plan(7, SEED_SCALES.medium);
    const fixed = FIXED_ACCOUNTS.length;
    expect(planCounts(m).users).toBe(fixed + SEED_SCALES.medium.streamers + SEED_SCALES.medium.viewers);
    expect(m.consents.filter((c) => c.user === null)).toHaveLength(3 * SEED_SCALES.medium.factor);
    expect(m.api.moveLinkFollowers.length).toBeGreaterThan(P.api.moveLinkFollowers.length);
    expect(m.sessions.length).toBeGreaterThan(P.sessions.length);
    expect(planCounts(m).chat_messages).toBe(SEED_SCALES.medium.chatLines);
  });

  test("zero bulk accounts still plan every fixed login and all chat", () => {
    const z = plan(7, { ...small, streamers: 0, viewers: 0 });
    expect(z.accounts).toHaveLength(FIXED_ACCOUNTS.length);
    expect(z.api.moveLinkFollowers).toEqual([]);
    expect(z.api.grantHolders).toEqual(["viewer1"]);
    expect(z.api.movedStreamer).toBeNull();
    expect(lines(z)).toHaveLength(small.chatLines);
    expect(z.bans.find((b) => b.target === "viewer2")).toBeDefined();
  });

  test("the largest preset's counts, computed without writing", () => {
    const g = plan(7, SEED_SCALES.large);
    const c = planCounts(g);
    expect(c.users).toBe(FIXED_ACCOUNTS.length + SEED_SCALES.large.streamers + SEED_SCALES.large.viewers);
    expect(c.chat_messages).toBe(SEED_SCALES.large.chatLines);
    expect(c.streamerChannels).toBe(SEED_SCALES.large.streamers + FIXED_ACCOUNTS.filter((a) => a.streamer).length);
    expect(g.api.moveLinkFollowers).toHaveLength(20);
  });

  test("apportion sums exactly and handles zero weights", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(7, [0, 2, 0]).reduce((a, b) => a + b, 0)).toBe(7);
    expect(apportion(5, [0, 0])).toEqual([0, 0]);
    expect(apportion(0, [3])).toEqual([0]);
  });
});

describe("legal", () => {
  test("currentLegalDocuments ranks like the API: newest, final before draft, then version", () => {
    const d = (id: string, kind: string, version: string, isDraft: boolean, at: string) => ({
      id,
      kind,
      version,
      isDraft,
      requiresAcceptance: true,
      publishedAt: new Date(at),
    });
    const rows = [
      d("a", "terms", "1", true, "2026-01-01"),
      d("b", "terms", "2", false, "2026-01-01"),
      d("c", "terms", "3", false, "2027-01-01"),
      d("e", "privacy", "1", false, "2025-01-01"),
      d("f", "privacy", "2", false, "2026-02-01"),
    ];
    expect(currentLegalDocuments(rows, NOW).map((r) => r.id)).toEqual(["f", "b"]);
  });
});

describe("portability API steps", () => {
  test("expiring, revoked and active links; follows through the active one; grants; one moved bulk channel", async () => {
    const calls: { as: string; op: string; input: unknown }[] = [];
    let n = 0;
    const client = (as: string) => ({
      portability: {
        links: {
          create: async (input: unknown) => {
            calls.push({ as, op: "links.create", input });
            n++;
            return { id: `link${n}`, nonce: `nonce-${n}-0123456789abcdef`, url: "" };
          },
          revoke: async (input: unknown) => calls.push({ as, op: "links.revoke", input }),
        },
        grants: { set: async (input: unknown) => calls.push({ as, op: "grants.set", input }) },
        move: { set: async (input: unknown) => calls.push({ as, op: "move.set", input }) },
      },
      channels: { follow: async (input: unknown) => calls.push({ as, op: "follow", input }) },
    });
    const sessions = { as: async (h: string) => ({ api: { client: client(h) } }) } as unknown as SessionSource;
    const out = await seedPortability(sessions, P, new AbortController().signal, () => NOW.getTime());
    expect(out.moveLinkNonce).toBe("nonce-3-0123456789abcdef");
    const ops = calls.map((c) => `${c.as}:${c.op}`);
    expect(ops.slice(0, 4)).toEqual([
      "streamer1:links.create",
      "streamer1:links.create",
      "streamer1:links.revoke",
      "streamer1:links.create",
    ]);
    const first = calls[0]?.input as { expiresAt: string } | undefined;
    expect((first?.expiresAt ?? "") > NOW.toISOString()).toBe(true);
    expect(calls[2]?.input).toEqual({ channel: "demo_streamer1", id: "link2" });
    const follows = calls.filter((c) => c.op === "follow");
    expect(follows.map((c) => c.as)).toEqual(P.api.moveLinkFollowers);
    for (const f of follows) expect(f.input).toMatchObject({ moveLink: { nonce: out.moveLinkNonce } });
    expect(calls.filter((c) => c.op === "grants.set").map((c) => c.as)).toEqual(P.api.grantHolders);
    const moved = calls.filter((c) => c.op === "move.set");
    expect(moved.map((c) => c.as)).toEqual([P.api.movedStreamer]);
    expect(moved.some((c) => c.as === "streamer1")).toBe(false);
    expect(out.rows).toEqual({
      move_links: 3,
      follows: P.api.moveLinkFollowers.length,
      follow_portability_grants: P.api.grantHolders.length,
    });
  });

  test("a failing call names the user and the step", async () => {
    const sessions = {
      as: async () => ({
        api: { client: { portability: { links: { create: async () => Promise.reject(new Error("boom")) } } } },
      }),
    } as unknown as SessionSource;
    await expect(seedPortability(sessions, P, new AbortController().signal)).rejects.toThrow(
      /create the expiring move link as streamer1 failed: Error: boom/,
    );
  });
});
