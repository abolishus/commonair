// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `KEYS.chatLatency` writer (ADR 0012 amendment 1 decision 4) against real Postgres and Valkey. */
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { FETCH_UNJUDGED } from "@commonair/integrity";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  CHAT_LATENCY_STALE_SECONDS,
  CHAT_LATENCY_TTL_SECONDS,
  channelLatencies,
  latencySecondsText,
  writeChatLatency,
} from "../src/integrity/chat-latency.ts";
import { runScoring } from "../src/integrity/jobs.ts";
import { makeBroadcast, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;

/** A channel live on a broadcast that started ten minutes ago. */
async function liveChannel() {
  const { channel } = await makeUser(env.t.db);
  const b = await makeBroadcast(env.t.db, channel.id, new Date(Date.now() - 600_000));
  await env.t.db.update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, channel.id));
  return { channelId: channel.id, broadcastId: b.id };
}

/** A gate-eligible session (verified, scored, fetches judged) unless `over` says otherwise. */
async function session(
  live: { channelId: string; broadcastId: string | null },
  latencyMs: number | null,
  over: Partial<typeof schema.playbackSessions.$inferInsert> = {},
) {
  await env.t.db.insert(schema.playbackSessions).values({
    id: uuidv7(),
    channelId: live.channelId,
    broadcastId: live.broadcastId,
    deviceHash: crypto.randomUUID(),
    ipHash: crypto.randomUUID(),
    verdict: "verified",
    scoredAt: new Date(),
    latencyMs,
    ...over,
  });
}

describe("writeChatLatency", () => {
  test("medians, quorum, eligibility and the cap", async () => {
    // Three eligible reports: median 4 s. Everything else on the channel is ignored.
    const median = await liveChannel();
    for (const ms of [2_000, 4_000, 9_000]) await session(median, ms);
    await session(median, 50_000, { verdict: "excluded" });
    await session(median, 50_000, { verdict: "pending", scoredAt: null });
    await session(median, 50_000, { scoredAt: null });
    await session(median, 50_000, { verdictReasons: [FETCH_UNJUDGED] });
    await session(median, 50_000, { endedAt: new Date() });
    // Open but silent past the stale window (a closed tab the stale-session job has not reached).
    const silent = new Date(Date.now() - (CHAT_LATENCY_STALE_SECONDS + 30) * 1000);
    await session(median, 50_000, { startedAt: silent, lastHeartbeatAt: silent });
    await session(median, 50_000, { startedAt: silent, lastHeartbeatAt: null });
    await session(median, null);
    // A session of an earlier broadcast of the same channel.
    const earlier = await makeBroadcast(env.t.db, median.channelId, new Date(Date.now() - 86_400_000));
    await session({ channelId: median.channelId, broadcastId: earlier.id }, 50_000);

    // Two eligible reports (plus excluded ones): below the quorum, nothing written.
    const tooFew = await liveChannel();
    await session(tooFew, 3_000);
    await session(tooFew, 5_000);
    await session(tooFew, 5_000, { verdict: "excluded" });
    await session(tooFew, 5_000, { verdictReasons: [FETCH_UNJUDGED] });

    // An even count interpolates; the cap applies to the median.
    const even = await liveChannel();
    for (const ms of [1_000, 2_000, 3_000, 4_000]) await session(even, ms);
    const capped = await liveChannel();
    for (const ms of [70_000, 80_000, 90_000]) await session(capped, ms);
    const negative = await liveChannel();
    for (const ms of [-3_000, -2_000, -1_000]) await session(negative, ms);

    // A channel that is not live: its sessions do not count.
    const { channel: offline } = await makeUser(env.t.db);
    const ended = await makeBroadcast(env.t.db, offline.id, new Date(Date.now() - 600_000));
    for (const ms of [1_000, 1_000, 1_000]) await session({ channelId: offline.id, broadcastId: ended.id }, ms);

    const medians = await channelLatencies(ctx());
    expect(Object.fromEntries(medians)).toEqual({
      [median.channelId]: 4_000,
      [even.channelId]: 2_500,
      [capped.channelId]: 60_000,
      [negative.channelId]: 0,
    });

    expect(await writeChatLatency(ctx())).toEqual({ channels: 4 });
    const v = ctx().valkey;
    expect(await v.get(KEYS.chatLatency(median.channelId))).toBe("4");
    expect(await v.get(KEYS.chatLatency(even.channelId))).toBe("2.5");
    expect(await v.get(KEYS.chatLatency(capped.channelId))).toBe("60");
    expect(await v.get(KEYS.chatLatency(negative.channelId))).toBe("0");
    expect(await v.get(KEYS.chatLatency(tooFew.channelId))).toBeNull();
    expect(await v.get(KEYS.chatLatency(offline.id))).toBeNull();
    const ttl = await v.ttl(KEYS.chatLatency(median.channelId));
    expect(ttl).toBeGreaterThan(CHAT_LATENCY_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(CHAT_LATENCY_TTL_SECONDS);

    // A third eligible report brings the quorum: the next pass writes the key.
    await session(tooFew, 4_000);
    await writeChatLatency(ctx());
    expect(await v.get(KEYS.chatLatency(tooFew.channelId))).toBe("4");
  });

  test("runs at the end of each scoring pass", async () => {
    const live = await liveChannel();
    for (const ms of [6_000, 7_000, 8_000]) await session(live, ms);
    // The pass's clock a minute back, so scoring leaves these heartbeat-less fixtures alone (it only
    // rescores sessions started by `now`) and the writer sees them verified, whatever the skew
    // between this host and Postgres.
    const counts = await runScoring({ ...ctx(), now: () => new Date(Date.now() - 60_000) });
    expect(counts.chatLatencyChannels).toBeGreaterThanOrEqual(1);
    expect(await ctx().valkey.get(KEYS.chatLatency(live.channelId))).toBe("7");
  });

  test("seconds keep millisecond precision", () => {
    expect(latencySecondsText(4_000)).toBe("4");
    expect(latencySecondsText(2_345.6)).toBe("2.346");
    expect(latencySecondsText(0)).toBe("0");
  });
});
