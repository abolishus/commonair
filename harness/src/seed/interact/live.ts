// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-interact's own short live window: streamer1 and streamer2 publish a small test pattern over
 * RTMP (as the harness `Streamer` does), the live-only work runs while both are live (the raid from
 * streamer1 to streamer2, streamer1's predictions with playhead-stamped bets, the giveaways), then
 * both stop and the unit waits until the channels read offline again, so the next unit starts
 * from a quiet stack. The publishers are always stopped, whatever the work did.
 */
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "../../env.ts";
import { Streamer, rtmpPublishUrl } from "../../streamer.ts";
import { waitFor } from "../../wait.ts";
import type { ApiDeps } from "./api.ts";

/** How long a channel may take to read live (ingest, then the API's live flag). */
export const LIVE_TIMEOUT_MS = 60_000;
export const OFFLINE_TIMEOUT_MS = 90_000;
/** A raid counts down 30 s (`RAID_RULES.countdownSeconds`); the worker executes it within seconds. */
export const RAID_DONE_TIMEOUT_MS = 75_000;

export interface LiveWindowOptions {
  env: HarnessEnv;
  log: Logger;
  signal: AbortSignal;
  owners: readonly string[];
}

const live = async (d: ApiDeps, owner: string, slug: string) =>
  (await (await d.sessions.as(owner)).api.client.channels.get({ channel: slug })).live !== null;

/** Run `work` while every owner in `o.owners` is live. */
export async function withLiveWindow<T>(d: ApiDeps, o: LiveWindowOptions, work: () => Promise<T>): Promise<T> {
  const streamers: Streamer[] = [];
  const slugs = o.owners.map((owner) => {
    const s = d.slugs.get(owner);
    if (!s) throw new Error(`seed-interact: no channel for "${owner}" to go live on`);
    return { owner, slug: s };
  });
  try {
    for (const { owner, slug } of slugs) {
      const u = await d.sessions.as(owner);
      const { key } = await d.step(owner, "rotate the stream key to go live", () =>
        u.api.client.stream.rotateKey({ channel: slug }),
      );
      const s = new Streamer({
        name: `seed-interact-${owner}`,
        log: o.log,
        protocol: "rtmp",
        url: rtmpPublishUrl(o.env.HARNESS_RTMP_URL, key),
        width: 640,
        height: 360,
        bitrateKbps: 800,
      });
      streamers.push(s);
      await d.step(owner, "start publishing (ffmpeg over RTMP)", () => s.start());
    }
    for (const { owner, slug } of slugs)
      await d.step(owner, "wait until the channel is live", () =>
        waitFor(`${slug} live`, () => live(d, owner, slug), {
          timeoutMs: LIVE_TIMEOUT_MS,
          intervalMs: 500,
          signal: o.signal,
        }),
      );
    return await work();
  } finally {
    await Promise.allSettled(streamers.map((s) => s.stop()));
    // Best effort: an error from `work` must not be hidden by a slow offline transition.
    await Promise.allSettled(
      slugs.map(({ owner, slug }) =>
        waitFor(`${slug} offline`, async () => !(await live(d, owner, slug)), {
          timeoutMs: OFFLINE_TIMEOUT_MS,
          intervalMs: 1_000,
          signal: o.signal,
        }),
      ),
    );
  }
}

/** Start a raid through the API; the caller waits for it with `waitRaidDone` while both are live. */
export async function startRaid(d: ApiDeps, from: string, to: string): Promise<string> {
  const u = await d.sessions.as(from);
  const target = d.slugs.get(to);
  const source = d.slugs.get(from);
  if (!target || !source) throw new Error(`seed-interact: no channel for the raid ${from} → ${to}`);
  const raid = await d.step(from, `raid ${to}`, () =>
    u.api.client.interact.raids.start({ channel: source, to: target }),
  );
  return raid.id;
}

/** Wait until the raid is no longer pending; returns its final status. */
export async function waitRaidDone(d: ApiDeps, from: string, raidId: string, signal: AbortSignal): Promise<string> {
  const u = await d.sessions.as(from);
  const channel = d.slugs.get(from) ?? "";
  return d.step(from, "wait for the raid to execute", () =>
    waitFor(
      "raid executed",
      async () => {
        const s = await u.api.client.interact.raids.current({ channel });
        return s.raid && s.raid.id === raidId && s.raid.status !== "pending" ? s.raid.status : null;
      },
      { timeoutMs: RAID_DONE_TIMEOUT_MS, intervalMs: 1_000, signal },
    ),
  );
}
