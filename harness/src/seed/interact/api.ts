// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-interact's API steps, signed in as the seeded owners and viewers: bot settings (the API
 * links or creates the bot account and its moderator role), points granted by the streamers,
 * live polls, predictions and their bets, giveaways, the live raid and overlay tokens. These write
 * the protected rows (`loyalty_*`, `prediction_bets`, `giveaway*`) through the product's own code
 * and their own `events` and `audit_log` rows, as any client's calls would. Each user signs in
 * once. Every failure names the user and the step.
 */
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { type Api, createApi } from "../../api/client.ts";
import { CookieJar } from "../../api/cookies.ts";
import { AddressPool, parseCidr, seededRandom } from "../../cidrs.ts";
import type { HarnessEnv } from "../../env.ts";
import { type ForwardingProxy, startForwardingProxy } from "../../proxy.ts";
import { type SignedInUser, UserFactory } from "../../users.ts";
import { rerunDraw } from "../../w3/giveaways.ts";
import type { SeededUser } from "../types.ts";
import type { GiveawaySpec, GrantSpec, InteractPlan, LivePollSpec, PredictionSpec } from "./plan.ts";

export type Client = SignedInUser["api"]["client"];

/** Who the API steps act as: a signed-in client per seeded handle. */
export interface SessionSource {
  as(handle: string): Promise<Pick<SignedInUser, "api" | "username">>;
}

/**
 * Simulated client addresses: the shared (CGNAT) space only, never a routable public address, so
 * the session rows the API writes carry no real person's address.
 */
export const SEED_CLIENT_CIDR = "100.64.0.0/10";

/**
 * Signs each seeded account in once (as `demo_<handle>@demo-seed.invalid`) and keeps the session.
 * Every account calls through the harness forwarding proxy with its own simulated address, as the
 * scenarios' clients do, so dozens of sign-ins do not share one address's auth rate limit. `close`
 * stops the proxy.
 */
export class SeedSessions implements SessionSource {
  private readonly cache = new Map<string, Promise<SignedInUser>>();
  private readonly factory: UserFactory;
  private readonly addresses = new AddressPool([parseCidr(SEED_CLIENT_CIDR)], seededRandom(0x5eed));
  private proxy: ForwardingProxy | null = null;

  constructor(
    private readonly env: HarnessEnv,
    private readonly password: string,
    private readonly users: ReadonlyMap<string, SeededUser>,
  ) {
    this.factory = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: DEMO_FIXTURES.emailDomain,
    });
  }

  private api(): Api {
    this.proxy ??= startForwardingProxy({ target: this.env.HARNESS_API_URL });
    return createApi({
      baseUrl: this.proxy.url,
      origin: new URL(this.env.HARNESS_WEB_URL).origin,
      jar: new CookieJar(),
      clientIp: this.addresses.next(),
    });
  }

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      const u = this.users.get(handle);
      if (!u) throw new Error(`seed-interact: no seeded user "${handle}" to sign in`);
      p = this.factory
        .signIn(
          {
            username: u.username,
            displayName: u.username,
            email: u.email,
            password: this.password,
            birthDate: "",
          },
          this.api(),
        )
        .catch((err: unknown) => {
          throw new Error(`seed-interact: sign-in as ${handle} failed: ${String(err)}`);
        });
      this.cache.set(handle, p);
    }
    return p;
  }

  get signedIn(): number {
    return this.cache.size;
  }

  async close(): Promise<void> {
    await this.proxy?.stop();
    this.proxy = null;
  }
}

export interface StepRunner {
  <T>(who: string, what: string, f: () => Promise<T>): Promise<T>;
}

export function stepRunner(signal: AbortSignal): StepRunner {
  return async (who, what, f) => {
    signal.throwIfAborted();
    try {
      return await f();
    } catch (err) {
      throw new Error(`seed-interact: ${what} as ${who} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export interface ApiDeps {
  sessions: SessionSource;
  /** Owner handle → channel slug. */
  slugs: ReadonlyMap<string, string>;
  step: StepRunner;
}

const slugOf = (d: ApiDeps, owner: string): string => {
  const s = d.slugs.get(owner);
  if (!s) throw new Error(`seed-interact: no channel for "${owner}"`);
  return s;
};

/** Save every bot config through the API; bot1 becomes streamer1's moderator through the roles call. */
export async function saveBotSettings(d: ApiDeps, plan: InteractPlan): Promise<{ apiCreated: number }> {
  let apiCreated = 0;
  for (const c of plan.bot.configs) {
    const channel = slugOf(d, c.owner);
    const owner = await d.sessions.as(c.owner);
    const saved = await d.step(c.owner, "save the bot settings", () =>
      owner.api.client.bot.updateSettings({ channel, enabled: c.enabled, config: c.config }),
    );
    if (c.botHandle === null) apiCreated++;
    else {
      // The API grants the role only to a bot account it creates; bot1 was created by seed-social.
      const bot = saved.botUser;
      if (!bot) throw new Error(`seed-interact: ${c.owner}'s bot settings came back without the linked bot`);
      await d.step(c.owner, `make ${bot.username} a moderator`, () =>
        owner.api.client.channels.roles.grant({ channel, username: bot.username, role: "moderator" }),
      );
    }
  }
  return { apiCreated };
}

/** Points granted (or deducted) by the channel owners: `moderator_adjust` ledger rows. */
export async function grantPoints(d: ApiDeps, grants: readonly GrantSpec[]): Promise<number> {
  let n = 0;
  for (const g of grants) {
    const owner = await d.sessions.as(g.owner);
    const target = await d.sessions.as(g.user);
    await d.step(g.owner, `adjust ${g.user}'s points by ${g.delta}`, () =>
      owner.api.client.bot.points.adjust({
        channel: slugOf(d, g.owner),
        username: target.username,
        delta: g.delta,
        reason: g.reason,
      }),
    );
    n++;
  }
  return n;
}

/** Start each live poll and cast its votes (extra votes spend points: `poll_vote`). */
export async function runLivePolls(
  d: ApiDeps,
  polls: readonly LivePollSpec[],
): Promise<{ polls: number; votes: number }> {
  let votes = 0;
  for (const p of polls) {
    const owner = await d.sessions.as(p.owner);
    const created = await d.step(p.owner, `start the poll "${p.title}"`, () =>
      owner.api.client.interact.polls.create({
        channel: slugOf(d, p.owner),
        title: p.title,
        choices: p.choices,
        durationSeconds: p.durationSeconds,
        pointsPerExtraVote: p.pointsPerExtraVote,
      }),
    );
    for (const v of p.votes) {
      const choice = created.choices[v.choice];
      if (!choice) throw new Error(`seed-interact: poll "${p.title}" has no choice ${v.choice}`);
      const u = await d.sessions.as(v.voter);
      await d.step(v.voter, `vote in ${p.owner}'s poll`, () =>
        u.api.client.interact.polls.vote({ id: created.id, choiceId: choice.id, extraVotes: v.extraVotes }),
      );
      votes++;
    }
  }
  return { polls: polls.length, votes };
}

/**
 * The API's clock now, from a timestamp it stamped and how long ago (on the harness's monotonic
 * clock) that response arrived, so host-to-stack clock skew cancels out. Pure.
 */
export function apiNow(apiStamp: string, receivedAtMs: number, nowMs: number): Date {
  return new Date(Date.parse(apiStamp) + Math.max(0, nowMs - receivedAtMs));
}

/** How far behind live the seeded bettors' players are (well inside the 30 s edge window). */
export const BETTOR_LATENCY_MS = 3_000;

export interface PredictionResult {
  id: string;
  status: string;
  bets: number;
}

/**
 * Create a prediction, place its bets and leave it in its planned state. Live bets carry the
 * playhead a player `BETTOR_LATENCY_MS` behind live reports, on the API's clock.
 */
export async function runPrediction(d: ApiDeps, p: PredictionSpec): Promise<PredictionResult> {
  const owner = await d.sessions.as(p.owner);
  const api = owner.api.client.interact.predictions;
  const created = await d.step(p.owner, `start the prediction "${p.title}"`, () =>
    api.create({ channel: slugOf(d, p.owner), title: p.title, outcomes: p.outcomes, windowSeconds: p.windowSeconds }),
  );
  const receivedAt = performance.now();
  for (const b of p.bets) {
    const outcome = created.outcomes[b.outcome];
    if (!outcome) throw new Error(`seed-interact: prediction "${p.title}" has no outcome ${b.outcome}`);
    const u = await d.sessions.as(b.bettor);
    const mediaTs = p.live
      ? new Date(apiNow(created.startedAt, receivedAt, performance.now()).getTime() - BETTOR_LATENCY_MS).toISOString()
      : null;
    await d.step(b.bettor, `bet ${b.points} on "${p.title}"`, () =>
      u.api.client.interact.predictions.bet({
        id: created.id,
        outcomeId: outcome.id,
        points: b.points,
        mediaTs,
        playbackMode: "live",
      }),
    );
  }
  let status: string = created.status;
  if (p.final === "locked" || p.final === "resolved")
    status = (await d.step(p.owner, `lock "${p.title}"`, () => api.lock({ id: created.id }))).status;
  if (p.final === "resolved") {
    const winner = p.winner === null ? undefined : created.outcomes[p.winner];
    if (!winner) throw new Error(`seed-interact: prediction "${p.title}" has no winning outcome`);
    status = (
      await d.step(p.owner, `resolve "${p.title}"`, () => api.resolve({ id: created.id, winningOutcomeId: winner.id }))
    ).status;
  }
  if (p.final === "canceled")
    status = (await d.step(p.owner, `cancel "${p.title}"`, () => api.cancel({ id: created.id }))).status;
  if (status !== p.final)
    throw new Error(`seed-interact: prediction "${p.title}" ended ${status}, the plan wants ${p.final}`);
  return { id: created.id, status, bets: p.bets.length };
}

export interface GiveawayResult {
  id: string;
  status: string;
  entries: number;
  winners: number;
}

/** Open, enter, close and (for `drawn`) draw a giveaway; a drawn one's draw is re-run and must match. */
export async function runGiveaway(d: ApiDeps, g: GiveawaySpec): Promise<GiveawayResult> {
  const channel = slugOf(d, g.owner);
  const owner = await d.sessions.as(g.owner);
  const api = owner.api.client.interact.giveaways;
  const opened = await d.step(g.owner, `open the giveaway "${g.title}"`, () =>
    api.open({
      channel,
      title: g.title,
      prize: g.prize,
      winnerCount: g.winnerCount,
      keyword: g.keyword,
      durationMinutes: null,
      eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
    }),
  );
  for (const h of g.entrants) {
    const u = await d.sessions.as(h);
    await d.step(h, `enter "${g.title}"`, () => u.api.client.interact.giveaways.enter({ id: opened.id }));
  }
  const closed = await d.step(g.owner, `close "${g.title}"`, () => api.close({ channel, id: opened.id }));
  if (g.final === "closed") return { id: opened.id, status: closed.status, entries: closed.entries, winners: 0 };
  const drawn = await d.step(g.owner, `draw "${g.title}"`, () => api.draw({ channel, id: opened.id }));
  const verification = await d.step("anonymous", `verify "${g.title}"`, () => api.verify({ channel, id: opened.id }));
  const problems = await rerunDraw(verification);
  if (problems.length > 0)
    throw new Error(`seed-interact: the re-run of "${g.title}"'s draw does not match: ${problems.join("; ")}`);
  if (drawn.status !== "drawn") throw new Error(`seed-interact: "${g.title}" ended ${drawn.status}, not drawn`);
  return { id: opened.id, status: drawn.status, entries: drawn.entries, winners: drawn.winners.length };
}

/** The exact query string (`token=…`, without `?`) of an overlay page URL the API returned. */
export function overlayQuery(pageUrl: string): string {
  return new URL(pageUrl).search.replace(/^\?/, "");
}

export interface OverlayQueries {
  overlayChatQuery: string;
  overlayAlertsQuery: string;
  overlayGoalsQuery: string;
}

/** Mint `mints` overlay tokens for `owner` (each revokes the last); the last one's page queries. */
export async function mintOverlayTokens(d: ApiDeps, owner: string, mints: number): Promise<OverlayQueries> {
  const u = await d.sessions.as(owner);
  let last: Awaited<ReturnType<Client["interact"]["overlays"]["token"]>> | null = null;
  for (let i = 0; i < Math.max(1, mints); i++)
    last = await d.step(owner, "mint an overlay token", () =>
      u.api.client.interact.overlays.token({ channel: slugOf(d, owner), expiresAt: null }),
    );
  if (!last) throw new Error("seed-interact: no overlay token was minted");
  return {
    overlayChatQuery: overlayQuery(last.chatUrl),
    overlayAlertsQuery: overlayQuery(last.alertsUrl),
    overlayGoalsQuery: overlayQuery(last.goalsUrl),
  };
}

/** What seed-interact publishes as `store.extra.interact` (the keys its brief names). */
export interface InteractExtra extends OverlayQueries {
  /** streamer1's drawn giveaway, for `/$channel/giveaways/$giveawayId`. */
  giveawayId: string;
}

/** The store entry from the overlay queries and the giveaways run; throws without a drawn one. Pure. */
export function interactExtra(overlay: OverlayQueries, giveaways: readonly GiveawayResult[]): InteractExtra {
  const drawn = giveaways.find((g) => g.status === "drawn");
  if (!drawn) throw new Error("seed-interact: no giveaway was drawn, so there is no giveawayId to publish");
  return {
    overlayChatQuery: overlay.overlayChatQuery,
    overlayAlertsQuery: overlay.overlayAlertsQuery,
    overlayGoalsQuery: overlay.overlayGoalsQuery,
    giveawayId: drawn.id,
  };
}
