// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-interact's plan: every row and API call as a pure spec (who, what, when, in which state),
 * from the unit's PRNG, the scale and the roster seed-social left. The writers in `write.ts` (plain
 * tables) and `api.ts` (protected tables and the API-only steps) carry it out. Nothing here touches
 * the database, so the counts at any scale can be checked without writing.
 *
 * Time rules: plain rows are backdated inside `historyDays`, never before the accounts they
 * reference (an hour after the newest one); API rows are real-time.
 */
import { BotConfig } from "@commonair/contracts/shapes";
import { ALERT_TYPES, GOAL_TYPES, SONG_REQUEST_STATUSES } from "@commonair/contracts/enums";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeedAccountKind } from "../types.ts";
import {
  ALERT_TEMPLATES,
  type AlertType,
  type CommandDef,
  GIVEAWAY_KEYWORD,
  GIVEAWAY_PRIZES,
  GOAL_TARGETS,
  GOAL_TITLES,
  type GoalType,
  POLL_QUESTIONS,
  PREDICTION_QUESTIONS,
  SONG_TITLES,
  STREAMER1_COMMANDS,
  STREAMER1_POINTS_NAME,
  STREAMER1_TIMERS,
  STREAMER1_VARIABLES,
  STREAMER2_COMMANDS,
  STREAMER2_TIMERS,
  STREAMER2_VARIABLES,
  songUrl,
} from "./content.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The worker's accrual reads sessions scored this recently (`SCORED_LOOKBACK_MS`, 6 h). */
export const WATCH_LOOKBACK_MS = 6 * HOUR_MS;
/** Sessions per channel at most, so `large` stays within a few accrual runs (5 000 pairs each). */
export const WATCH_SESSIONS_PER_CHANNEL_MAX = 2_000;
/** Signed-in viewers who bet, vote and enter giveaways (on top of viewer1). */
export const ACTORS_MAX = 40;
/** Points each bettor is granted on the channel they bet on (more than all their bets there). */
export const BETTOR_GRANT = 1_000;
export const VIEWER1_GRANT = { streamer1: 25_000, streamer2: 5_000 } as const;
/** Points per extra poll vote on streamer1's live poll (viewer1 buys some: a redemption). */
export const EXTRA_VOTE_POINTS = 50;
export const LIVE_POLL_SECONDS = 1_800;
export const PREDICTION_WINDOW_SECONDS = 600;
/** The open prediction's window: the longest the API allows, so it stays open for testers. */
export const OPEN_PREDICTION_WINDOW_SECONDS = 1_800;

export interface RosterUser {
  handle: string;
  kind: SeedAccountKind;
  platformRole: string;
  createdAt: Date;
}

export interface RosterChannel {
  ownerHandle: string;
  createdAt: Date;
}

/** What the plan needs to know about seed-social's rows (read from the store and the database). */
export interface Roster {
  users: readonly RosterUser[];
  /** The streamers' channels (`store.channels`). */
  channels: readonly RosterChannel[];
  /** Channel owner handle → moderators and editors there (the prediction team, who never bet). */
  team: ReadonlyMap<string, ReadonlySet<string>>;
  /** Channel owner handle → accounts with a ban or timeout in force there. */
  banned: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface BotConfigSpec {
  owner: string;
  enabled: boolean;
  config: BotConfig;
  /**
   * The bot account to link (seed-social's `bot1`): the row is inserted with it, then saved through
   * the API so the chat service reloads it. Null: the API's first enable creates the bot account.
   */
  botHandle: string | null;
}

export interface CommandSpec extends CommandDef {
  owner: string;
  useCount: number;
  createdAt: Date;
}

export interface TimerSpec {
  owner: string;
  name: string;
  message: string;
  intervalMinutes: number;
  minChatLines: number;
  enabled: boolean;
  lastFiredAt: Date | null;
}

export interface VariableSpec {
  owner: string;
  name: string;
  value: string;
  updatedAt: Date;
}

export type SongStatus = (typeof SONG_REQUEST_STATUSES)[number];

export interface SongRequestSpec {
  owner: string;
  requester: string;
  url: string;
  status: SongStatus;
  createdAt: Date;
}

export type PollEndStatus = "completed" | "terminated" | "archived";

export interface PollVoteSpec {
  voter: string;
  choice: number;
  castAt: Date;
}

/** An ended poll from the past (direct insert). */
export interface PollSpec {
  owner: string;
  title: string;
  choices: string[];
  status: PollEndStatus;
  durationSeconds: number;
  startedAt: Date;
  endsAt: Date;
  endedAt: Date;
  votes: PollVoteSpec[];
}

/** A poll started now through the API, still active when the seed ends. */
export interface LivePollSpec {
  owner: string;
  title: string;
  choices: string[];
  durationSeconds: number;
  pointsPerExtraVote: number;
  votes: { voter: string; choice: number; extraVotes: number }[];
}

export type PredictionFinal = "active" | "locked" | "resolved" | "canceled";

export interface BetSpec {
  bettor: string;
  outcome: number;
  points: number;
}

/** A prediction run through the API: created, bet on, then left in `final`. */
export interface PredictionSpec {
  owner: string;
  title: string;
  outcomes: string[];
  windowSeconds: number;
  final: PredictionFinal;
  /** Outcome index that wins (`resolved` only; always has a bet on it). */
  winner: number | null;
  /** Whether it runs inside the live window (its bets carry a playhead). */
  live: boolean;
  bets: BetSpec[];
}

export type GiveawayFinal = "drawn" | "closed";

export interface GiveawaySpec {
  owner: string;
  title: string;
  prize: string;
  keyword: string | null;
  winnerCount: number;
  final: GiveawayFinal;
  entrants: string[];
}

export type RaidCancel = "owner" | "target_offline";

/** A past raid (direct insert). */
export interface RaidSpec {
  from: string;
  to: string;
  status: "completed" | "canceled";
  cancelReason: RaidCancel | null;
  viewerCount: number;
  createdAt: Date;
}

export interface GoalSpec {
  owner: string;
  type: GoalType;
  title: string;
  target: number;
  current: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface AlertSpec {
  owner: string;
  type: AlertType;
  enabled: boolean;
  message: string;
  animation: "fade" | "slide" | "none";
  minAmountCents: number;
  durationMs: number;
}

/** A finished, verified, signed-in playback session: the input points accrual credits. */
export interface WatchSpec {
  owner: string;
  viewer: string;
  watchSeconds: number;
  startedAt: Date;
  endedAt: Date;
  scoredAt: Date;
}

export interface GrantSpec {
  owner: string;
  user: string;
  delta: number;
  reason: "reward" | "correction" | "penalty";
}

export interface InteractPlan {
  now: Date;
  bot: { configs: BotConfigSpec[]; commands: CommandSpec[]; timers: TimerSpec[]; variables: VariableSpec[] };
  songRequests: SongRequestSpec[];
  polls: PollSpec[];
  livePolls: LivePollSpec[];
  predictions: PredictionSpec[];
  giveaways: GiveawaySpec[];
  raids: RaidSpec[];
  liveRaid: { from: string; to: string } | null;
  goals: GoalSpec[];
  alerts: AlertSpec[];
  watch: WatchSpec[];
  grants: GrantSpec[];
  /** Viewers signed in for the API steps (viewer1 first). */
  actors: string[];
  /** Overlay tokens minted for streamer1 (each new one revokes the last; the last stays live). */
  overlayMints: number;
}

const at = (ms: number) => new Date(ms);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const between = (r: Rng, lo: number, hi: number) => (hi <= lo ? lo : lo + Math.floor(r.next() * (hi - lo)));

/** Who may take part on `owner`'s channel: not the owner, not its team, not banned there. */
function participates(roster: Roster, owner: string, handle: string): boolean {
  return (
    handle !== owner &&
    !(roster.team.get(owner)?.has(handle) ?? false) &&
    !(roster.banned.get(owner)?.has(handle) ?? false)
  );
}

/** Users who may bet on `owner`'s predictions: plain users outside the channel's team. Pure. */
export function mayBet(roster: Roster, owner: string, handle: string): boolean {
  const u = roster.users.find((x) => x.handle === handle);
  return u !== undefined && u.platformRole === "user" && u.kind !== "bot" && participates(roster, owner, handle);
}

function planBot(r: Rng, now: number, created: (h: string) => number): InteractPlan["bot"] {
  const configs: BotConfigSpec[] = [
    {
      owner: "streamer1",
      enabled: true,
      botHandle: "bot1",
      config: BotConfig.parse({
        displayName: "Pixel Helper",
        filters: {
          spam: { enabled: true, maxRepeatedChars: 10 },
          links: { enabled: true, allowSubscribers: true, allowlist: ["gallery.demo-seed.invalid"] },
          caps: { enabled: true, minLength: 15, maxRatio: 0.7 },
          timeoutSeconds: 30,
        },
        loyalty: { enabled: true, pointsName: STREAMER1_POINTS_NAME },
        songRequests: { enabled: true, maxQueue: 50 },
      }),
    },
    // Minimal: the defaults, saved through the API, which creates the channel's own bot account.
    { owner: "streamer2", enabled: true, botHandle: null, config: BotConfig.parse({}) },
  ];
  const commands: CommandSpec[] = [];
  const timers: TimerSpec[] = [];
  const variables: VariableSpec[] = [];
  const sets = [
    { owner: "streamer1", cmds: STREAMER1_COMMANDS, tms: STREAMER1_TIMERS, vars: STREAMER1_VARIABLES },
    { owner: "streamer2", cmds: STREAMER2_COMMANDS, tms: STREAMER2_TIMERS, vars: STREAMER2_VARIABLES },
  ];
  for (const s of sets) {
    const lo = created(s.owner) + DAY_MS;
    for (const c of s.cmds)
      commands.push({
        ...c,
        aliases: [...c.aliases],
        owner: s.owner,
        useCount: c.enabled ? r.int(0, 400) : r.int(0, 20),
        createdAt: at(between(r, lo, now - DAY_MS)),
      });
    for (const t of s.tms)
      timers.push({
        ...t,
        owner: s.owner,
        lastFiredAt: t.enabled ? at(between(r, now - 3 * DAY_MS, now - HOUR_MS)) : null,
      });
    for (const [name, value] of Object.entries(s.vars))
      variables.push({ owner: s.owner, name, value, updatedAt: at(between(r, lo, now - HOUR_MS)) });
  }
  return { configs, commands, timers, variables };
}

/** streamer1's song queue: queued today, played and skipped over the last weeks. */
function planSongs(r: Rng, scale: SeedScale, now: number, pool: readonly RosterUser[]): SongRequestSpec[] {
  const out: SongRequestSpec[] = [];
  const f = scale.factor;
  const counts: Record<SongStatus, number> = { queued: 5 * f, played: 10 * f, skipped: 3 * f };
  const since = now - Math.min(28, scale.historyDays) * DAY_MS;
  // Requesters old enough for every slot of their status, so the counts never depend on the draw.
  const queuedBy = pool.filter((u) => u.createdAt.getTime() + HOUR_MS <= now - 2 * HOUR_MS);
  const pastBy = pool.filter((u) => u.createdAt.getTime() + HOUR_MS <= since);
  let n = 0;
  for (const status of SONG_REQUEST_STATUSES) {
    const who = status === "queued" ? queuedBy : pastBy;
    if (who.length === 0) continue;
    for (let i = 0; i < counts[status]; i++) {
      const when =
        status === "queued" ? between(r, now - 2 * HOUR_MS, now - MINUTE_MS) : between(r, since, now - 3 * HOUR_MS);
      n++;
      out.push({
        owner: "streamer1",
        requester: r.pick(who).handle,
        url: songUrl(r.pick(SONG_TITLES), n),
        status,
        createdAt: at(when),
      });
    }
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const POLL_DURATIONS = [60, 120, 300, 600] as const;

/** Past polls: every end status, and every third one with no votes. */
function planPolls(
  r: Rng,
  scale: SeedScale,
  now: number,
  roster: Roster,
  voters: readonly RosterUser[],
  created: (h: string) => number,
): PollSpec[] {
  const out: PollSpec[] = [];
  const f = scale.factor;
  const per: [string, number][] = [
    ["streamer1", 6 * f],
    ["streamer2", 3 * f],
  ];
  for (const [owner, n] of per) {
    if (!roster.channels.some((c) => c.ownerHandle === owner)) continue;
    const lo = Math.max(created(owner) + DAY_MS, now - scale.historyDays * DAY_MS);
    // Voters are drawn first; the poll then starts after the newest of them (an hour's margin).
    const eligible = voters.filter(
      (u) => participates(roster, owner, u.handle) && u.createdAt.getTime() + HOUR_MS <= now - 2 * DAY_MS,
    );
    for (let i = 0; i < n; i++) {
      const q = r.pick(POLL_QUESTIONS);
      const choices = q.choices.slice(0, r.int(2, Math.min(5, q.choices.length)));
      const durationSeconds = r.pick(POLL_DURATIONS);
      const silent = i % 3 === 2;
      const chosen = silent ? [] : r.sample(eligible, Math.min(eligible.length, (3 + (i % 4) * 3) * f));
      const newest = chosen.reduce((m, u) => Math.max(m, u.createdAt.getTime() + HOUR_MS), lo);
      const start = between(r, newest, now - DAY_MS);
      const endsAt = start + durationSeconds * 1000;
      const status: PollEndStatus = i % 6 === 4 ? "terminated" : i % 6 === 5 ? "archived" : "completed";
      const endedAt = status === "terminated" ? start + Math.floor((durationSeconds * 1000) / 2) : endsAt;
      out.push({
        owner,
        title: q.title,
        choices,
        status,
        durationSeconds,
        startedAt: at(start),
        endsAt: at(endsAt),
        endedAt: at(endedAt),
        votes: chosen.map((u) => ({
          voter: u.handle,
          choice: r.int(0, choices.length - 1),
          castAt: at(between(r, start, endedAt)),
        })),
      });
    }
  }
  return out;
}

function planGoals(r: Rng, scale: SeedScale, now: number, created: (h: string) => number): GoalSpec[] {
  const out: GoalSpec[] = [];
  const goal = (owner: string, type: GoalType, open: boolean) => {
    const target = r.pick(GOAL_TARGETS[type]);
    const lo = Math.max(created(owner) + DAY_MS, now - scale.historyDays * DAY_MS);
    if (open) {
      out.push({
        owner,
        type,
        title: r.pick(GOAL_TITLES[type]),
        target,
        current: Math.floor(target * (0.2 + r.next() * 0.6)),
        startedAt: at(between(r, Math.max(lo, now - 14 * DAY_MS), now - HOUR_MS)),
        endedAt: null,
      });
      return;
    }
    const start = between(r, lo, now - 15 * DAY_MS);
    out.push({
      owner,
      type,
      title: r.pick(GOAL_TITLES[type]),
      target,
      current: target + Math.floor(target * r.next() * 0.3),
      startedAt: at(start),
      endedAt: at(between(r, start + DAY_MS, now - 14 * DAY_MS)),
    });
  };
  for (const type of GOAL_TYPES) {
    goal("streamer1", type, true);
    for (let i = 0; i < 2 * scale.factor; i++) goal("streamer1", type, false);
  }
  goal("streamer2", "followers", true);
  goal("streamer2", "subscriptions", false);
  return out;
}

function planAlerts(): AlertSpec[] {
  const out: AlertSpec[] = [];
  const add = (owner: string, type: AlertType, enabled = true) =>
    out.push({
      owner,
      type,
      enabled,
      ...ALERT_TEMPLATES[type],
      minAmountCents: type === "tip" ? 100 : 0,
      durationMs: type === "raid" ? 8_000 : 6_000,
    });
  for (const type of ALERT_TYPES) add("streamer1", type);
  add("streamer2", "follow");
  add("streamer2", "tip");
  add("streamer2", "raid", false);
  return out;
}

/** Past raids: streamer2 receives from bulk streamers, streamer1 sends a few. */
function planRaids(r: Rng, scale: SeedScale, now: number, roster: Roster, created: (h: string) => number): RaidSpec[] {
  const out: RaidSpec[] = [];
  const has = (h: string) => roster.channels.some((c) => c.ownerHandle === h);
  const bulk = roster.users.filter((u) => u.kind === "bulk-streamer" && has(u.handle)).map((u) => u.handle);
  const raid = (from: string, to: string, i: number) => {
    const lo = Math.max(created(from), created(to)) + DAY_MS;
    const createdAt = between(r, Math.max(lo, now - scale.historyDays * DAY_MS), now - DAY_MS);
    const cancelReason: RaidCancel | null = i % 5 === 3 ? "owner" : i % 5 === 4 ? "target_offline" : null;
    out.push({
      from,
      to,
      status: cancelReason ? "canceled" : "completed",
      cancelReason,
      viewerCount: cancelReason ? 0 : r.int(2, 60),
      createdAt: at(createdAt),
    });
  };
  if (has("streamer2") && bulk.length > 0)
    for (let i = 0; i < 5 * scale.factor; i++) raid(r.pick(bulk), "streamer2", i);
  const targets = ["council1", "council2", ...bulk].filter(has);
  if (has("streamer1") && targets.length > 0)
    for (let i = 0; i < 2 * scale.factor; i++) raid("streamer1", r.pick(targets), i);
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Watch time for accrual: viewer1 and a share of the bulk viewers on a few channels. */
function planWatch(r: Rng, now: number, roster: Roster, viewers: readonly RosterUser[]): WatchSpec[] {
  const out: WatchSpec[] = [];
  const has = (h: string) => roster.channels.some((c) => c.ownerHandle === h);
  const bulkChannels = roster.users
    .filter((u) => u.kind === "bulk-streamer" && has(u.handle))
    .slice(0, 3)
    .map((u) => u.handle);
  const shares: [string, number][] = [
    ["streamer1", 0.6],
    ["streamer2", 0.4],
    ["council1", 0.2],
    ...bulkChannels.map((h): [string, number] => [h, 0.1]),
  ];
  for (const [owner, share] of shares) {
    if (!has(owner)) continue;
    // Accounts a day old or more: every session (at most a few hours back) starts after them.
    const pool = viewers.filter((u) => participates(roster, owner, u.handle) && u.createdAt.getTime() <= now - DAY_MS);
    // viewer1 always watches streamer1; the bulk share is drawn from the rest.
    const v1 = owner === "streamer1" ? pool.filter((u) => u.handle === "viewer1") : [];
    const rest = pool.filter((u) => u.handle !== "viewer1");
    const n = Math.min(WATCH_SESSIONS_PER_CHANNEL_MAX, Math.round(rest.length * share));
    const picked = [...v1, ...r.sample(rest, n)];
    for (const u of picked) {
      const watchSeconds = u.handle === "viewer1" ? 90 * 60 : r.int(15, 90) * 60;
      const endedAt = now - r.int(5, 60) * MINUTE_MS;
      const startedAt = endedAt - watchSeconds * 1000;
      out.push({
        owner,
        viewer: u.handle,
        watchSeconds,
        startedAt: at(startedAt),
        endedAt: at(endedAt),
        scoredAt: at(endedAt + r.int(1, 4) * MINUTE_MS),
      });
    }
  }
  return out;
}

/** Every planned row and call of seed-interact. Pure. */
export function planInteract(rng: Rng, scale: SeedScale, now: Date, roster: Roster): InteractPlan {
  const t = now.getTime();
  const byHandle = new Map(roster.users.map((u) => [u.handle, u]));
  const created = (h: string) => byHandle.get(h)?.createdAt.getTime() ?? t - scale.historyDays * DAY_MS;
  const viewer1 = byHandle.get("viewer1");
  const bulkViewers = roster.users.filter((u) => u.kind === "bulk-viewer");
  // viewer1 is the heavy viewer; newbie, viewer2 and the staff logins keep their own states.
  const viewers = [...(viewer1 ? [viewer1] : []), ...bulkViewers];

  const bot = planBot(rng.fork("bot"), t, created);
  const songRequests = planSongs(
    rng.fork("songs"),
    scale,
    t,
    viewers.filter((u) => participates(roster, "streamer1", u.handle)),
  );
  const polls = planPolls(rng.fork("polls"), scale, t, roster, viewers, created);
  const goals = planGoals(rng.fork("goals"), scale, t, created);
  const alerts = planAlerts();
  const raids = planRaids(rng.fork("raids"), scale, t, roster, created);
  const watch = planWatch(rng.fork("watch"), t, roster, viewers);

  // Signed-in actors: plain bulk viewers who may take part on both fixed channels.
  const ra = rng.fork("actors");
  const both = (h: string) => mayBet(roster, "streamer1", h) && mayBet(roster, "streamer2", h);
  const actorPool = bulkViewers.filter((u) => both(u.handle)).map((u) => u.handle);
  const bulkActors = ra.sample(actorPool, clamp(6 * scale.factor, 0, ACTORS_MAX));
  const actors = [...(viewer1 ? ["viewer1"] : []), ...bulkActors];

  // Live polls (API): streamer1's sells extra votes, which viewer1 buys.
  const rl = rng.fork("live-polls");
  const livePolls: LivePollSpec[] = [];
  for (const [owner, extra] of [
    ["streamer1", EXTRA_VOTE_POINTS],
    ["streamer2", 0],
  ] as const) {
    const q = rl.pick(POLL_QUESTIONS);
    const choices = q.choices.slice(0, Math.min(4, q.choices.length));
    const voters = rl.sample(
      actors.filter((h) => participates(roster, owner, h)),
      owner === "streamer1" ? actors.length : Math.ceil(actors.length / 2),
    );
    livePolls.push({
      owner,
      title: q.title,
      choices,
      durationSeconds: LIVE_POLL_SECONDS,
      pointsPerExtraVote: extra,
      votes: voters.map((v) => ({
        voter: v,
        choice: rl.int(0, choices.length - 1),
        extraVotes: v === "viewer1" && extra > 0 ? 2 : 0,
      })),
    });
  }

  // Predictions (API): streamer2's stays open; streamer1's run in the live window.
  const rp = rng.fork("predictions");
  const BETTORS: Record<PredictionFinal, number> = { active: 3, resolved: 6, canceled: 4, locked: 5 };
  const prediction = (owner: string, final: PredictionFinal, live: boolean, q: number): PredictionSpec => {
    const question = PREDICTION_QUESTIONS[q % PREDICTION_QUESTIONS.length] ?? {
      title: "Next?",
      outcomes: ["Yes", "No"],
    };
    const outcomes = [...question.outcomes];
    const pool = actors.filter((h) => mayBet(roster, owner, h));
    const others = pool.filter((h) => h !== "viewer1");
    const chosen = rp.sample(others, Math.min(others.length, BETTORS[final] * scale.factor));
    const bettors = pool.includes("viewer1") && owner === "streamer1" ? ["viewer1", ...chosen] : chosen;
    const bets = bettors.map((b) => ({
      bettor: b,
      outcome: rp.int(0, outcomes.length - 1),
      points: b === "viewer1" ? rp.int(5, 20) * 100 : rp.int(1, 12) * 25,
    }));
    return {
      owner,
      title: question.title,
      outcomes,
      windowSeconds: final === "active" ? OPEN_PREDICTION_WINDOW_SECONDS : PREDICTION_WINDOW_SECONDS,
      final,
      // Settled on an outcome somebody bet on, so the payout is a real one, not a refund.
      winner: final === "resolved" ? (bets[0]?.outcome ?? 0) : null,
      live,
      bets,
    };
  };
  const predictions = [
    prediction("streamer2", "active", false, 3),
    prediction("streamer1", "resolved", true, 0),
    prediction("streamer1", "canceled", true, 1),
    prediction("streamer1", "locked", true, 2),
  ];

  // Points granted by the streamers (moderator adjustments): viewer1's large balance, every
  // bettor's stake, and one correction and one penalty so the history shows each reason.
  const grants: GrantSpec[] = [];
  if (viewer1) {
    grants.push({ owner: "streamer1", user: "viewer1", delta: VIEWER1_GRANT.streamer1, reason: "reward" });
    grants.push({ owner: "streamer1", user: "viewer1", delta: 75, reason: "correction" });
    grants.push({ owner: "streamer2", user: "viewer1", delta: VIEWER1_GRANT.streamer2, reason: "reward" });
  }
  // Every signed-in bulk viewer gets a stake on both fixed channels (more than all their bets).
  for (const owner of ["streamer1", "streamer2"])
    for (const h of bulkActors) grants.push({ owner, user: h, delta: BETTOR_GRANT, reason: "reward" });
  const penalised = grants.find((g) => g.user !== "viewer1");
  if (penalised) grants.push({ owner: penalised.owner, user: penalised.user, delta: -50, reason: "penalty" });

  // Giveaways (API, streamer1): one drawn, one closed and not drawn.
  const rg = rng.fork("giveaways");
  const entrantsS1 = actors.filter((h) => mayBet(roster, "streamer1", h) || h === "viewer1");
  const [drawnPrize, closedPrize] = GIVEAWAY_PRIZES;
  const giveaways: GiveawaySpec[] = [
    {
      owner: "streamer1",
      title: drawnPrize?.title ?? "Giveaway",
      prize: drawnPrize?.prize ?? "A prize",
      keyword: GIVEAWAY_KEYWORD,
      winnerCount: Math.max(1, Math.min(2, entrantsS1.length)),
      final: "drawn",
      entrants: entrantsS1,
    },
    {
      owner: "streamer1",
      title: closedPrize?.title ?? "Giveaway",
      prize: closedPrize?.prize ?? "A prize",
      keyword: null,
      winnerCount: 1,
      final: "closed",
      entrants: rg.sample(
        entrantsS1.filter((h) => h !== "viewer1"),
        3,
      ),
    },
  ];

  const has = (h: string) => roster.channels.some((c) => c.ownerHandle === h);
  return {
    now,
    bot,
    songRequests,
    polls,
    livePolls,
    predictions,
    giveaways,
    raids,
    liveRaid: has("streamer1") && has("streamer2") ? { from: "streamer1", to: "streamer2" } : null,
    goals,
    alerts,
    watch,
    grants,
    actors,
    overlayMints: 2,
  };
}

/** Rows each direct-insert table gets from the plan. Pure. */
export function planCounts(p: InteractPlan): Record<string, number> {
  return {
    bot_commands: p.bot.commands.length,
    bot_timers: p.bot.timers.length,
    bot_variables: p.bot.variables.length,
    song_requests: p.songRequests.length,
    polls: p.polls.length,
    poll_votes: p.polls.reduce((n, x) => n + x.votes.length, 0),
    raids: p.raids.length,
    goals: p.goals.length,
    alert_configs: p.alerts.length,
    playback_sessions: p.watch.length,
  };
}
