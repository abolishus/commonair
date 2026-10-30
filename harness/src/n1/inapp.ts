// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 1 (N1-fanout): a follower gets one in-app `go_live` row when the channel goes live
 * (docs/testing/n1-selectors.md "Scenarios" 1). The viewer follows the first streamer with the
 * bell on, the streamer publishes, and within 30 s `me.notifications` holds exactly one `go_live`
 * row for that channel, `{ channelId, slug, broadcastId, title }`, and the unread count is 1. The
 * publisher stops at the end, so step 3 can restart the channel.
 */
import { GoLiveNotificationPayload } from "@commonair/contracts/notify";
import type { ScenarioContext } from "../scenario.ts";
import type { Streamer } from "../streamer.ts";
import type { SignedInUser } from "../users.ts";
import { waitLive, type E8Streamer } from "../e8/kit.ts";
import { sleep, waitFor } from "../wait.ts";
import type { N1Run, N1Step } from "./run.ts";

/** The scenario's budget for the row to appear (contract step §8 step 1). */
export const IN_APP_BUDGET_MS = 30_000;
/** How long the harness waits before failing: the budget plus slack for a loaded runner (reported as a soft check). */
export const IN_APP_TIMEOUT_MS = 60_000;
const OFFLINE_TIMEOUT_MS = 30_000;
/** A second look for a duplicate row (a redelivered job must not add one). */
const RECHECK_MS = 2_000;

/** One `me.notifications` item, as the API returns it. */
export interface NotificationItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
}

/** The `go_live` items about one channel. Pure. */
export function goLiveRowsFor<T extends Pick<NotificationItem, "type" | "payload">>(
  items: readonly T[],
  channelId: string,
): T[] {
  return items.filter((i) => i.type === "go_live" && i.payload.channelId === channelId);
}

export interface ExpectedGoLive {
  channelId: string;
  slug: string;
  broadcastId: string;
  /** The broadcast's title as the viewer may see it ("" for mature to an unconfirmed viewer). */
  title: string;
}

/** What is wrong with a `go_live` payload (empty: nothing). Pure. */
export function payloadProblems(payload: unknown, expected: ExpectedGoLive): string[] {
  const parsed = GoLiveNotificationPayload.strict().safeParse(payload);
  if (!parsed.success) return parsed.error.issues.map((i) => `payload ${i.path.join(".") || "(root)"}: ${i.message}`);
  const problems: string[] = [];
  for (const key of ["channelId", "slug", "broadcastId", "title"] as const)
    if (parsed.data[key] !== expected[key])
      problems.push(
        `payload ${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(parsed.data[key])}`,
      );
  return problems;
}

/** The viewer's newest notifications (one page is plenty: the viewer is fresh to this run). */
export async function viewerNotifications(viewer: SignedInUser): Promise<NotificationItem[]> {
  const page = await viewer.api.client.me.notifications({ limit: 100 });
  return page.items;
}

/** Publish `s` until stopped and wait for the channel to be live; returns the publisher and the broadcast. */
export async function publishUntilLive(
  run: Pick<N1Run, "ctx">,
  s: E8Streamer,
): Promise<{ publisher: Streamer; broadcastId: string; title: string; mature: boolean }> {
  const { ctx } = run;
  const publisher = await ctx.platform.streamerFor(s.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  ctx.defer(() => publisher.stop());
  await publisher.start();
  await waitLive(ctx, s.channel);
  const live = (await ctx.platform.api().client.channels.get({ channel: s.channel })).live;
  if (!live) throw new Error(`${s.channel} went offline right after going live`);
  return { publisher, broadcastId: live.id, title: live.title, mature: live.mature };
}

/** Stop the publisher and wait until the API reports the channel offline. */
export async function stopUntilOffline(ctx: ScenarioContext, s: E8Streamer, publisher: Streamer): Promise<void> {
  await publisher.stop();
  await waitFor(
    `${s.channel} offline`,
    async () => (await ctx.platform.api().client.channels.get({ channel: s.channel })).live === null,
    { timeoutMs: OFFLINE_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
  );
}

async function run(r: N1Run): Promise<void> {
  const { ctx } = r;
  const { viewer } = r.actors;
  const s = r.actors.streamers[0];

  await ctx.step("1. in-app: the viewer follows the first streamer, bell on", async () => {
    await viewer.api.client.channels.follow({ channel: s.channel, notify: true });
  });
  const live = await ctx.step("1. in-app: the first streamer goes live", () => publishUntilLive(r, s));
  const startedAt = Date.now();
  r.state.firstChannel = s.channel;

  const rows = await ctx.step("1. in-app: one go_live row arrives", () =>
    waitFor(
      `a go_live notification for ${s.channel}`,
      async () => {
        const found = goLiveRowsFor(await viewerNotifications(viewer), s.channelId);
        return found.length > 0 ? found : null;
      },
      { timeoutMs: IN_APP_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
    ),
  );
  const latencyMs = Date.now() - startedAt;
  ctx.metric("n1.inapp.latency", latencyMs, "ms");
  ctx.check("1. in-app: the row arrived within 30 s of going live", latencyMs <= IN_APP_BUDGET_MS, { latencyMs });

  await ctx.step("1. in-app: exactly one row, the contract payload, unread", async () => {
    await sleep(RECHECK_MS, ctx.signal);
    const again = goLiveRowsFor(await viewerNotifications(viewer), s.channelId);
    ctx.assert("1. in-app: exactly one go_live row for the channel", again.length === 1, { count: again.length });
    const row = again[0] ?? rows[0];
    const problems = payloadProblems(row?.payload, {
      channelId: s.channelId,
      slug: s.channel,
      broadcastId: live.broadcastId,
      // The viewer never confirmed 18+: a mature broadcast arrives without its title.
      title: live.mature ? "" : live.title,
    });
    ctx.assert("1. in-app: the payload is { channelId, slug, broadcastId, title }", problems.length === 0, problems);
    ctx.assert("1. in-app: the row is unread", row?.readAt === null, { readAt: row?.readAt });
  });

  await ctx.step("1. in-app: the unread count is 1", async () => {
    const unread = await viewer.api.client.notifications.unreadCount();
    ctx.assert("1. in-app: notifications.unreadCount is 1", unread.count === 1 && !unread.capped, unread);
  });

  // Step 3 restarts the channel: leave it offline.
  await ctx.step("1. in-app: the first streamer stops", () => stopUntilOffline(ctx, s, live.publisher));
}

export const step: N1Step = {
  name: "in-app",
  owner: "N1-fanout",
  needs: [],
  run,
};
