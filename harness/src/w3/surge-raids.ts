// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` W3 extension `surge-raid` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0039 §4,
 * batch 7 decision (w)):
 *
 * 1. The target turns the surge guard on with "Protect raids" (`surgeGuard.onRaid`).
 * 2. A source with three signed-in verified viewers, a datacenter viewbot swarm and signed-in
 *    fetch-less bots (the `integrity-basic` / `surge-guard` bots) raids the target.
 * 3. The surge opens with `trigger: "raid"` (the outbox and audit rows, `chat.surge.state`).
 * 4. The three verified raiders chat on the target at once (their standing carried); the bots are
 *    refused with the surge notice (`msg_verified_watch`).
 * 5. A moderator override ends the surge (`suppressed`, `chat.surge.end` reason `moderator`).
 *
 * Every named actor is this step's own: both streamers, the raiders and the bots (the run's
 * streamers may be cooling down from step 3's raid). Needs `CHAT_SURGE_GUARD` on
 * (harness/compose.w1.yaml, part of the harness stack) and the interactivity test hook.
 */
import { RAID_RULES } from "@commonair/contracts/enums";
import type { ChatClient } from "../chat-client.ts";
import { type E8Streamer, newE8Streamer, waitLive } from "../e8/kit.ts";
import { HttpViewer } from "../http-viewer.ts";
import { HeartbeatOnlyViewer, STEADY_TIMING, gateEligible } from "../integrity-viewers.ts";
import type { SignedInUser } from "../users.ts";
import { ViewbotSwarm } from "../viewbot.ts";
import { sleep, waitFor } from "../wait.ts";
import { attempt, type SendResult } from "../w1/surge.ts";
import type { InteractW3Extension } from "./kit.ts";

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** Three verified raiders (the brief's real raid). */
export const RAIDERS = 3;
/** Signed-in fetch-less bots: they watch the source and then try the target's chat. */
export const CHAT_BOTS = 3;
/** Anonymous datacenter viewbots padding the source's audience (never verified, never carried). */
export const SWARM = 6;
/** The scorer runs on its own schedule; a fresh HTTP viewer is gate-eligible within a few passes. */
export const VERIFIED_TIMEOUT_MS = 180_000;
/** Chat caches the override 3 s and a verified value 5 s: retry a raider's send this long. */
export const CHAT_SETTLE_MS = 20_000;
const FRAME_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 30_000;

/** Step 4's expectation: every raider accepted, every bot refused with the gate's notice. */
export function raidChatOutcome(
  raiders: readonly SendResult[],
  bots: readonly SendResult[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (raiders.length === 0) problems.push("no raider tried");
  if (bots.length === 0) problems.push("no bot tried");
  for (const r of raiders) if (!r.accepted) problems.push(`raider ${r.user}: refused with ${r.code}`);
  for (const b of bots)
    if (b.accepted || b.code !== "msg_verified_watch")
      problems.push(`bot ${b.user}: expected msg_verified_watch, got ${b.accepted ? "accepted" : b.code}`);
  return { ok: problems.length === 0, problems };
}

/** A `chat.surge.begin` payload a raid wrote: `trigger: "raid"`, no moderator, ending about surgeMinutes after `executedAt`. */
export function raidBeginOk(payload: Record<string, unknown> | undefined, executedAt: Date, slackMs = 60_000): boolean {
  if (!payload || payload.trigger !== "raid" || payload.by_user_id !== null) return false;
  const until = typeof payload.until === "string" ? Date.parse(payload.until) : Number.NaN;
  const expected = executedAt.getTime() + RAID_RULES.surgeMinutes * 60_000;
  return Number.isFinite(until) && Math.abs(until - expected) <= slackMs;
}

// ------------------------------------------------------------------ the step

async function goLive(run: InteractW3Extension, s: E8Streamer): Promise<void> {
  const encoder = await run.ctx.platform.streamerFor(s.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  run.ctx.defer(() => encoder.stop());
  await encoder.start();
  await run.ctx.platform.waitForLive(s.channel, true, LIVE_TIMEOUT_MS);
  await waitLive(run.ctx, s.channel);
}

async function chatIn(run: InteractW3Extension, user: SignedInUser, channel: string): Promise<ChatClient> {
  const c = await run.ctx.platform.chat(user);
  run.ctx.defer(() => c.close());
  await c.join(channel);
  return c;
}

/** Users among `userIds` with a gate-eligible session on `channelId` and a recent heartbeat. */
async function verifiedOn(run: InteractW3Extension, channelId: string, userIds: readonly string[]): Promise<number> {
  const since = new Date(Date.now() - 60_000);
  const rows = await run.db.query.playbackSessions.findMany({
    columns: { userId: true, verdict: true, verdictReasons: true, scoredAt: true },
    where: (ps, { and, eq, gt, inArray, isNull }) =>
      and(
        eq(ps.channelId, channelId),
        inArray(ps.userId, [...userIds]),
        isNull(ps.endedAt),
        gt(ps.lastHeartbeatAt, since),
      ),
  });
  const ok = new Set<string>();
  for (const r of rows)
    if (r.userId && r.scoredAt !== null && gateEligible({ verdict: r.verdict, reasons: r.verdictReasons }))
      ok.add(r.userId);
  return ok.size;
}

async function surgeRows(run: InteractW3Extension, channelId: string) {
  const [events, audits] = await Promise.all([
    run.db.query.events.findMany({
      columns: { type: true, payload: true, occurredAt: true },
      where: (e, { and, eq, inArray }) =>
        and(eq(e.channelId, channelId), inArray(e.type, ["chat.surge.begin", "chat.surge.end"])),
      orderBy: (e, { asc }) => [asc(e.occurredAt)],
    }),
    run.db.query.auditLog.findMany({
      columns: { action: true, details: true },
      where: (a, { and, eq }) => and(eq(a.channelId, channelId), eq(a.subjectType, "channel")),
    }),
  ]);
  return { events: events.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> })), audits };
}

export async function stepSurgeRaid(run: InteractW3Extension): Promise<void> {
  const { ctx } = run;
  const p = ctx.platform;

  const features = (await p.api().client.instance.info()).features;
  if (!features.surgeGuard)
    throw new Error(
      "surge-raid: the instance surge guard is off (CHAT_SURGE_GUARD); start the harness stack, which layers harness/compose.w1.yaml",
    );

  const [src, dst] = await ctx.step("surge-raid: sign up a source and a target streamer", () =>
    Promise.all([newE8Streamer(ctx, "w3srs"), newE8Streamer(ctx, "w3srt")]),
  );
  const [raiders, bots] = await ctx.step("surge-raid: sign up three raiders and the chatting bots", () =>
    Promise.all([
      Promise.all(Array.from({ length: RAIDERS }, () => p.signUp({ prefix: "w3srv" }))),
      Promise.all(Array.from({ length: CHAT_BOTS }, () => p.signUp({ prefix: "w3srb" }))),
    ]),
  );
  const targetApi = dst.user.api.client;

  // 1.
  await ctx.step("surge-raid: the target turns the guard on with Protect raids (its own gate 0)", async () => {
    const s = await targetApi.chat.updateSettings({
      channel: dst.channel,
      minVerifiedWatchSeconds: 0,
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10, onRaid: true },
    });
    ctx.assert("surge-raid: guard on, Protect raids on", s.surgeGuard.enabled && s.surgeGuard.onRaid, s.surgeGuard);
  });

  await ctx.step("surge-raid: both streamers go live", () => Promise.all([goLive(run, src), goLive(run, dst)]));

  // 2.
  await ctx.step(
    `surge-raid: ${RAIDERS} signed-in viewers, ${SWARM} viewbots and ${CHAT_BOTS} fetch-less bots watch the source`,
    async () => {
      const honest = raiders.map(
        (u) =>
          new HttpViewer({
            id: `w3sr-raider-${u.username}`,
            target: { channel: src.channel },
            api: p.api({ jar: u.api.jar }).client,
            timing: STEADY_TIMING,
            log: p.log,
          }),
      );
      const fetchless = bots.map(
        (u) =>
          new HeartbeatOnlyViewer({
            id: `w3sr-bot-${u.username}`,
            api: p.api({ jar: u.api.jar }).client,
            channel: src.channel,
            log: p.log,
          }),
      );
      const swarm = new ViewbotSwarm({ channel: src.channel, sessions: SWARM }, p.datacenter, (o) => p.api(o), p.log);
      for (const v of [...honest, ...fetchless, swarm]) ctx.defer(() => v.stop());
      await Promise.all([...honest.map((v) => v.start()), ...fetchless.map((v) => v.start()), swarm.start()]);
    },
  );
  const raiderIds = raiders.map((u) => u.me.id);
  await ctx.step("surge-raid: the three raiders are gate-eligible on the source", () =>
    waitFor(
      `${src.channel}: ${RAIDERS} verified raiders`,
      async () => (await verifiedOn(run, src.channelId, raiderIds)) >= RAIDERS,
      { timeoutMs: VERIFIED_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  const botChats = await Promise.all(bots.map((u) => chatIn(run, u, dst.channel)));
  const raiderChats = await Promise.all(raiders.map((u) => chatIn(run, u, dst.channel)));
  const modWatch = await chatIn(run, dst.user, dst.channel);

  const raids = src.user.api.client.interact.raids;
  const executedAt = await ctx.step("surge-raid: the source raids the target; countdown, raids-execute", async () => {
    const view = await raids.start({ channel: src.channel, to: dst.channel });
    const wait = Date.parse(view.executeAt) - Date.now();
    if (wait > 0) await sleep(wait + 250, ctx.signal);
    await run.hooks.tick("raids-execute");
    const state = await waitFor(
      "surge-raid: raid completed",
      async () => {
        const s = await raids.current({ channel: src.channel });
        return s.raid?.id === view.id && s.raid.status !== "pending" ? s : null;
      },
      { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    );
    ctx.assert("surge-raid: the raid completed", state.raid?.status === "completed", state);
    ctx.data("surgeRaid.raid", state.raid);
    const r = await run.db.query.raids.findFirst({
      columns: { executedAt: true },
      where: (x, { eq }) => eq(x.id, view.id),
    });
    return r?.executedAt ?? new Date();
  });

  // 3.
  await ctx.step("surge-raid: the surge opens with trigger raid", async () => {
    await modWatch.waitFor("surge", (f) => f.channel === dst.channel && f.state === "on", FRAME_TIMEOUT_MS);
    const state = await targetApi.chat.surge.state({ channel: dst.channel });
    ctx.data("surgeRaid.state", state);
    ctx.assert("surge-raid: chat.surge.state is on", state.state === "on", state);
    // `raid` reaches the API once its read of the override's raid field is merged (contract request).
    ctx.check(
      "surge-raid: chat.surge.state names the source and its verified count",
      state.raid?.fromChannel === src.channel && (state.raid?.verifiedCount ?? 0) >= RAIDERS,
      state.raid ?? null,
    );
    const rows = await surgeRows(run, dst.channelId);
    ctx.data("surgeRaid.rows", rows);
    const begin = rows.events.find((e) => e.type === "chat.surge.begin");
    ctx.assert(
      "surge-raid: chat.surge.begin {trigger: raid} for surgeMinutes",
      raidBeginOk(begin?.payload, executedAt),
      begin,
    );
    ctx.assert(
      "surge-raid: its audit row names the raid",
      rows.audits.some(
        (a) => a.action === "chat.surge.begin" && (a.details as { trigger?: unknown }).trigger === "raid",
      ),
      rows.audits,
    );
  });

  // 4.
  await ctx.step("surge-raid: the verified raiders chat at once; the bots get the surge notice", async () => {
    const raiderResults = await Promise.all(
      raiders.map((u, i) => {
        const chat = raiderChats[i];
        if (!chat) throw new Error("no raider chat");
        return waitFor(
          `${u.username} accepted on ${dst.channel}`,
          async () => {
            const r = await attempt(chat, dst.channel, u.username, `raider ${crypto.randomUUID().slice(0, 8)}`);
            return r.accepted ? r : null;
          },
          { timeoutMs: CHAT_SETTLE_MS, intervalMs: 4_000, signal: ctx.signal },
        ).catch(async () => attempt(chat, dst.channel, u.username, `raider last ${crypto.randomUUID().slice(0, 8)}`));
      }),
    );
    const botResults = await Promise.all(
      bots.map((u, i) => {
        const chat = botChats[i];
        if (!chat) throw new Error("no bot chat");
        return attempt(chat, dst.channel, u.username, `bot ${crypto.randomUUID().slice(0, 8)}`);
      }),
    );
    ctx.data("surgeRaid.chat", { raiders: raiderResults, bots: botResults });
    const o = raidChatOutcome(raiderResults, botResults);
    ctx.assert("surge-raid: raiders accepted, bots refused with msg_verified_watch", o.ok, o.problems);
  });

  // 5.
  await ctx.step("surge-raid: a moderator override ends the surge", async () => {
    const ended = await targetApi.chat.surge.override({ channel: dst.channel, action: "end" });
    ctx.assert("surge-raid: the override is suppressed", ended.state === "suppressed", ended);
    await modWatch.waitFor("surge", (f) => f.channel === dst.channel && f.state === "suppressed", FRAME_TIMEOUT_MS);
    const rows = await surgeRows(run, dst.channelId);
    const end = rows.events.filter((e) => e.type === "chat.surge.end").at(-1);
    ctx.assert("surge-raid: chat.surge.end with reason moderator", end?.payload.reason === "moderator", end);
  });
}
