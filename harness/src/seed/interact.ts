// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-interact: bot, polls, predictions, raids, goals, alerts, overlays and channel points. Brief: `.claude/briefs/seed-full/seed-interact.md`. */
import { INTERACT_JOBS } from "@commonair/contracts/internal";
import type { DbHandle } from "@commonair/db";
import { type InteractHooks, InteractHooksOff, interactHooks } from "../e8/kit.ts";
import { internalSecret } from "../safety-io.ts";
import { assertWatchInLookback, runAccrual } from "./interact/accrual.ts";
import {
  type ApiDeps,
  type GiveawayResult,
  SeedSessions,
  grantPoints,
  interactExtra,
  mintOverlayTokens,
  runGiveaway,
  runLivePolls,
  runPrediction,
  saveBotSettings,
  stepRunner,
} from "./interact/api.ts";
import { startRaid, waitRaidDone, withLiveWindow } from "./interact/live.ts";
import { planInteract } from "./interact/plan.ts";
import { readRoster } from "./interact/roster.ts";
import { writeInteractDirect } from "./interact/write.ts";
import type { SeedContext, SeedUnit, SeedUnitReport } from "./types.ts";

const TABLES = [
  "bot_configs",
  "bot_commands",
  "bot_timers",
  "bot_variables",
  "loyalty_balances",
  "loyalty_transactions",
  "loyalty_accruals",
  "loyalty_accrual_sessions",
  "song_requests",
  "polls",
  "poll_votes",
  "predictions",
  "prediction_bets",
  "raids",
  "alert_configs",
  "goals",
  "overlay_tokens",
  // Batch 7: giveaways.
  "giveaways",
  "giveaway_entries",
  "giveaway_winners",
] as const;

export type { InteractExtra } from "./interact/api.ts";

/** The instance flags the unit needs, each named in the error that a missing one raises. */
export const INTERACT_FLAGS = [
  "INTERACT_TEST_HOOKS=true (api and worker)",
  "DEMO_SEED_FULL=true (worker: points accrual on demo users)",
  "GIVEAWAYS_ENABLED=true (api)",
  "INTERNAL_API_SECRET (harness: the test hook)",
] as const;

/**
 * The report's row counts: every table the unit owns, which holds only this unit's rows when it
 * finishes. playback_sessions is seed-media's table, so the synthetic watch sessions are a
 * cross-unit write named in a note, never counted here (seed-media's report and coverage own it).
 */
export async function ownedRows(h: DbHandle): Promise<Record<string, number>> {
  const rows: Record<string, number> = {};
  for (const table of TABLES) {
    const [r] = await h.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
    rows[table] = Number(r?.n ?? 0);
  }
  return rows;
}

export const unit: SeedUnit = {
  name: "interact",
  after: ["social"],
  tables: TABLES,
  pending: [],
  async run(ctx) {
    const social = ctx.store.extra.social as { botUserId?: unknown } | undefined;
    if (!social || typeof social.botUserId !== "string")
      throw new Error("seed-interact: store.extra.social.botUserId is missing (seed-social runs first)");

    // Flags first: fail before writing anything.
    const secret = internalSecret(ctx.env);
    if (secret === undefined)
      throw new Error("seed-interact: INTERNAL_API_SECRET is not set (the interactivity test hook needs it)");
    const hooks = interactHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
    try {
      await hooks.tick(INTERACT_JOBS.tick);
    } catch (err) {
      if (err instanceof InteractHooksOff)
        throw new Error(
          "seed-interact: INTERACT_TEST_HOOKS is off: set INTERACT_TEST_HOOKS=true on the api and worker",
        );
      throw err;
    }
    const sessions = new SeedSessions(ctx.env, ctx.password, new Map(ctx.store.users.map((u) => [u.handle, u])));
    const d: ApiDeps = {
      sessions,
      slugs: new Map(ctx.store.channels.map((c) => [c.ownerHandle, c.slug])),
      step: stepRunner(ctx.signal),
    };
    try {
      return await seedInteract(ctx, d, sessions, hooks);
    } finally {
      // The forwarding proxy is this unit's local peer: stopped whatever happened.
      await sessions.close();
    }
  },
};

async function seedInteract(
  ctx: SeedContext,
  d: ApiDeps,
  sessions: SeedSessions,
  hooks: InteractHooks,
): Promise<SeedUnitReport> {
  const started = Date.now();
  const log = (line: string) => ctx.log.info(`seed-interact: ${line}`);
  const s1 = await sessions.as("streamer1");
  const { features } = await d.step("streamer1", "read the instance features", () => s1.api.client.instance.info());
  if (!features.giveaways) throw new Error("seed-interact: giveaways are off: set GIVEAWAYS_ENABLED=true on the api");

  const roster = await readRoster(ctx.db, ctx.store, ctx.now);
  // ctx.now is the start of the whole seed run, hours back at `large`; the worker reads only
  // sessions scored in its last 6 h, so watch time hangs off the clock now.
  const plan = planInteract(ctx.rng, ctx.scale, ctx.now, roster, new Date());
  const ids = {
    users: new Map(ctx.store.users.map((u) => [u.handle, u.id])),
    channels: new Map(ctx.store.channels.map((c) => [c.ownerHandle, c.id])),
  };
  const direct = await writeInteractDirect(ctx.db, plan, ids, { signal: ctx.signal });
  log(`direct rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const bots = await saveBotSettings(d, plan);
  const grants = await grantPoints(d, plan.grants);
  assertWatchInLookback(
    plan.watch.map((w) => w.scoredAt),
    Date.now(),
  );
  const accrual = await runAccrual(ctx.db, hooks, direct.sessionIds.length, { signal: ctx.signal, log: ctx.log });
  log(`accrual: ${accrual.counted} sessions, ${accrual.points} points in ${(accrual.ms / 1000).toFixed(1)} s`);
  const livePolls = await runLivePolls(d, plan.livePolls);

  // Offline predictions first (no playhead), then the guard, then the live window.
  for (const p of plan.predictions.filter((x) => !x.live)) await runPrediction(d, p);
  let surge = false;
  if (features.surgeGuard && plan.liveRaid) {
    const to = plan.liveRaid.to;
    const owner = await sessions.as(to);
    await d.step(to, "turn the surge guard on with Protect raids", () =>
      owner.api.client.chat.updateSettings({
        channel: d.slugs.get(to) ?? "",
        surgeGuard: { enabled: true, onRaid: true },
      }),
    );
    surge = true;
  }
  const liveRaid = plan.liveRaid;
  const liveOwners = liveRaid ? [liveRaid.from, liveRaid.to] : ["streamer1"];
  const live = await withLiveWindow(
    d,
    { env: ctx.env, log: ctx.log, signal: ctx.signal, owners: liveOwners },
    async () => {
      const raidId = liveRaid ? await startRaid(d, liveRaid.from, liveRaid.to) : null;
      for (const p of plan.predictions.filter((x) => x.live)) await runPrediction(d, p);
      const giveaways: GiveawayResult[] = [];
      for (const g of plan.giveaways) giveaways.push(await runGiveaway(d, g));
      const raid = raidId && liveRaid ? await waitRaidDone(d, liveRaid.from, raidId, ctx.signal) : null;
      return { giveaways, raid };
    },
  );
  const overlay = await mintOverlayTokens(d, "streamer1", plan.overlayMints);
  ctx.store.extra.interact = { ...interactExtra(overlay, live.giveaways) };

  const rows = await ownedRows(ctx.db);

  return {
    rows,
    notes: [
      `seed-interact: points accrual took ${(accrual.ms / 1000).toFixed(1)} s (${accrual.runs} points-accrue runs for ${accrual.counted} sessions, ${accrual.points} watch points)`,
      `seed-interact: CROSS-UNIT WRITE (pending a contract request): ${direct.rows.playback_sessions ?? 0} synthetic playback_sessions rows in seed-media's table, finished, verified (score 0.95), signed-in, no broadcast, synthetic device and address hashes, user agent \`CommonAir-demo-seed/1 (seed-interact)\`; not counted in this unit's rows. Accrual reads playback_sessions, not loyalty_accrual_sessions; the worker writes loyalty_accruals, loyalty_accrual_sessions and the watch ledger rows`,
      `seed-interact: points came through bot.points.adjust (${grants} grants and deductions by the owners), the worker's accrual, prediction bets, payouts and refunds, and bought poll votes; every loyalty row is real-time, so the points history shows today only`,
      `seed-interact: ${livePolls.polls} live polls (30 min) end on their own; past polls, raids, goals, song requests and bot rows are backdated`,
      "seed-interact: streamer2's prediction stays open until its 30-minute window locks it; streamer1 has one locked prediction (left locked), one resolved and one canceled, all real-time",
      `seed-interact: streamer1 and streamer2 were live for a short window (their real broadcasts and recordings are the stack's own); the live raid ended ${live.raid ?? "not started"}`,
      surge
        ? "seed-interact: streamer2 has the surge guard on with Protect raids; the live raid into it opens a surge for 10 minutes"
        : "seed-interact: CHAT_SURGE_GUARD is off on this instance, so no channel has Protect raids on and the live raid opened no surge",
      "seed-interact: the giveaways ask for no verified watching (the integrity scorer cannot verify viewers inside the unit's budget)",
      `seed-interact: bot1 is streamer1's bot and moderator; streamer2's bot account was created by the API (${bots.apiCreated} account, not in store.users)`,
      `seed-interact: ${sessions.signedIn} accounts signed in through the API, each from its own simulated address in 100.64.0.0/10 through the harness forwarding proxy (each adds a real session row)`,
    ],
  };
}
