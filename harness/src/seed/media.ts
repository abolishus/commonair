// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-media: broadcasts, VODs, clips, playback, simulcast, relays and `seed live`. Brief: `.claude/briefs/seed-full/seed-media.md`. */
import { INTERNAL_ROUTES } from "@commonair/contracts/internal";
import { probeFfmpeg } from "../ffmpeg.ts";
import { Platform } from "../platform.ts";
import { relayReadiness } from "../relay.ts";
import { internalSecret, mediaBucketConfig } from "../safety-io.ts";
import { generateSpeechFixture } from "../w2/captions/fixture.ts";
import { type SeedRelay, type RtmpSink, startRelay, startRtmpSink } from "./media/peers.ts";
import { buildMediaExtra } from "./media/extra.ts";
import { type ChatWindowRef, MEMBER_HOURS_DAYS, planHistory, planRecordings } from "./media/plan.ts";
import { MediaSessions, opsHook, recordAll } from "./media/record.ts";
import { channelsWithoutMemberHours, linkChat, writeHistory } from "./media/write.ts";
import type { SeedContext, SeedUnit } from "./types.ts";

const TABLES = [
  "broadcasts",
  "stream_hours",
  "broadcast_health_samples",
  "egress_samples",
  "vods",
  "clips",
  "playback_sessions",
  "simulcast_targets",
  "simulcast_sessions",
  "relay_nodes",
  "relay_issuance",
  "relay_receipts",
  // W2: captions, rehearsal invitees and the audience rollup.
  "broadcast_caption_tracks",
  "caption_edits",
  "rehearsal_invitees",
  "broadcast_audience_minutes",
  "broadcast_audience_totals",
  "broadcast_costs",
  "analytics_share_links",
  // Batch 7: relay purge rows.
  "relay_purges",
  // Batch 7: watch rooms open on a live broadcast, so they come from seed-media's recordings.
  "watch_rooms",
  "watch_room_members",
  "watch_room_messages",
] as const;

/** Counted before and after the recordings: what the services wrote is the difference. */
export const API_TABLES: readonly string[] = TABLES;

interface ApiHealth {
  opsTestHooks?: unknown;
  outboundPrivateNetworks?: unknown;
}

/** Every stack flag seed-media needs, checked before it writes anything. Throws with the exact flag. */
async function checkFlags(ctx: SeedContext): Promise<void> {
  const res = await fetch(new URL("/healthz", ctx.env.HARNESS_API_URL), { signal: AbortSignal.timeout(5_000) }).catch(
    () => null,
  );
  const health = (res?.ok ? await res.json().catch(() => null) : null) as ApiHealth | null;
  if (!health) throw new Error(`seed-media: the API at ${ctx.env.HARNESS_API_URL} did not answer /healthz`);
  if (health.opsTestHooks !== true)
    throw new Error("seed-media: set OPS_TEST_HOOKS=true on the api (analytics tick and display bypass)");
  if (health.outboundPrivateNetworks !== true)
    throw new Error(
      "seed-media: set OUTBOUND_ALLOW_PRIVATE_NETWORKS=true on the api and media (the LAN relay and the local RTMP sink)",
    );
  if (!internalSecret(ctx.env)) throw new Error("seed-media: INTERNAL_API_SECRET is not set (the test hooks need it)");
  await probeFfmpeg().catch(() => {
    throw new Error("seed-media: ffmpeg is not on PATH (the recordings publish with it)");
  });
  const relay = await relayReadiness({ ...process.env, HARNESS_API_URL: ctx.env.HARNESS_API_URL });
  if (relay) throw new Error(`seed-media: the member relay cannot run: ${relay}`);
}

function socialWindows(ctx: SeedContext): { windows: ChatWindowRef[]; categoryIds: string[] } {
  const social = ctx.store.extra.social as { chatWindows?: unknown; categoryIds?: unknown } | undefined;
  if (!social || !Array.isArray(social.chatWindows))
    throw new Error("seed-media: store.extra.social.chatWindows is missing (seed-social runs first)");
  const windows = (social.chatWindows as ChatWindowRef[]).map((w) => ({
    channelId: w.channelId,
    start: new Date(w.start),
    end: new Date(w.end),
  }));
  const categoryIds = Array.isArray(social.categoryIds) ? (social.categoryIds as string[]) : [];
  return { windows, categoryIds };
}

async function countRows(ctx: SeedContext, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const rows = await ctx.db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

/** Streamers seed-coop expects to be streamer members after the sync (the bulk streamers too). */
const MEMBER_STREAMERS = ["streamer1", "streamer2", "streamer3", "council1", "council2"];

async function ownersWithoutMemberHours(ctx: SeedContext): Promise<string[]> {
  const handles = new Set(
    ctx.store.users
      .filter((u) => u.kind === "bulk-streamer" || MEMBER_STREAMERS.includes(u.handle))
      .map((u) => u.handle),
  );
  const channels = ctx.store.channels.filter((c) => handles.has(c.ownerHandle));
  const missing = new Set(
    await channelsWithoutMemberHours(
      ctx.db,
      channels.map((c) => c.id),
      ctx.now,
    ),
  );
  return channels.filter((c) => missing.has(c.id)).map((c) => c.ownerHandle);
}

export const unit: SeedUnit = {
  name: "media",
  // interact: it puts streamer1 and streamer2 on air and writes playback_sessions, which this unit
  // counts as its own rows (before and after the recordings), so they never run side by side.
  after: ["social", "interact"],
  tables: TABLES,
  pending: [],
  async run(ctx) {
    const progress = (line: string) => ctx.log.info(`seed-media: ${line}`);
    await checkFlags(ctx);
    const audioPath = generateSpeechFixture();
    const notes: string[] = [];

    // 1. Backdated history over seed-social's chat windows (plain tables, direct inserts).
    const { windows, categoryIds } = socialWindows(ctx);
    const history = planHistory(
      ctx.rng.fork("history"),
      { channels: ctx.store.channels, windows, categoryIds },
      ctx.now,
    );
    const written = await writeHistory(ctx.db, history, { signal: ctx.signal, progress });
    const linked = await linkChat(ctx.db, history, written.broadcastIds, { signal: ctx.signal, progress });
    progress(`history: ${history.broadcasts.length} broadcasts, ${linked} chat lines linked`);

    // 2. Real recordings through the stack.
    const before = await countRows(ctx, API_TABLES);
    const plan = planRecordings(ctx.rng.fork("recordings"), ctx.scale, {
      bulkStreamers: ctx.store.users.filter((u) => u.kind === "bulk-streamer").map((u) => u.handle),
      bulkViewers: ctx.store.users.filter((u) => u.kind === "bulk-viewer").map((u) => u.handle),
    });
    const platform = new Platform(
      ctx.env,
      ctx.log,
      `seedmedia${ctx.rng.fork("platform").int(0, 0xffffff).toString(16)}`,
    );
    const sessions = new MediaSessions(platform, ctx.store, ctx.password);
    let sink: RtmpSink | null = null;
    let relay: SeedRelay | null = null;
    let results: Awaited<ReturnType<typeof recordAll>>;
    try {
      const fixedHandles = new Set(ctx.store.users.filter((u) => u.kind === "fixed").map((u) => u.handle));
      for (const c of ctx.store.channels.filter((x) => fixedHandles.has(x.ownerHandle)))
        await opsHook(
          ctx.env,
          INTERNAL_ROUTES.analyticsDisplayBypass,
          "PUT",
          { channelId: c.id, enabled: true },
          ctx.signal,
        );
      sink = await startRtmpSink(ctx.env);
      relay = await startRelay(await sessions.as("streamer1"), ctx.env, ctx.log, ctx.signal);
      progress(`relay ${relay.relayId} active; recording ${plan.recordings.length} broadcasts`);
      results = await recordAll(
        {
          platform,
          sessions,
          store: ctx.store,
          env: ctx.env,
          db: ctx.db,
          log: ctx.log,
          signal: ctx.signal,
          audioPath,
          sink,
          bucket: mediaBucketConfig(ctx.env),
          notes,
        },
        plan,
        progress,
      );
    } finally {
      // SIGTERM: the relay drains and sends its last receipts before exiting.
      await relay?.stop();
      await sink?.stop();
      await platform.close();
    }
    const after = await countRows(ctx, API_TABLES);
    const missingHours = await ownersWithoutMemberHours(ctx);
    if (missingHours.length > 0)
      notes.push(
        `seed-media: no eligible stream hour in the last ${MEMBER_HOURS_DAYS} days for ${missingHours.join(", ")}, so membership-sync will not make them streamer members`,
      );
    if (!results.some((r) => r.removedVodId))
      notes.push(
        "seed-media: no bulk streamer recorded, so nobody removed a recording mid-stream: relay_purges holds only recording_ended and vod_hidden rows",
      );

    const rows: Record<string, number> = {};
    for (const t of API_TABLES) rows[t] = (after[t] ?? 0) - (before[t] ?? 0);
    for (const [t, n] of Object.entries(written.rows)) rows[t] = (rows[t] ?? 0) + n;

    const extra = buildMediaExtra(results);
    ctx.store.extra.media = { ...extra };

    const chat = results.reduce((n, r) => n + r.chatSent, 0);
    const room = results.reduce((n, r) => n + r.roomMessages, 0);
    return {
      rows,
      notes: [
        ...notes,
        `seed-media: ${history.broadcasts.length} backdated broadcasts over seed-social's chat windows; ${linked} backdated chat lines now carry their broadcast_id (their VOD-less replay is still empty: no VOD exists for a backdated broadcast)`,
        `seed-media: ${results.length} real recordings (${chat} chat lines, ${room} watch-room messages); VODs, clips, rollups, captions, rooms and relay rows carry today's times`,
        "seed-media: /analytics shows only the recorded broadcasts (rollups exist only for them), not the backdated history",
        "seed-media: the analytics display bypass for the fixed channels lasts 1 h (ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS); after that, today's rollups wait out the 24 h display delay",
        "seed-media: streamer1's simulcast target points at a local RTMP sink that stops with the seed; it is left disabled so later lives do not retry it",
        "seed-media: the relay node is offline after the seed (its process stops with the run); its receipts and purges stay. relay_purges also has the worker's recording_ended rows (stream.offline) and council1's private VOD (vod_hidden)",
        "seed-media: store.extra.media.liveWindow is not published: no unit asked for it (only money may run beside seed-media, and it reads no live window)",
      ],
    };
  },
};
