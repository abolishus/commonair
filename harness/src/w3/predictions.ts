// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` W3 extension `fair-prediction` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0039
 * decision 3, batch 7 decision (v)). The step brings its own streamer, viewers and moderator:
 *
 * 1. The streamer goes live. Two viewers watch at the `timeline-sync` latencies
 *    (`FORCED_LATENCIES`: near 3 s, far 9 s): their bets carry the playhead such a player reports
 *    (`playheadWallclock`), on the API's clock.
 * 2. The streamer starts a prediction; an early viewer bets on B; the moderator's bet is refused
 *    (FORBIDDEN `staff`). The streamer locks it: `lockMediaTs` is the media-clock edge at the lock.
 * 3. The far viewer bets on A just after the wall-clock lock: its playhead is still before the lock
 *    in media time, so the bet is accepted (and stored before `lock_media_ts`).
 * 4. The near viewer's later bet (its playhead past the lock) is refused (CONFLICT, the card's
 *    `closed`).
 * 5. Resolve A: the result card (`result`) has the pool, one winner and payouts that sum to the
 *    pool, `resolvedBy` names the streamer, the bets' payouts sum to the pool and the
 *    `prediction.resolve` audit row exists. With `via=web`, the far viewer's channel page shows
 *    `chat-prediction-result` with the same figures.
 *
 * The channel's own verified-watch gate stays off, so standing is not asked for (the API's
 * integration tests cover the unverified refusal); the team, the media lock and the result are
 * what this step proves end to end.
 */
import { playerBundles } from "../player-server.ts";
import { sleep } from "../wait.ts";
import { codeOf, refusal } from "../e8/raids.ts";
import { type E8Streamer, newE8Streamer, waitLive } from "../e8/kit.ts";
import { E8_ROUTES, byE8Id } from "../e8/selectors.ts";
import { FORCED_LATENCIES } from "../w1/timeline-web.ts";
import { toDate } from "../w2/sql-time.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { expandPinnedStrip } from "../d/d2-chat.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { InteractW3Extension } from "./kit.ts";

/** docs/testing/b7-selectors.md "Fair predictions". */
export const FAIR_PREDICTION_IDS = {
  locksNote: "chat-prediction-locks-note",
  refused: "chat-prediction-refused",
  result: "chat-prediction-result",
  resolvedBy: "prediction-resolved-by",
  teamNote: "prediction-team-note",
} as const;

export const FAIR_GRANT = 1000;
export const EARLY_BET = 200;
export const FAR_BET = 300;
const UI_TIMEOUT_MS = 30_000;
/** The far viewer must bet within this long of the lock (it is 9 s behind; keep a margin). */
export const FAR_BET_DEADLINE_MS = 6_000;
/** The near viewer bets once its playhead (3 s behind) is this far past the lock. */
export const NEAR_PAST_LOCK_MS = 1_500;

/**
 * The API's clock now, from a timestamp the API stamped (`lockMediaTs`) and how long ago, on the
 * harness's monotonic clock, its response arrived. Cancels any skew between the harness host and
 * the stack (a Podman VM's clock drifts). Never earlier than the API's own time. Pure.
 */
export function apiNow(apiStamp: string, receivedAtMs: number, nowMs: number): Date {
  return new Date(Date.parse(apiStamp) + Math.max(0, nowMs - receivedAtMs));
}

/** The playhead a player `latencySeconds` behind live reports at `apiTime`. Pure. */
export function playheadAt(apiTime: Date, latencySeconds: number): Date {
  return new Date(apiTime.getTime() - latencySeconds * 1000);
}

export interface ResultCard {
  pool: number;
  winners: number;
  payoutSum: number;
}

/** What is wrong with a resolved prediction's result card. Empty when all is well. Pure. */
export function resultProblems(
  result: ResultCard | null | undefined,
  want: { pool: number; winners: number },
): string[] {
  if (!result) return ["no result card"];
  const problems: string[] = [];
  if (result.pool !== want.pool) problems.push(`pool ${result.pool}, want ${want.pool}`);
  if (result.winners !== want.winners) problems.push(`winners ${result.winners}, want ${want.winners}`);
  if (result.payoutSum !== result.pool)
    problems.push(`payouts ${result.payoutSum} do not sum to the pool ${result.pool}`);
  return problems;
}

/** The `reason` of a FORBIDDEN refusal (`staff` for the channel's team), or null. */
export function reasonOf(err: unknown): string | null {
  const data = typeof err === "object" && err !== null ? (err as { data?: unknown }).data : undefined;
  const r = typeof data === "object" && data !== null ? (data as { reason?: unknown }).reason : undefined;
  return typeof r === "string" ? r : null;
}

async function goLive(run: InteractW3Extension, s: E8Streamer): Promise<void> {
  const streamer = await run.ctx.platform.streamerFor(s.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  run.ctx.defer(() => streamer.stop());
  await streamer.start();
  await waitLive(run.ctx, s.channel);
}

export async function stepFairPrediction(run: InteractW3Extension): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;
  const t = (what: string) => `fair-prediction: ${what}`;

  const s = await ctx.step(t("sign up the streamer"), () => newE8Streamer(ctx, "e8fs"));
  const [near, far, early, mod] = await ctx.step(t("sign up near, far and early viewers and a moderator"), () =>
    Promise.all([
      p.signUp({ prefix: "e8fn" }),
      p.signUp({ prefix: "e8ff" }),
      p.signUp({ prefix: "e8fe" }),
      p.signUp({ prefix: "e8fm" }),
    ]),
  );
  const owner = s.user.api.client;
  await ctx.step(t("the moderator is granted; everyone gets points"), async () => {
    await owner.channels.roles.grant({ channel: s.channel, username: mod.username, role: "moderator" });
    for (const u of [near, far, early, mod])
      await owner.bot.points.adjust({ channel: s.channel, username: u.username, delta: FAIR_GRANT, reason: "reward" });
  });
  await ctx.step(t("the streamer goes live"), () => goLive(run, s));

  // With `via=web` the far viewer signs in now, so the result is still shown when the page opens.
  const page =
    run.via === "web"
      ? await ctx.step(t("the far viewer signs in through the web UI"), async () => {
          const session = await WebSession.open({
            fleet: p.fleet,
            engine: "chromium",
            webUrl: ctx.env.HARNESS_WEB_URL,
            probeScript: (await playerBundles()).probe,
            label: "w3-fair-prediction",
            log: ctx.log,
          });
          ctx.defer(() => session.close());
          const signin = await session.goto(ROUTES.signin);
          await signInViaUi(signin, far, UI_TIMEOUT_MS, ctx.signal);
          await byTestId(signin, T.navUser, { username: far.username }).waitFor({ timeout: UI_TIMEOUT_MS });
          return { session, page: signin };
        })
      : null;

  const created = await ctx.step(t("the streamer starts a prediction"), () =>
    owner.interact.predictions.create({
      channel: s.channel,
      title: `Fair ${ctx.runId}`.slice(0, 45),
      outcomes: ["Alpha", "Beta"],
      windowSeconds: 120,
    }),
  );
  const [A, B] = [created.outcomes[0]?.id ?? "", created.outcomes[1]?.id ?? ""];
  // Before the lock the API's clock is read from the prediction's own start.
  const startedAt = performance.now();
  const before = (latency: number) =>
    playheadAt(apiNow(created.startedAt, startedAt, performance.now()), latency).toISOString();

  await ctx.step(t("an early viewer bets on B before the lock"), async () => {
    const v = await early.api.client.interact.predictions.bet({
      id: created.id,
      outcomeId: B,
      points: EARLY_BET,
      mediaTs: before(FORCED_LATENCIES.near),
      playbackMode: "live",
    });
    ctx.assert(t("the early bet is taken"), v.myBet?.points === EARLY_BET, v.myBet);
  });

  await ctx.step(t("the moderator's bet is refused"), async () => {
    const err = await refusal("the moderator's bet", () =>
      mod.api.client.interact.predictions.bet({
        id: created.id,
        outcomeId: A,
        points: 10,
        mediaTs: before(FORCED_LATENCIES.near),
        playbackMode: "live",
      }),
    );
    ctx.assert(t("FORBIDDEN, reason staff"), codeOf(err) === "FORBIDDEN" && reasonOf(err) === "staff", {
      code: codeOf(err),
      reason: reasonOf(err),
    });
  });

  const lock = await ctx.step(t("the streamer locks it"), async () => {
    const locked = await owner.interact.predictions.lock({ id: created.id });
    const receivedAt = performance.now();
    ctx.assert(t("locked with a media-time lock"), locked.status === "locked" && !!locked.lockMediaTs, locked);
    return { lockMediaTs: locked.lockMediaTs ?? "", receivedAt };
  });
  const at = (latency: number) => playheadAt(apiNow(lock.lockMediaTs, lock.receivedAt, performance.now()), latency);

  await ctx.step(t("the far viewer's bet just after the wall-clock lock is accepted"), async () => {
    const elapsed = performance.now() - lock.receivedAt;
    ctx.assert(t("the far bet goes in within the far viewer's delay"), elapsed < FAR_BET_DEADLINE_MS, { elapsed });
    const mediaTs = at(FORCED_LATENCIES.far);
    const v = await far.api.client.interact.predictions.bet({
      id: created.id,
      outcomeId: A,
      points: FAR_BET,
      mediaTs: mediaTs.toISOString(),
      playbackMode: "live",
    });
    ctx.assert(t("the far bet is taken"), v.status === "locked" && v.myBet?.points === FAR_BET, v);
    const row = await run.db.query.predictionBets.findFirst({
      columns: { mediaTs: true },
      where: (b, { and, eq }) => and(eq(b.predictionId, created.id), eq(b.userId, far.id)),
    });
    const stored = toDate(row?.mediaTs);
    ctx.assert(
      t("the far bet is stored before lock_media_ts"),
      stored !== null && stored.getTime() < Date.parse(lock.lockMediaTs),
      { stored, lockMediaTs: lock.lockMediaTs },
    );
  });

  await ctx.step(t("the near viewer's later bet is refused"), async () => {
    // Wait until the near player (3 s behind) has shown the lock.
    const wait = FORCED_LATENCIES.near * 1000 + NEAR_PAST_LOCK_MS - (performance.now() - lock.receivedAt);
    if (wait > 0) await sleep(wait, ctx.signal);
    const mediaTs = at(FORCED_LATENCIES.near);
    ctx.assert(t("the near playhead is past the lock"), mediaTs.getTime() > Date.parse(lock.lockMediaTs), {
      mediaTs,
      lockMediaTs: lock.lockMediaTs,
    });
    const err = await refusal("the near viewer's late bet", () =>
      near.api.client.interact.predictions.bet({
        id: created.id,
        outcomeId: A,
        points: 50,
        mediaTs: mediaTs.toISOString(),
        playbackMode: "live",
      }),
    );
    ctx.assert(t("CONFLICT (closed)"), codeOf(err) === "CONFLICT", { code: codeOf(err) });
  });

  const pool = EARLY_BET + FAR_BET;
  await ctx.step(t("resolve: the payouts sum to the pool; resolver and audit row"), async () => {
    const resolved = await owner.interact.predictions.resolve({ id: created.id, winningOutcomeId: A });
    ctx.assert(t("resolved to A"), resolved.status === "resolved" && resolved.winningOutcomeId === A, resolved);
    const problems = resultProblems(resolved.result, { pool, winners: 1 });
    ctx.assert(t("the result card adds up"), problems.length === 0, { problems, result: resolved.result });
    ctx.assert(t("resolvedBy is the streamer"), resolved.resolvedBy?.id === s.user.id, resolved.resolvedBy);
    ctx.assert(t("the far viewer won the pool"), resolved.result?.payoutSum === pool, resolved.result);

    const bets = await run.db.query.predictionBets.findMany({
      columns: { payout: true },
      where: (b, { eq }) => eq(b.predictionId, created.id),
    });
    const paid = bets.reduce((sum, b) => sum + (b.payout ?? 0), 0);
    ctx.assert(t("the bets' payouts sum to the pool"), paid === pool, { paid, pool });

    const audits = await run.db.query.auditLog.findMany({ where: (a, { eq }) => eq(a.subjectId, created.id) });
    const row = audits.find((a) => a.action === "prediction.resolve");
    ctx.assert(
      t("a prediction.resolve audit row names the resolver and the outcome"),
      row?.actorId === s.user.id && row.details.winningOutcomeId === A && row.details.payoutSum === pool,
      row,
    );
  });

  if (page === null) return;
  await ctx.step(t("the far viewer's channel page shows chat-prediction-result"), async () => {
    await page.session.goto(E8_ROUTES.channel(s.channel));
    await expandPinnedStrip(page.page);
    await byE8Id(page.page, FAIR_PREDICTION_IDS.result, {
      pool: String(pool),
      winners: "1",
      "payout-sum": String(pool),
    }).waitFor({ timeout: UI_TIMEOUT_MS });
  });
}
