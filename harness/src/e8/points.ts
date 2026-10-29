// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channel-bot` step 4, viewbots earn nothing (E8-points; docs/testing/e8-selectors.md,
 * "Scenarios"; ADR 0026 decision 1). The streamer goes live; one signed-in viewer watches through
 * the normal player path until the integrity scorer verifies its session, while a swarm of
 * **signed-in** viewbots (`viewbot.ts`) watches too: anonymous sessions earn nothing by rule, so
 * an anonymous swarm would prove nothing. After three minutes and a `points-accrue` run, the viewer
 * holds a positive multiple of a block's points and no swarm account holds any, nor has a single
 * `loyalty_transactions` row.
 *
 * Parameters: `--set pointsBots=4 --set pointsWatchSeconds=180`. Needs `DATABASE_URL` (session
 * verdicts and the ledger) and the harness stack's one-minute blocks (harness/compose.e5-coop.yaml).
 */
import type { Api } from "../api/client.ts";
import { HttpViewer } from "../http-viewer.ts";
import { STEADY_TIMING, gateEligible } from "../integrity-viewers.ts";
import type { SignedInUser } from "../users.ts";
import { ViewbotSwarm, type ApiFactory } from "../viewbot.ts";
import { sleep, waitFor } from "../wait.ts";
import { botTitle } from "./steps.ts";
import { type E8Run, waitLive } from "./kit.ts";

/** Points one block earns on the harness stack (`interact.points.accrual.pointsPerBlock`). */
export const POINTS_PER_BLOCK = 10;
export const DEFAULT_SWARM_SESSIONS = 4;
export const DEFAULT_WATCH_SECONDS = 180;
/** The scorer runs every 15 s and needs a few beats: generous for a loaded stack. */
const VERIFY_TIMEOUT_MS = 180_000;

/**
 * An `ApiFactory` for `ViewbotSwarm` that hands out one signed-in account per plan: the account's
 * cookie jar (its session) with the plan's datacenter address and headless user agent. The swarm
 * calls the factory synchronously, once per plan, so the accounts are signed up beforehand.
 */
export function signedInSwarmFactory(
  accounts: readonly Pick<SignedInUser, "api">[],
  make: (o: { clientIp: string; userAgent: string; jar: Api["jar"] }) => Api,
): ApiFactory {
  let next = 0;
  return (o) => {
    const account = accounts[next];
    if (!account) throw new Error(`the swarm asked for account ${next + 1} of ${accounts.length}`);
    next++;
    return make({ clientIp: o.clientIp, userAgent: o.userAgent, jar: account.api.jar });
  };
}

/** The viewer's balance shows whole blocks only, and at least one. */
export function earnedWholeBlocks(points: number, perBlock = POINTS_PER_BLOCK): boolean {
  return Number.isInteger(points) && points > 0 && points % perBlock === 0;
}

export interface SessionRow {
  id: string;
  userId: string | null;
  verdict: string;
  reasons: string[] | null;
  scored: boolean;
}

/** Gate-eligible as `GATE_ELIGIBLE` has it: verified, fetches judged, and scored at least once. */
export const sessionEarns = (r: SessionRow): boolean =>
  r.scored && gateEligible({ verdict: r.verdict, reasons: r.reasons });

async function sessionRows(url: string, ids: readonly string[]): Promise<SessionRow[]> {
  if (ids.length === 0) return [];
  const sql = new Bun.SQL(url);
  try {
    return (await sql`
      select id, user_id as "userId", verdict::text as verdict, verdict_reasons as reasons,
             scored_at is not null as scored
        from playback_sessions where id = any(${sql.array([...ids], "uuid")})`) as SessionRow[];
  } finally {
    await sql.close();
  }
}

async function ledgerRows(url: string, channelId: string, userIds: readonly string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const sql = new Bun.SQL(url);
  try {
    const [r] = (await sql`
      select count(*)::int as n from loyalty_transactions
       where channel_id = ${channelId}::uuid and user_id = any(${sql.array([...userIds], "uuid")})`) as { n: number }[];
    return r?.n ?? 0;
  } finally {
    await sql.close();
  }
}

export async function stepViewbots(run: E8Run): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const t = (what: string) => botTitle(4, what);
  const databaseUrl = ctx.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set (session verdicts and ledger checks)");
  const sessions = Math.max(1, ctx.intParam("pointsBots", DEFAULT_SWARM_SESSIONS));
  const watchMs = Math.max(60, ctx.intParam("pointsWatchSeconds", DEFAULT_WATCH_SECONDS)) * 1000;
  const { channel, channelId } = run.streamer;
  const viewer = run.viewers[0];
  if (!viewer) throw new Error("the E8 run has no viewer");

  const live = (await p.api().client.channels.get({ channel })).live !== null;
  if (!live) {
    const s = await p.streamerFor(run.streamer.user, { protocol: "rtmp", width: 854, height: 480, bitrateKbps: 1500 });
    ctx.defer(() => s.stop());
    await ctx.step(t("publish"), () => s.start());
    await ctx.step(t("channel goes live"), () => waitLive(ctx, channel));
  }

  const accounts = await ctx.step(t(`sign up ${sessions} swarm accounts`), () =>
    Promise.all(Array.from({ length: sessions }, () => p.signUp({ prefix: "e8bswarm" }))),
  );
  const honest = new HttpViewer({
    id: "points-viewer",
    target: { channel },
    api: viewer.api.client,
    timing: STEADY_TIMING,
    log: p.log,
  });
  const swarm = new ViewbotSwarm(
    { channel, sessions },
    p.datacenter,
    signedInSwarmFactory(accounts, (o) => p.api(o)),
    p.log,
  );
  ctx.defer(() => honest.stop());
  ctx.defer(() => swarm.stop());

  await ctx.step(t("the viewer and the signed-in swarm start watching"), () =>
    Promise.all([honest.start(), swarm.start()]),
  );
  const started = Date.now();
  await ctx.step(t("the viewer's first frame"), () => honest.waitForFirstFrame(60_000));
  const honestId = honest.sessionId;
  ctx.assert("the viewer opened a playback session", honestId !== null);
  ctx.assert("every swarm session opened", swarm.sessionIds.length === sessions, { sessions: swarm.sessionIds });

  const swarmRows = await sessionRows(databaseUrl, swarm.sessionIds);
  const swarmIds = new Set(accounts.map((a) => a.id));
  ctx.assert(
    "every swarm session is signed in as its own account (an anonymous swarm proves nothing)",
    swarmRows.length === sessions && swarmRows.every((r) => r.userId !== null && swarmIds.has(r.userId)),
    swarmRows.map((r) => ({ id: r.id, userId: r.userId })),
  );

  await ctx.step(t("the viewer's session is verified and gate-eligible"), () =>
    waitFor(
      "viewer session gate-eligible",
      async () => {
        const [r] = await sessionRows(databaseUrl, honestId ? [honestId] : []);
        return r && sessionEarns(r) ? r : null;
      },
      { timeoutMs: VERIFY_TIMEOUT_MS, intervalMs: 3_000, signal: ctx.signal },
    ),
  );
  const remaining = watchMs - (Date.now() - started);
  if (remaining > 0) await ctx.step(t(`watch for ${watchMs / 1000} s`), () => sleep(remaining, ctx.signal));

  const tick = await ctx.step(t("run points-accrue"), () => run.hooks.tick("points-accrue"));
  ctx.data("pointsAccrue", tick);

  const balance = await ctx.step(t("the viewer's balance"), () =>
    waitFor(
      "viewer balance",
      async () => {
        const b = await run.api.bot.points.balance({ channel, username: viewer.username });
        return b.points > 0 ? b : null;
      },
      { timeoutMs: 30_000, intervalMs: 1_000, signal: ctx.signal },
    ),
  );
  ctx.data("viewerPoints", balance.points);
  ctx.assert(`the viewer earned whole blocks of ${POINTS_PER_BLOCK}`, earnedWholeBlocks(balance.points), balance);

  const finalSwarm = await sessionRows(databaseUrl, swarm.sessionIds);
  ctx.data(
    "swarmVerdicts",
    finalSwarm.map((r) => ({ verdict: r.verdict, reasons: r.reasons })),
  );
  ctx.check(
    "no swarm session is gate-eligible",
    finalSwarm.every((r) => !sessionEarns(r)),
    finalSwarm.map((r) => ({ verdict: r.verdict, reasons: r.reasons })),
  );
  const swarmBalances = await ctx.step(t("swarm balances"), () =>
    Promise.all(accounts.map((a) => run.api.bot.points.balance({ channel, username: a.username }))),
  );
  ctx.assert(
    "no swarm account holds points",
    swarmBalances.every((b) => b.points === 0),
    swarmBalances.map((b) => ({ user: b.user.username, points: b.points })),
  );
  ctx.assert("no swarm account has a ledger row", (await ledgerRows(databaseUrl, channelId, [...swarmIds])) === 0);

  await ctx.step(t("stop watching"), () => Promise.all([honest.stop(), swarm.stop()]));
}
