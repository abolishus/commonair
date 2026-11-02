// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { commit, draw, newSeed } from "@commonair/draw";
import {
  ALERT_TYPES,
  BOT_BUILTIN_COMMANDS,
  GIVEAWAY_RULES,
  GOAL_TYPES,
  POLL_STATUSES,
  PREDICTION_STATUSES,
  SONG_REQUEST_STATUSES,
  USER_LEVELS,
} from "@commonair/contracts/enums";
import { dto } from "@commonair/contracts";
import { AlertTemplate, BotConfig } from "@commonair/contracts/shapes";
import { describe, expect, test } from "vite-plus/test";
import { FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_ROUTES } from "../../src/seed/routes.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import type { SeedAccountKind, SeedStore } from "../../src/seed/types.ts";
import { INTERACT_FLAGS, unit } from "../../src/seed/interact.ts";
import {
  DEMO_SEED_FULL_HINT,
  WATCH_LOOKBACK_MARGIN_MS,
  accrualRuns,
  assertWatchInLookback,
} from "../../src/seed/interact/accrual.ts";
import {
  type ApiDeps,
  type SessionSource,
  apiNow,
  interactExtra,
  mintOverlayTokens,
  overlayQuery,
  runGiveaway,
  runPrediction,
  stepRunner,
} from "../../src/seed/interact/api.ts";
import { GIVEAWAY_KEYWORD, songUrl } from "../../src/seed/interact/content.ts";
import {
  ACTORS_MAX,
  BETTOR_GRANT,
  DAY_MS,
  HOUR_MS,
  type InteractPlan,
  type Roster,
  WATCH_LOOKBACK_MS,
  WATCH_SESSIONS_PER_CHANNEL_MAX,
  mayBet,
  planCounts,
  planInteract,
} from "../../src/seed/interact/plan.ts";
import { buildRoster } from "../../src/seed/interact/roster.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const T = NOW.getTime();
const small = SEED_SCALES.small;

/** A roster shaped like seed-social's: fixed logins, bulk accounts of mixed ages, roles and bans. */
function roster(scale: SeedScale): Roster {
  const users: Roster["users"][number][] = [];
  const add = (handle: string, kind: SeedAccountKind, platformRole: string, ageDays: number) =>
    users.push({ handle, kind, platformRole, createdAt: new Date(T - ageDays * DAY_MS) });
  FIXED_ACCOUNTS.forEach((a, i) =>
    add(a.handle, a.bot ? "bot" : "fixed", a.platformRole, scale.historyDays + 1 - i / 100),
  );
  for (let i = 1; i <= scale.streamers; i++) add(bulkStreamerHandle(i), "bulk-streamer", "user", 40 + (i % 50));
  // Four in five are older than 31 days; the rest are 3 to 30 days old.
  for (let i = 1; i <= scale.viewers; i++)
    add(bulkViewerHandle(i), "bulk-viewer", "user", i % 5 === 0 ? 3 + (i % 28) : 32 + (i % 300));
  const streamers = FIXED_ACCOUNTS.filter((a) => a.streamer).map((a) => a.handle);
  for (let i = 1; i <= scale.streamers; i++) streamers.push(bulkStreamerHandle(i));
  const created = new Map(users.map((u) => [u.handle, u.createdAt.getTime()]));
  const channels = streamers.map((h) => ({ ownerHandle: h, createdAt: new Date((created.get(h) ?? T) + DAY_MS) }));
  const team = new Map<string, Set<string>>([
    ["streamer1", new Set(["chanmod", bulkViewerHandle(1)])],
    ["streamer2", new Set(["chanmod", bulkViewerHandle(2)])],
  ]);
  const banned = new Map<string, Set<string>>([
    ["streamer1", new Set(["viewer2", bulkViewerHandle(3)])],
    ["streamer2", new Set([bulkViewerHandle(4)])],
  ]);
  return { users, channels, team, banned };
}

const R = roster(small);
const plan = (seed = 7, scale: SeedScale = small, r: Roster = R) =>
  planInteract(createRng(seed).fork("interact"), scale, NOW, r);
const P = plan();

/** Every count the plan drives, direct inserts and API calls alike. */
function allCounts(p: InteractPlan): Record<string, number> {
  return {
    ...planCounts(p),
    bot_configs: p.bot.configs.length,
    live_polls: p.livePolls.length,
    live_votes: p.livePolls.reduce((n, x) => n + x.votes.length, 0),
    predictions: p.predictions.length,
    bets: p.predictions.reduce((n, x) => n + x.bets.length, 0),
    giveaways: p.giveaways.length,
    entrants: p.giveaways.reduce((n, x) => n + x.entrants.length, 0),
    grants: p.grants.length,
    actors: p.actors.length,
  };
}

const createdOf = (r: Roster, h: string) => r.users.find((u) => u.handle === h)?.createdAt.getTime() ?? Infinity;

describe("seed-interact unit", () => {
  test("claims its stub's tables, runs after social and leaves nothing pending", () => {
    expect(unit.name).toBe("interact");
    expect(unit.after).toEqual(["social"]);
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toContain("giveaway_winners");
    expect(unit.tables).toContain("loyalty_accrual_sessions");
  });

  test("names every flag it needs", () => {
    const joined = INTERACT_FLAGS.join(" ");
    for (const f of ["INTERACT_TEST_HOOKS", "DEMO_SEED_FULL", "GIVEAWAYS_ENABLED", "INTERNAL_API_SECRET"])
      expect(joined).toContain(f);
  });

  test("every SEED_ROUTES key it fills is one it publishes", () => {
    const published = new Set(["overlayChatQuery", "overlayAlertsQuery", "overlayGoalsQuery", "giveawayId"]);
    const wanted = Object.values(SEED_ROUTES).flatMap((r) => {
      const values = [r.query, ...Object.values(r.params ?? {})];
      return values.flatMap((v) => (v && "extra" in v && v.extra[0] === "interact" ? [v.extra[1]] : []));
    });
    expect(wanted.length).toBeGreaterThan(0);
    for (const k of wanted) expect(published.has(k), k).toBe(true);
  });
});

describe("planInteract determinism and scale", () => {
  test("the same seed and scale give the same plan", () => {
    expect(JSON.stringify(plan(7))).toBe(JSON.stringify(P));
  });

  test("a different seed gives different content but the same counts", () => {
    const other = plan(8);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(P));
    expect(allCounts(other)).toEqual(allCounts(P));
  });

  test("counts scale with factor", () => {
    const double = plan(7, { ...small, factor: 2 });
    const a = planCounts(P);
    const b = planCounts(double);
    for (const k of ["song_requests", "polls", "raids"]) expect(b[k], k).toBe(2 * (a[k] ?? 0));
    expect(b.goals).toBeGreaterThan(a.goals ?? 0);
    expect(double.actors.length).toBeGreaterThan(P.actors.length);
  });

  test("the largest preset is computed without writing, within its caps", () => {
    const large = SEED_SCALES.large;
    const p = plan(7, large, roster(large));
    const c = planCounts(p);
    expect(c.polls).toBe(900);
    expect(c.song_requests).toBe(1800);
    expect(p.actors.length).toBe(ACTORS_MAX + 1);
    const perChannel = new Map<string, number>();
    for (const w of p.watch) perChannel.set(w.owner, (perChannel.get(w.owner) ?? 0) + 1);
    for (const n of perChannel.values()) expect(n).toBeLessThanOrEqual(WATCH_SESSIONS_PER_CHANNEL_MAX + 1);
    expect(accrualRuns(p.watch.length)).toBeLessThan(10);
  });

  test("zero bulk accounts: viewer1 alone still bets, votes and wins", () => {
    const empty = { ...small, streamers: 0, viewers: 0 };
    const p = plan(7, empty, roster(empty));
    expect(p.actors).toEqual(["viewer1"]);
    expect(p.raids.every((r) => r.from === "streamer1")).toBe(true);
    const resolved = p.predictions.find((x) => x.final === "resolved");
    expect(resolved?.bets.map((b) => b.bettor)).toEqual(["viewer1"]);
    expect(resolved?.winner).toBe(resolved?.bets[0]?.outcome);
    const drawn = p.giveaways.find((g) => g.final === "drawn");
    expect(drawn?.entrants).toEqual(["viewer1"]);
    expect(drawn?.winnerCount).toBe(1);
    expect(p.watch.map((w) => w.viewer)).toEqual(["viewer1"]);
  });
});

describe("fixed logins get what their purpose says", () => {
  test("streamer1: the full bot, linked to bot1, with renamed points and song requests", () => {
    const c = P.bot.configs.find((x) => x.owner === "streamer1");
    expect(c?.botHandle).toBe("bot1");
    expect(c?.enabled).toBe(true);
    expect(BotConfig.parse(c?.config)).toEqual(c?.config);
    expect(c?.config.songRequests.enabled).toBe(true);
    expect(c?.config.displayName).toBe(FIXED_ACCOUNTS.find((a) => a.handle === "bot1")?.displayName);
    const mine = P.bot.commands.filter((x) => x.owner === "streamer1");
    expect(mine.length).toBeGreaterThanOrEqual(12);
    expect(P.bot.timers.filter((x) => x.owner === "streamer1").length).toBeGreaterThanOrEqual(3);
    expect(P.bot.variables.filter((x) => x.owner === "streamer1").length).toBeGreaterThanOrEqual(3);
  });

  test("streamer2: a minimal bot, created by the API", () => {
    const c = P.bot.configs.find((x) => x.owner === "streamer2");
    expect(c?.botHandle).toBeNull();
    expect(c?.config).toEqual(BotConfig.parse({}));
    expect(P.bot.commands.filter((x) => x.owner === "streamer2").length).toBeLessThanOrEqual(3);
  });

  test("viewer1: a large balance, watch time, bets, an extra-vote redemption and a giveaway entry", () => {
    const granted = P.grants.filter((g) => g.user === "viewer1").reduce((n, g) => n + g.delta, 0);
    expect(granted).toBeGreaterThanOrEqual(25_000);
    expect(P.watch.some((w) => w.viewer === "viewer1" && w.owner === "streamer1")).toBe(true);
    expect(P.predictions.filter((p) => p.bets.some((b) => b.bettor === "viewer1")).length).toBeGreaterThanOrEqual(2);
    const s1Poll = P.livePolls.find((p) => p.owner === "streamer1");
    expect(s1Poll?.votes.find((v) => v.voter === "viewer1")?.extraVotes).toBeGreaterThan(0);
    expect(P.giveaways.find((g) => g.final === "drawn")?.entrants).toContain("viewer1");
  });

  test("streamer2 receives raids and streamer1 sends some; the live raid goes streamer1 → streamer2", () => {
    expect(P.raids.filter((r) => r.to === "streamer2").length).toBe(5);
    expect(P.raids.filter((r) => r.from === "streamer1").length).toBe(2);
    expect(P.liveRaid).toEqual({ from: "streamer1", to: "streamer2" });
  });

  test("newbie, viewer2 and the staff logins stay out of it", () => {
    const touched = new Set([
      ...P.actors,
      ...P.watch.map((w) => w.viewer),
      ...P.grants.map((g) => g.user),
      ...P.songRequests.map((s) => s.requester),
      ...P.polls.flatMap((p) => p.votes.map((v) => v.voter)),
    ]);
    for (const h of ["newbie", "viewer2", "admin", "treasurer", "legal", "mod", "banned"])
      expect(touched.has(h), h).toBe(false);
  });
});

describe("every state at small", () => {
  test("polls: every status (active through the API), and some with no votes", () => {
    const statuses = new Set<string>([...P.polls.map((p) => p.status), ...P.livePolls.map(() => "active")]);
    expect([...statuses].sort()).toEqual([...POLL_STATUSES].sort());
    expect(P.polls.some((p) => p.votes.length === 0)).toBe(true);
    expect(P.polls.some((p) => p.votes.length > 0)).toBe(true);
    for (const p of P.polls) {
      expect(p.endsAt.getTime()).toBe(p.startedAt.getTime() + p.durationSeconds * 1000);
      for (const v of p.votes) {
        expect(v.choice).toBeLessThan(p.choices.length);
        expect(v.castAt.getTime()).toBeGreaterThanOrEqual(p.startedAt.getTime());
        expect(v.castAt.getTime()).toBeLessThanOrEqual(p.endedAt.getTime());
      }
    }
  });

  test("predictions: open, locked, resolved and canceled", () => {
    expect(P.predictions.map((p) => p.final).sort()).toEqual([...PREDICTION_STATUSES].sort());
    // At most one open (active or locked) prediction per channel.
    for (const owner of ["streamer1", "streamer2"])
      expect(
        P.predictions.filter((p) => p.owner === owner && (p.final === "active" || p.final === "locked")).length,
      ).toBe(1);
    const resolved = P.predictions.find((p) => p.final === "resolved");
    expect(resolved?.bets.some((b) => b.outcome === resolved.winner)).toBe(true);
    for (const p of P.predictions) {
      expect(p.title.length).toBeLessThanOrEqual(45);
      expect(p.outcomes.length).toBeGreaterThanOrEqual(2);
      expect(p.bets.length).toBeGreaterThan(0);
    }
  });

  test("song requests, raids, goals, alerts and giveaways cover every state", () => {
    expect(new Set(P.songRequests.map((s) => s.status))).toEqual(new Set(SONG_REQUEST_STATUSES));
    expect(new Set(P.raids.map((r) => r.status))).toEqual(new Set(["completed", "canceled"]));
    expect(P.raids.every((r) => (r.status === "canceled") === (r.cancelReason !== null))).toBe(true);
    for (const type of GOAL_TYPES) {
      const s1 = P.goals.filter((g) => g.owner === "streamer1" && g.type === type);
      expect(s1.filter((g) => g.endedAt === null)).toHaveLength(1);
      expect(s1.some((g) => g.endedAt !== null && g.current >= g.target)).toBe(true);
      expect(s1.some((g) => g.endedAt === null && g.current < g.target)).toBe(true);
    }
    expect(P.alerts.filter((a) => a.owner === "streamer1").map((a) => a.type)).toEqual([...ALERT_TYPES]);
    for (const a of P.alerts)
      expect(AlertTemplate.parse({ message: a.message, animation: a.animation }).message).toBe(a.message);
    expect(new Set(P.giveaways.map((g) => g.final))).toEqual(new Set(["drawn", "closed"]));
  });

  test("song links are .invalid hosts", () => {
    for (const s of P.songRequests) expect(new URL(s.url).hostname.endsWith(".invalid")).toBe(true);
    expect(songUrl("x", 1)).toBe("https://tracks.demo-seed.invalid/x?take=1");
  });
});

describe("bot commands", () => {
  test("every user level the contract defines, counters, variables, costs, cooldowns and a disabled one", () => {
    const s1 = P.bot.commands.filter((c) => c.owner === "streamer1");
    expect(new Set(s1.map((c) => c.userLevel))).toEqual(new Set(USER_LEVELS));
    expect(s1.some((c) => c.response.includes("${count}"))).toBe(true);
    expect(s1.some((c) => c.response.includes("${var:"))).toBe(true);
    expect(s1.some((c) => c.costPoints > 0)).toBe(true);
    expect(s1.some((c) => c.cooldownSeconds >= 60)).toBe(true);
    expect(s1.some((c) => c.aliases.length > 0)).toBe(true);
    expect(s1.some((c) => !c.enabled)).toBe(true);
    const vars = new Set(P.bot.variables.filter((v) => v.owner === "streamer1").map((v) => v.name));
    for (const c of s1)
      for (const m of c.response.matchAll(/\$\{var:([a-z0-9_]+)\}/g)) expect(vars.has(m[1] ?? ""), m[1]).toBe(true);
  });

  test("every command is valid for the contract and no name or alias is a built-in", () => {
    const names = new Set<string>();
    for (const c of P.bot.commands) {
      const parsed = dto.BotCommand.parse({ ...c, id: "0190f3c4-0000-7000-8000-000000000000" });
      expect(parsed.name).toBe(c.name);
      for (const n of [c.name, ...c.aliases]) {
        expect((BOT_BUILTIN_COMMANDS as readonly string[]).includes(n), n).toBe(false);
        expect(names.has(`${c.owner}:${n}`), n).toBe(false);
        names.add(`${c.owner}:${n}`);
      }
    }
    for (const t of P.bot.timers) dto.BotTimer.parse({ ...t, id: "0190f3c4-0000-7000-8000-000000000000" });
    for (const v of P.bot.variables) expect(v.name).toMatch(/^[a-z0-9_]{1,30}$/);
  });
});

describe("bettors, points and giveaways", () => {
  test("no planned bettor is the owner, a moderator, an editor, banned there or staff", () => {
    for (const p of P.predictions)
      for (const b of p.bets) {
        expect(b.bettor).not.toBe(p.owner);
        expect(R.team.get(p.owner)?.has(b.bettor) ?? false, b.bettor).toBe(false);
        expect(R.banned.get(p.owner)?.has(b.bettor) ?? false, b.bettor).toBe(false);
        expect(R.users.find((u) => u.handle === b.bettor)?.platformRole).toBe("user");
        expect(mayBet(R, p.owner, b.bettor)).toBe(true);
      }
    expect(mayBet(R, "streamer1", "chanmod")).toBe(false);
    expect(mayBet(R, "streamer1", "admin")).toBe(false);
    expect(mayBet(R, "streamer1", "bot1")).toBe(false);
  });

  test("every bettor holds more granted points on that channel than all their bets there", () => {
    const granted = new Map<string, number>();
    for (const g of P.grants)
      granted.set(`${g.owner}\0${g.user}`, (granted.get(`${g.owner}\0${g.user}`) ?? 0) + g.delta);
    const staked = new Map<string, number>();
    for (const p of P.predictions)
      for (const b of p.bets)
        staked.set(`${p.owner}\0${b.bettor}`, (staked.get(`${p.owner}\0${b.bettor}`) ?? 0) + b.points);
    for (const p of P.livePolls)
      for (const v of p.votes)
        staked.set(
          `${p.owner}\0${v.voter}`,
          (staked.get(`${p.owner}\0${v.voter}`) ?? 0) + v.extraVotes * p.pointsPerExtraVote,
        );
    for (const [k, n] of staked) expect(granted.get(k) ?? 0, k).toBeGreaterThanOrEqual(n);
    expect(P.grants.some((g) => g.reason === "penalty" && g.delta < 0)).toBe(true);
    expect(
      P.grants.filter((g) => g.reason === "reward" && g.user !== "viewer1").every((g) => g.delta === BETTOR_GRANT),
    ).toBe(true);
  });

  test("a drawn giveaway has at least winnerCount entrants, unique and allowed to enter", () => {
    for (const g of P.giveaways) {
      expect(new Set(g.entrants).size).toBe(g.entrants.length);
      expect(g.winnerCount).toBeGreaterThanOrEqual(1);
      expect(g.winnerCount).toBeLessThanOrEqual(GIVEAWAY_RULES.maxWinners);
      for (const e of g.entrants) expect(R.banned.get(g.owner)?.has(e) ?? false).toBe(false);
    }
    const drawn = P.giveaways.find((g) => g.final === "drawn");
    expect(drawn?.entrants.length).toBeGreaterThanOrEqual(drawn?.winnerCount ?? Infinity);
    expect(drawn?.keyword).toBe(GIVEAWAY_KEYWORD);
    expect(GIVEAWAY_KEYWORD).toMatch(/^!?[A-Za-z0-9]{2,20}$/);
  });
});

describe("time rules", () => {
  test("no backdated row predates the accounts it references or leaves the window", () => {
    const lo = T - small.historyDays * DAY_MS;
    for (const s of P.songRequests) {
      expect(s.createdAt.getTime()).toBeGreaterThanOrEqual(createdOf(R, s.requester) + HOUR_MS);
      expect(s.createdAt.getTime()).toBeLessThan(T);
    }
    for (const p of P.polls) {
      expect(p.startedAt.getTime()).toBeGreaterThanOrEqual(Math.max(lo, createdOf(R, p.owner)));
      for (const v of p.votes) expect(v.castAt.getTime()).toBeGreaterThanOrEqual(createdOf(R, v.voter) + HOUR_MS);
    }
    for (const r of P.raids) {
      expect(r.createdAt.getTime()).toBeGreaterThanOrEqual(Math.max(createdOf(R, r.from), createdOf(R, r.to)));
      expect(r.createdAt.getTime()).toBeLessThan(T - HOUR_MS);
    }
    for (const g of P.goals) {
      expect(g.startedAt.getTime()).toBeGreaterThanOrEqual(createdOf(R, g.owner));
      expect(g.endedAt === null || g.endedAt.getTime() > g.startedAt.getTime()).toBe(true);
    }
    for (const c of P.bot.commands) expect(c.createdAt.getTime()).toBeGreaterThan(createdOf(R, c.owner));
    for (const w of P.watch) {
      expect(w.startedAt.getTime()).toBeGreaterThan(createdOf(R, w.viewer));
      expect(w.endedAt.getTime() - w.startedAt.getTime()).toBe(w.watchSeconds * 1000);
      // Scored inside the worker's look-back and never in the future.
      expect(w.scoredAt.getTime()).toBeGreaterThanOrEqual(w.endedAt.getTime());
      expect(w.scoredAt.getTime()).toBeLessThan(T);
      expect(T - w.scoredAt.getTime()).toBeLessThan(WATCH_LOOKBACK_MS);
      expect(w.viewer).not.toBe(w.owner);
    }
  });
});

describe("watch sessions and the worker's 6 h look-back", () => {
  // The seed run started at NOW; seed-social at `large` can take hours before interact plans.
  const late = new Date(T + 5 * HOUR_MS);
  const anchored = planInteract(createRng(7).fork("interact"), small, NOW, R, late);

  test("watchAt moves only the watch timestamps: same viewers, channels, lengths and other rows", () => {
    expect(anchored.watch.map((w) => [w.owner, w.viewer, w.watchSeconds])).toEqual(
      P.watch.map((w) => [w.owner, w.viewer, w.watchSeconds]),
    );
    expect(planCounts(anchored)).toEqual(planCounts(P));
    expect(anchored.polls).toEqual(P.polls);
    expect(anchored.raids).toEqual(P.raids);
    for (const w of anchored.watch) {
      expect(w.scoredAt.getTime()).toBeLessThan(late.getTime());
      expect(late.getTime() - w.scoredAt.getTime()).toBeLessThan(WATCH_LOOKBACK_MS - WATCH_LOOKBACK_MARGIN_MS);
    }
  });

  test("sessions anchored at the run's start are stale 5 h later, and the check says so (not DEMO_SEED_FULL)", () => {
    const scored = P.watch.map((w) => w.scoredAt);
    expect(() => assertWatchInLookback(scored, late.getTime())).toThrow(/scoring look-back/);
    expect(() => assertWatchInLookback(scored, late.getTime())).not.toThrow(DEMO_SEED_FULL_HINT);
    expect(() =>
      assertWatchInLookback(
        anchored.watch.map((w) => w.scoredAt),
        late.getTime(),
      ),
    ).not.toThrow();
    expect(() => assertWatchInLookback(scored, T)).not.toThrow();
    expect(() => assertWatchInLookback([], late.getTime())).not.toThrow();
  });

  test("the boundary: at the look-back less the margin it passes, a millisecond later it fails", () => {
    const d = new Date(T);
    const edge = T + WATCH_LOOKBACK_MS - WATCH_LOOKBACK_MARGIN_MS;
    expect(() => assertWatchInLookback([d], edge)).not.toThrow();
    expect(() => assertWatchInLookback([d], edge + 1)).toThrow(/scoring look-back/);
  });

  test("a watchAt earlier than now never moves sessions before the run", () => {
    const early = planInteract(createRng(7).fork("interact"), small, NOW, R, new Date(T - DAY_MS));
    expect(early.watch.map((w) => w.scoredAt)).toEqual(P.watch.map((w) => w.scoredAt));
  });
});

describe("buildRoster", () => {
  const store: SeedStore = {
    users: [
      { id: "u1", handle: "streamer1", username: "demo_streamer1", email: "", kind: "fixed", platformRole: "user" },
      { id: "u2", handle: "chanmod", username: "demo_chanmod", email: "", kind: "fixed", platformRole: "user" },
      { id: "u3", handle: "v00001", username: "demo_v00001", email: "", kind: "bulk-viewer", platformRole: "user" },
    ],
    channels: [{ id: "c1", ownerId: "u1", ownerHandle: "streamer1", slug: "demo_streamer1" }],
    extra: {},
  };
  const d = new Date(T - DAY_MS);
  const rows = {
    users: [
      { id: "u1", createdAt: d },
      { id: "u2", createdAt: d },
      { id: "u3", createdAt: d },
    ],
    channels: [{ id: "c1", createdAt: d }],
    roles: [
      { channelId: "c1", userId: "u2", role: "moderator" },
      { channelId: "c1", userId: "u3", role: "vip" },
    ],
    bans: [
      { channelId: "c1", userId: "u3", expiresAt: new Date(T - 1) },
      { channelId: "c1", userId: "u2", expiresAt: null },
    ],
  };

  test("moderators and editors are the team, VIPs are not; only bans in force count", () => {
    const r = buildRoster(store, rows, NOW);
    expect([...(r.team.get("streamer1") ?? [])]).toEqual(["chanmod"]);
    expect([...(r.banned.get("streamer1") ?? [])]).toEqual(["chanmod"]);
    expect(r.users.map((u) => u.handle)).toEqual(["streamer1", "chanmod", "v00001"]);
    expect(r.channels[0]?.createdAt).toEqual(d);
  });

  test("a store user missing from the database fails loudly", () => {
    expect(() => buildRoster(store, { ...rows, users: rows.users.slice(1) }, NOW)).toThrow(/streamer1/);
  });
});

/** A fake signed-in client per handle, recording the calls. */
function fakeSessions(client: (handle: string) => unknown): SessionSource {
  return {
    as: (handle: string) =>
      Promise.resolve({ username: `demo_${handle}`, api: { client: client(handle) } } as unknown as Awaited<
        ReturnType<SessionSource["as"]>
      >),
  };
}

const deps = (sessions: SessionSource): ApiDeps => ({
  sessions,
  slugs: new Map([
    ["streamer1", "demo_streamer1"],
    ["streamer2", "demo_streamer2"],
  ]),
  step: stepRunner(new AbortController().signal),
});

describe("API writers (with fake clients)", () => {
  test("overlay queries are the page URLs' exact query strings, with the raw token", async () => {
    const token = "ov_abc/+=";
    const q = `?token=${encodeURIComponent(token)}`;
    let minted = 0;
    const d = deps(
      fakeSessions(() => ({
        interact: {
          overlays: {
            token: () => {
              minted++;
              return Promise.resolve({
                token,
                chatUrl: `http://localhost:3000/overlay/chat${q}`,
                alertsUrl: `http://localhost:3000/overlay/alerts${q}`,
                goalsUrl: `http://localhost:3000/overlay/goals${q}`,
                expiresAt: null,
              });
            },
          },
        },
      })),
    );
    const out = await mintOverlayTokens(d, "streamer1", 2);
    expect(minted).toBe(2);
    expect(Object.keys(out).sort()).toEqual(["overlayAlertsQuery", "overlayChatQuery", "overlayGoalsQuery"]);
    for (const v of Object.values(out)) {
      expect(v.startsWith("?")).toBe(false);
      // The overlay pages read `token` from the query (apps/web/src/lib/overlay-page.ts).
      expect(new URLSearchParams(v).get("token")).toBe(token);
    }
    expect(overlayQuery("http://x.test/overlay/chat?token=a")).toBe("token=a");
  });

  test("giveawayId is published from the drawn giveaway, and a run with none drawn fails", () => {
    const overlay = { overlayChatQuery: "token=a", overlayAlertsQuery: "token=a", overlayGoalsQuery: "token=a" };
    const extra = interactExtra(overlay, [
      { id: "g-closed", status: "closed", entries: 3, winners: 0 },
      { id: "g-drawn", status: "drawn", entries: 7, winners: 2 },
    ]);
    expect(extra.giveawayId).toBe("g-drawn");
    expect(Object.keys(extra).sort()).toEqual([
      "giveawayId",
      "overlayAlertsQuery",
      "overlayChatQuery",
      "overlayGoalsQuery",
    ]);
    expect(() => interactExtra(overlay, [{ id: "g", status: "closed", entries: 1, winners: 0 }])).toThrow(/giveawayId/);
  });

  test("runGiveaway enters every entrant, draws, and checks the draw re-runs", async () => {
    const g = P.giveaways.find((x) => x.final === "drawn");
    if (!g) throw new Error("no drawn giveaway planned");
    const seed = newSeed();
    const entries = g.entrants.map((_, i) => `p${String(i).padStart(3, "0")}`);
    const order = await draw(seed, entries, g.winnerCount);
    const winners = order.map((index, i) => ({
      rank: i + 1,
      index,
      pseudonym: entries[index] ?? "",
      username: null,
    }));
    const entered: string[] = [];
    const view = (status: string) => ({ id: "g1", status, entries: entered.length, winners });
    const api = {
      open: () => Promise.resolve(view("open")),
      close: () => Promise.resolve(view("closed")),
      draw: () => Promise.resolve(view("drawn")),
      verify: async () => ({
        status: "drawn",
        seedCommitment: await commit(seed),
        seed,
        entries,
        winnerCount: g.winnerCount,
        winners,
      }),
    };
    const d = deps(
      fakeSessions((h) => ({
        interact: {
          giveaways: {
            ...api,
            enter: () => {
              entered.push(h);
              return Promise.resolve(view("open"));
            },
          },
        },
      })),
    );
    const r = await runGiveaway(d, g);
    expect(entered).toEqual(g.entrants);
    expect(r).toEqual({ id: "g1", status: "drawn", entries: g.entrants.length, winners: g.winnerCount });

    // A draw that does not re-run fails the step.
    api.verify = async () => ({
      status: "drawn",
      seedCommitment: await commit(newSeed()),
      seed,
      entries,
      winnerCount: g.winnerCount,
      winners,
    });
    entered.length = 0;
    await expect(runGiveaway(d, g)).rejects.toThrow(/does not match/);
  });

  test("runPrediction: live bets carry a playhead behind live, offline bets none, and the final state is checked", async () => {
    const calls: { who: string; mediaTs: string | null }[] = [];
    const started = new Date(T).toISOString();
    const make = (final: string) => (h: string) => ({
      interact: {
        predictions: {
          create: () =>
            Promise.resolve({
              id: "p1",
              status: "active",
              startedAt: started,
              outcomes: [{ id: "o1" }, { id: "o2" }, { id: "o3" }],
            }),
          bet: (i: { mediaTs: string | null }) => {
            calls.push({ who: h, mediaTs: i.mediaTs });
            return Promise.resolve({});
          },
          lock: () => Promise.resolve({ status: "locked" }),
          resolve: () => Promise.resolve({ status: final }),
          cancel: () => Promise.resolve({ status: "canceled" }),
        },
      },
    });
    const live = P.predictions.find((p) => p.final === "resolved");
    const offline = P.predictions.find((p) => p.final === "active");
    if (!live || !offline) throw new Error("predictions missing");
    const r = await runPrediction(deps(fakeSessions(make("resolved"))), live);
    expect(r.status).toBe("resolved");
    expect(calls).toHaveLength(live.bets.length);
    for (const c of calls) {
      const ts = Date.parse(c.mediaTs ?? "");
      expect(ts).toBeLessThan(T);
      expect(T - ts).toBeLessThan(30_000);
    }
    calls.length = 0;
    await runPrediction(deps(fakeSessions(make("resolved"))), offline);
    expect(calls.every((c) => c.mediaTs === null)).toBe(true);
    await expect(runPrediction(deps(fakeSessions(make("canceled"))), live)).rejects.toThrow(/plan wants resolved/);
  });

  test("apiNow follows the API's stamp, never earlier than it", () => {
    expect(apiNow("2026-11-01T12:00:00.000Z", 1_000, 3_500).toISOString()).toBe("2026-11-01T12:00:02.500Z");
    expect(apiNow("2026-11-01T12:00:00.000Z", 1_000, 500).toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });

  test("a failing call names the user and the step", async () => {
    const step = stepRunner(new AbortController().signal);
    await expect(step("viewer1", "bet 5", () => Promise.reject(new Error("CONFLICT")))).rejects.toThrow(
      "seed-interact: bet 5 as viewer1 failed: CONFLICT",
    );
  });
});

describe("accrualRuns", () => {
  test("enough worker runs for every pair, plus slack", () => {
    expect(accrualRuns(1)).toBe(4);
    expect(accrualRuns(5_000)).toBe(4);
    expect(accrualRuns(5_001)).toBe(5);
  });
});
