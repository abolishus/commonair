// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 3 (raid) (docs/testing/e8-selectors.md, "Scenarios"). Both streamers go live; two
 * signed-in chat clients sit in the source's room, a third in the target's, and one HTTP viewer
 * watches the source until the integrity scorer makes it gate-eligible. `raids.start` sends the
 * `raid` frame `pending` to the source room; after the 30 s countdown and `raids-execute` the frame
 * is `completed` with `to` = the target, the target's outbox has `channel.raid` with the source's
 * gate-eligible viewer count, and the target's chat shows it inline. Then the target's policy
 * `off` refuses (`raid_refused`), and with it back on `anyone` the cooldown refuses
 * (`raid_cooldown`). Owned by E8-raids-goals.
 */
import { RAID_RULES } from "@commonair/contracts/enums";
import type { ChatClient } from "../chat-client.ts";
import { STEADY_TIMING, gateEligible } from "../integrity-viewers.ts";
import type { Streamer } from "../streamer.ts";
import { sleep, waitFor } from "../wait.ts";
import { type E8Run, type E8Streamer, waitLive } from "./kit.ts";

/** The scorer runs on its own schedule; a fresh HTTP viewer is gate-eligible within a few passes. */
const VERIFIED_TIMEOUT_MS = 180_000;
const FRAME_TIMEOUT_MS = 15_000;

/** `PRECONDITION_FAILED`'s `data.requirement` of an oRPC error, or null. */
export function requirementOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const r = (data as { requirement?: unknown }).requirement;
  return typeof r === "string" ? r : null;
}

/** The oRPC error code of an error, or null. */
export function codeOf(err: unknown): string | null {
  const c = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : null;
}

/** Run `fn`, expect it to fail, and return the error (a success is a step failure). */
export async function refusal(what: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error(`${what}: expected a refusal, but the call succeeded`);
}

/** The heartbeat window `raids-execute` counts open sessions in. */
export const RAID_HEARTBEAT_WINDOW_MS = 60_000;

export interface RaidSessionRow {
  userId: string | null;
  deviceHash: string;
  verdict: string;
  verdictReasons: readonly string[] | null;
  scoredAt: Date | null;
}

/**
 * The rule `raids-execute` applies (`raidViewersQuery` in `@commonair/interact`, which the harness
 * does not depend on), over open sessions with a recent heartbeat: `GATE_ELIGIBLE` (verified,
 * scored, fetches judged), distinct by account, else device.
 */
export function gateEligibleViewers(rows: readonly RaidSessionRow[]): number {
  const seen = new Set<string>();
  for (const r of rows)
    if (r.scoredAt !== null && gateEligible({ verdict: r.verdict, reasons: r.verdictReasons }))
      seen.add(r.userId ?? `device:${r.deviceHash}`);
  return seen.size;
}

/** A count read before and after execute brackets the one the job took (viewers come and go). */
export function viewersBracketed(viewers: number, before: number, after: number): boolean {
  return viewers >= Math.min(before, after) && viewers <= Math.max(before, after);
}

async function gateEligibleNow(run: E8Run, channelId: string): Promise<number> {
  const since = new Date(Date.now() - RAID_HEARTBEAT_WINDOW_MS);
  const rows = await run.db.query.playbackSessions.findMany({
    columns: { userId: true, deviceHash: true, verdict: true, verdictReasons: true, scoredAt: true },
    where: (ps, { and, eq, gt, isNull }) =>
      and(eq(ps.channelId, channelId), isNull(ps.endedAt), gt(ps.lastHeartbeatAt, since)),
  });
  return gateEligibleViewers(rows);
}

async function goLive(run: E8Run, s: E8Streamer): Promise<Streamer> {
  const streamer = await run.ctx.platform.streamerFor(s.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  run.ctx.defer(() => streamer.stop());
  await streamer.start();
  await waitLive(run.ctx, s.channel);
  return streamer;
}

async function chatIn(run: E8Run, user: E8Run["viewers"][number], channel: string): Promise<ChatClient> {
  const c = await run.ctx.platform.chat(user);
  run.ctx.defer(() => c.close());
  await c.join(channel);
  return c;
}

export async function stepRaid(run: E8Run): Promise<void> {
  const { ctx, streamer: src, target: dst } = run;
  const [v1, v2, v3] = run.viewers;
  if (!v1 || !v2 || !v3) throw new Error("the E8 run has fewer than three viewers");
  const raids = src.user.api.client.interact.raids;

  await ctx.step("raid: both streamers go live", () => Promise.all([goLive(run, src), goLive(run, dst)]));
  const [srcA, srcB, dstChat] = await ctx.step("raid: two chat clients in the source room, one in the target's", () =>
    Promise.all([chatIn(run, v1, src.channel), chatIn(run, v2, src.channel), chatIn(run, v3, dst.channel)]),
  );
  await ctx.step("raid: one HTTP viewer on the source until it is gate-eligible", async () => {
    const viewers = await ctx.platform.openViewers(src.channel, { http: 1, httpTiming: STEADY_TIMING });
    for (const v of viewers) ctx.defer(() => v.stop());
    await waitFor(
      `${src.channel}: a gate-eligible viewer`,
      async () => (await gateEligibleNow(run, src.channelId)) >= 1,
      {
        timeoutMs: VERIFIED_TIMEOUT_MS,
        intervalMs: 1_000,
        signal: ctx.signal,
      },
    );
  });

  const raid = await ctx.step("raid: start → pending, and the pending frame in the source room", async () => {
    const view = await raids.start({ channel: src.channel, to: dst.channel });
    ctx.assert("raid: pending, to the target", view.status === "pending" && view.to === dst.channel, view);
    for (const [name, c] of [
      ["A", srcA],
      ["B", srcB],
    ] as const) {
      const f = await c.waitFor("raid", (x) => x.raidId === view.id && x.status === "pending", FRAME_TIMEOUT_MS);
      ctx.assert(
        `raid: chat client ${name} got the pending frame`,
        f.to === dst.channel && f.executeAt === view.executeAt,
        f,
      );
    }
    return view;
  });

  const executed = await ctx.step("raid: countdown, raids-execute → completed", async () => {
    const wait = Date.parse(raid.executeAt) - Date.now();
    ctx.assert(
      "raid: the countdown is the instance constant",
      Date.parse(raid.executeAt) - Date.parse(raid.createdAt) === RAID_RULES.countdownSeconds * 1000,
      raid,
    );
    if (wait > 0) await sleep(wait + 250, ctx.signal);
    const before = await gateEligibleNow(run, src.channelId);
    // The scheduled job may already have run it (every 2 s); the tick makes it run now either way.
    await run.hooks.tick("raids-execute");
    const after = await gateEligibleNow(run, src.channelId);
    const state = await waitFor(
      "raid completed",
      async () => {
        const s = await raids.current({ channel: src.channel });
        return s.raid?.id === raid.id && s.raid.status !== "pending" ? s : null;
      },
      { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    );
    ctx.assert("raid: completed", state.raid?.status === "completed", state);
    ctx.assert("raid: the cooldown runs", state.cooldownEndsAt !== null, state);
    return { view: state.raid, before, after };
  });

  await ctx.step(
    "raid: completed frame, channel.raid on the target, the inline event in the target's chat",
    async () => {
      for (const c of [srcA, srcB]) {
        const f = await c.waitFor("raid", (x) => x.raidId === raid.id && x.status === "completed", FRAME_TIMEOUT_MS);
        ctx.assert("raid: completed frame names the target", f.to === dst.channel, f);
      }
      const ev = await run.db.query.events.findFirst({
        where: (e, { and, eq }) => and(eq(e.type, "channel.raid"), eq(e.channelId, dst.channelId)),
      });
      const payload = (ev?.payload ?? {}) as { viewers?: number; from_broadcaster_user_login?: string };
      const viewers = payload.viewers ?? -1;
      ctx.data("raidViewers", { viewers, gateEligibleBefore: executed.before, gateEligibleAfter: executed.after });
      ctx.assert(
        "raid: channel.raid in the target's outbox from the source",
        payload.from_broadcaster_user_login === src.channel,
        ev,
      );
      ctx.assert(
        "raid: viewers = the source's gate-eligible count",
        viewers >= 1 &&
          viewersBracketed(viewers, executed.before, executed.after) &&
          viewers === executed.view?.viewerCount,
        { viewers, executed },
      );
      const inline = await dstChat.waitFor(
        "event",
        (f) => f.type === "channel.raid" && f.data.from_broadcaster_user_login === src.channel,
        FRAME_TIMEOUT_MS,
      );
      ctx.assert("raid: the target's chat shows the raid with its viewers", inline.data.viewers === viewers, inline);
    },
  );

  await ctx.step("raid: the target's policy off refuses (raid_refused)", async () => {
    await dst.user.api.client.interact.raids.setPolicy({ channel: dst.channel, policy: "off" });
    // The policy is checked before the cooldown the first raid started.
    const err = await refusal("start against policy off", () => raids.start({ channel: src.channel, to: dst.channel }));
    ctx.assert("raid: raid_refused", requirementOf(err) === "raid_refused", {
      code: codeOf(err),
      requirement: requirementOf(err),
    });
    await dst.user.api.client.interact.raids.setPolicy({ channel: dst.channel, policy: "anyone" });
  });

  await ctx.step("raid: a second start inside the cooldown refuses (raid_cooldown)", async () => {
    const err = await refusal("start inside the cooldown", () =>
      raids.start({ channel: src.channel, to: dst.channel }),
    );
    ctx.assert("raid: raid_cooldown", requirementOf(err) === "raid_cooldown", {
      code: codeOf(err),
      requirement: requirementOf(err),
    });
  });
}
