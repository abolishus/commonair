// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e2e-relay` W3 extensions (docs/testing/b7-selectors.md, "Scenarios"; ADR 0016 Amendment 1):
 *
 * - `dvr-relay`: a relay-assigned viewer rewinds on its own channel (VODs on, so it records). Its
 *   DVR playlist is on the relay, the segments come from the relay (the relay's receipts credit
 *   the session; the origin served the session nothing), and the session verifies.
 * - `dvr-purge` (after `dvr-relay`): the streamer removes the recording mid-stream. The relay
 *   answers 404 for a DVR segment it had cached within 5 s, and the purge row reached it (its
 *   `/healthz` `purgeSeq` advanced past the row's `seq`).
 * - `relay-vtt`: a relay pull's multivariant playlist carries SUBTITLES, a `.vtt` through the
 *   relay is `max-age=30` (not `immutable`), and the receipts do not count it. The relay shard runs
 *   no whisper sidecar (batch 6 decision (c)), so the step plants a caption track for its own
 *   broadcast in Valkey, as media would keep it; the origin and the relay only read those keys.
 *
 * Every step signs up its own streamer. Database reads use `DATABASE_URL` (the stack's owner
 * connection, as the other relay checks do). No token is logged.
 */
import { RedisClient } from "bun";
import { createDb } from "@commonair/db";
import type { ApiClient } from "../../api/client.ts";
import { newDeviceId } from "../../fingerprint.ts";
import { parsePlaylist, resolveUri } from "../../hls.ts";
import { valkeyUrl } from "../../multi/replicas.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { Streamer } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { waitFor } from "../../wait.ts";
import { subtitleAdvert } from "../../w2/captions/live.ts";
import { DvrHttpViewer } from "../../w2/dvr/viewer.ts";
import type { RelayW3Extension } from "../kit.ts";
import { captionFixture, dvrPurgePrefix, receiptTotals, servedBy, vttCacheControlOk } from "./checks.ts";

const LIVE_TIMEOUT_MS = 60_000;
const RECORDING_TIMEOUT_MS = 90_000;
/** A relay-assigned session within this many starts (one relay: about half of them). */
const MAX_STARTS = 30;
/** The relay stops serving a removed DVR within the 5 s playlist rule (ADR 0016 A1.3). */
export const RELAY_DVR_CLOSE_MS = 5_000;
/** Polling and a loaded runner's request time on top of it. */
export const RELAY_DVR_CLOSE_SLACK_MS = 2_000;
/** Receipts are cut every 60 s (`RECEIPT_INTERVAL_SECONDS`); wait for two periods and change. */
const RECEIPT_TIMEOUT_MS = 180_000;

const t = (step: string, what: string) => `${step}: ${what}`;

interface DvrRelayState {
  channel: string;
  streamer: SignedInUser;
  vodId: string;
  viewer: DvrHttpViewer;
  sessionId: string;
}

const runs = new WeakMap<ScenarioContext, DvrRelayState>();

const statusOf = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return res;
};

async function withDb<T>(
  ctx: ScenarioContext,
  fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>,
): Promise<T> {
  const url = ctx.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const handle = createDb({ url, max: 1, applicationName: "commonair-harness" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

/** A new streamer, live, with VODs on (so the broadcast records and has DVR) unless told otherwise. */
async function liveChannel(
  ext: RelayW3Extension,
  prefix: string,
  opts: { vods: boolean },
): Promise<{ user: SignedInUser; channel: string; vodId: string | null; encoder: Streamer }> {
  const { ctx } = ext;
  const user = await ctx.platform.signUp({ prefix });
  const channel = user.me.channelSlug ?? user.username;
  if (opts.vods) await user.api.client.channels.update({ channel, vodEnabled: true });
  const encoder = await ctx.platform.streamerFor(user, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => encoder.stop());
  await encoder.start();
  await ctx.platform.waitForLive(channel, true, LIVE_TIMEOUT_MS);
  const vodId = opts.vods
    ? await waitFor(
        `${channel}: a recording VOD`,
        async () =>
          (await user.api.client.vods.list({ channel, limit: 5 })).items.find((v) => v.status === "recording")?.id ??
          null,
        { timeoutMs: RECORDING_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
      )
    : null;
  return { user, channel, vodId, encoder };
}

/** What the relay's receipts credit a session with so far. */
async function relayCredit(ctx: ScenarioContext, relayId: string, sessionId: string) {
  const payloads = await withDb(ctx, async (sql) => {
    const rows = await sql<{ payload: unknown }[]>`
      select payload from relay_receipts
       where relay_id = ${relayId} and payload::text like ${`%${sessionId}%`}`;
    return rows.map((r) => r.payload);
  });
  return receiptTotals(payloads, sessionId);
}

/** The relay's newest receipt period end (epoch ms), or 0. */
async function newestReceiptEnd(ctx: ScenarioContext, relayId: string): Promise<number> {
  return withDb(ctx, async (sql) => {
    const rows = await sql<{ ms: string | null }[]>`
      select (extract(epoch from max(period_end)) * 1000)::bigint::text as ms
        from relay_receipts where relay_id = ${relayId}`;
    return Number(rows[0]?.ms ?? 0);
  });
}

async function purgeSeqOf(ext: RelayW3Extension): Promise<number | null> {
  const res = await fetch(`${ext.relay.url}/healthz`, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
  if (!res) return null;
  const body = (await res.json().catch(() => null)) as { purgeSeq?: unknown } | null;
  return typeof body?.purgeSeq === "number" ? body.purgeSeq : null;
}

const uris = (playlist: string) => playlist.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));

// ------------------------------------------------------------ dvr-relay

export async function stepDvrRelay(ext: RelayW3Extension): Promise<void> {
  const { ctx, check } = ext;
  const s = "dvr-relay";
  ctx.assert(t(s, "DATABASE_URL is set (receipts, session verdicts)"), ctx.env.DATABASE_URL !== undefined);
  const behindSeconds = ctx.intParam("dvrRelayBehindSeconds", 30);
  const watchSeconds = ctx.intParam("dvrRelayWatchSeconds", 60);
  const verifySeconds = ctx.intParam("dvrRelayVerifySeconds", 300);
  const ch = await ctx.step(t(s, "a streamer goes live with VODs on (recording)"), () =>
    liveChannel(ext, "w3dvrr", { vods: true }),
  );
  const vodId = ch.vodId ?? "";
  // Enough recording behind the live edge to rewind into.
  await ctx.step(t(s, `the DVR window reaches ${behindSeconds + 12} s`), () =>
    waitFor(
      "a long enough DVR window",
      async () => {
        const api = ctx.platform.api().client;
        const p = await api.playback.start({ channel: ch.channel, deviceId: newDeviceId() });
        await api.playback.end({ sessionId: p.sessionId, token: p.token }).catch(() => undefined);
        if (!p.dvrPlaylistUrl) return null;
        const res = await statusOf(p.dvrPlaylistUrl);
        if (!res.ok) return null;
        return uris(await res.text()).length * 4 >= behindSeconds + 12 || null;
      },
      { timeoutMs: (behindSeconds + 120) * 1000, intervalMs: 4_000, signal: ctx.signal },
    ),
  );

  const viewer = await ctx.step(t(s, "a viewer lands on the relay and rewinds"), async () => {
    for (let i = 0; i < MAX_STARTS; i++) {
      const v = new DvrHttpViewer({ api: ctx.platform.api().client, channel: ch.channel, behindSeconds, log: ctx.log });
      const started = await v.start();
      if (started.source === "relay") return { v, started };
      await v.stop();
    }
    throw new Error(`no relay-assigned session in ${MAX_STARTS} starts`);
  });
  const sessionId = viewer.started.sessionId;
  ctx.defer(() => viewer.v.stop());
  runs.set(ctx, { channel: ch.channel, streamer: ch.user, vodId, viewer: viewer.v, sessionId });
  ctx.assert(
    t(s, "the DVR playlist is on the relay, not the origin"),
    servedBy(viewer.started.dvrPlaylistUrl, ext.relay.url),
    {
      relay: new URL(ext.relay.url).origin,
      dvr: viewer.started.dvrPlaylistUrl ? new URL(viewer.started.dvrPlaylistUrl).origin : null,
    },
  );

  await ctx.step(t(s, `the viewer watches ${watchSeconds} s`), () => Bun.sleep(watchSeconds * 1000));
  const report = { ...viewer.v.report, errors: viewer.v.report.errors.slice(0, 5) };
  ctx.data("w3.dvrRelay.viewer", report);
  ctx.assert(t(s, "the relay served the rewound segments"), report.segments > 0 && report.errors.length === 0, report);
  ctx.check(t(s, "heartbeats refreshed the relay DVR token"), report.dvrTokenRefreshes > 0, report);

  const credited = await ctx.step(t(s, "the relay's receipts credit the session"), () =>
    waitFor(
      "receipt segments for the DVR session",
      async () => {
        const c = await relayCredit(ctx, ext.relayId, sessionId);
        return c.segments > 0 ? c : null;
      },
      { timeoutMs: RECEIPT_TIMEOUT_MS, intervalMs: 5_000, signal: ctx.signal },
    ),
  );
  ctx.metric("w3.dvrRelay.receiptSegments", credited.segments);
  ctx.check(t(s, "receipts count about what the viewer fetched"), credited.segments >= report.segments, {
    credited,
    fetched: report.segments,
  });
  const origin = await withDb(ctx, async (sql) => {
    const rows = await sql<{ segments: number; source: string }[]>`
      select segments_fetched as segments, assigned_source::text as source
        from playback_sessions where id = ${sessionId}`;
    return rows[0] ?? null;
  });
  ctx.assert(
    t(s, "the origin served the session no segment (DVR came from the relay)"),
    origin?.segments === 0,
    origin,
  );
  ctx.check(t(s, "the session is still relay-assigned"), origin?.source === "relay", origin);

  const verdict = await ctx.step(t(s, "the session verifies (scored, on receipts)"), () =>
    waitFor(
      "the relay DVR session verified",
      () =>
        withDb(ctx, async (sql) => {
          const rows = await sql<{ verdict: string; scored: boolean; dvr: number; reasons: string[] | null }[]>`
            select verdict::text as verdict, scored_at is not null as scored, dvr_seconds as dvr,
                   verdict_reasons as reasons
              from playback_sessions where id = ${sessionId}`;
          const r = rows[0];
          return r && r.scored && r.verdict === "verified" ? r : null;
        }),
      { timeoutMs: verifySeconds * 1000, intervalMs: 5_000, signal: ctx.signal },
    ).catch(async (err: unknown) => {
      const last = await withDb(ctx, async (sql) => {
        const rows = await sql<{ verdict: string; reasons: string[] | null }[]>`
          select verdict::text as verdict, verdict_reasons as reasons from playback_sessions where id = ${sessionId}`;
        return rows[0] ?? null;
      });
      check(t(s, "the session verifies (scored, on receipts)"), false, { err: (err as Error).message, last });
      return null;
    }),
  );
  if (verdict) ctx.check(t(s, "verified with DVR seconds"), verdict.dvr > 0, verdict);
}

// ------------------------------------------------------------ dvr-purge

export async function stepDvrPurge(ext: RelayW3Extension): Promise<void> {
  const { ctx, check } = ext;
  const s = "dvr-purge";
  const run = runs.get(ctx);
  if (!run) throw new Error("dvr-purge needs dvr-relay's rewinding viewer (run dvr-relay first)");
  const playlistUrl = run.viewer.playlistUrl();
  // A segment the relay has served (so cached), still listed.
  const segment = await ctx.step(t(s, "a DVR segment the relay has cached"), async () => {
    const res = await statusOf(playlistUrl);
    ctx.assert(t(s, "the relay DVR playlist plays"), res.ok, { status: res.status });
    const p = parsePlaylist(await res.text());
    if (p.kind !== "media" || p.segments.length === 0) throw new Error("the DVR playlist lists no segment");
    const url = resolveUri(p.segments.at(-1)?.uri ?? "", playlistUrl);
    const first = await statusOf(url);
    await first.arrayBuffer();
    ctx.assert(t(s, "it plays from the relay"), first.ok, { status: first.status });
    return url;
  });
  const seqBefore = await purgeSeqOf(ext);
  ctx.assert(t(s, "the relay reports its purge cursor"), seqBefore !== null, { seqBefore });

  await ctx.step(t(s, "the streamer removes the recording mid-stream"), () =>
    run.streamer.api.client.vods.remove({ id: run.vodId }),
  );
  const removed = Date.now();
  const elapsed = await ctx.step(t(s, `the relay answers 404 within ${RELAY_DVR_CLOSE_MS / 1000} s`), async () => {
    await waitFor(
      "relay DVR 404 after removal",
      async () => {
        const r = await statusOf(segment);
        await r.body?.cancel();
        return r.status === 404;
      },
      { timeoutMs: RELAY_DVR_CLOSE_MS * 4, intervalMs: 250, signal: ctx.signal },
    );
    return Date.now() - removed;
  });
  ctx.metric("w3.dvrPurge.closedMs", elapsed, "ms");
  check(
    t(s, "closed within 5 s (plus polling and request slack)"),
    elapsed <= RELAY_DVR_CLOSE_MS + RELAY_DVR_CLOSE_SLACK_MS,
    {
      elapsed,
    },
  );
  const playlist = await statusOf(playlistUrl);
  await playlist.body?.cancel();
  ctx.check(t(s, "the playlist is gone from the relay too"), playlist.status === 404, { status: playlist.status });

  const row = await ctx.step(t(s, "the purge row was written"), () =>
    waitFor(
      "a relay_purges row for the recording",
      () =>
        withDb(ctx, async (sql) => {
          const rows = await sql<{ seq: string; reason: string }[]>`
            select seq::text as seq, reason::text as reason from relay_purges
             where prefix = ${dvrPurgePrefix(run.vodId)} order by seq desc limit 1`;
          return rows[0] ? { seq: Number(rows[0].seq), reason: rows[0].reason } : null;
        }),
      { timeoutMs: 30_000, intervalMs: 500, signal: ctx.signal },
    ),
  );
  ctx.check(t(s, "its reason is vod_hidden"), row.reason === "vod_hidden", row);
  const seqAfter = await ctx.step(t(s, "the purge reached the relay (its cursor passed the row)"), () =>
    waitFor(
      "relay purgeSeq ≥ the row's seq",
      async () => {
        const seq = await purgeSeqOf(ext);
        return seq !== null && seq >= row.seq ? seq : null;
      },
      { timeoutMs: 40_000, intervalMs: 500, signal: ctx.signal },
    ),
  );
  ctx.data("w3.dvrPurge", { seqBefore, seqAfter, row, elapsed });
  ctx.check(
    t(s, "the relay logged the purge"),
    ext.relay.logs.lines().some((l) => l.includes("purged") && l.includes(dvrPurgePrefix(run.vodId))),
  );
  await run.viewer.stop();
}

// ------------------------------------------------------------ relay-vtt

export async function stepRelayVtt(ext: RelayW3Extension): Promise<void> {
  const { ctx, check } = ext;
  const s = "relay-vtt";
  ctx.assert(t(s, "DATABASE_URL is set (the broadcast, receipts)"), ctx.env.DATABASE_URL !== undefined);
  const ch = await ctx.step(t(s, "a streamer goes live"), () => liveChannel(ext, "w3vtt", { vods: false }));
  const broadcastId = await withDb(ctx, async (sql) => {
    const rows = await sql<{ id: string | null }[]>`
      select live_broadcast_id as id from channels where slug = ${ch.channel}`;
    return rows[0]?.id ?? null;
  });
  if (!broadcastId) throw new Error(`${ch.channel} has no live broadcast`);

  // The caption track media would keep (no whisper in this shard); removed when the step ends.
  const valkey = new RedisClient(valkeyUrl(process.env));
  await valkey.connect();
  const fixture = captionFixture(broadcastId, Date.now());
  const plant = async () => {
    const f = captionFixture(broadcastId, Date.now());
    await valkey.send("SET", [f.liveKey, f.track, "EX", "300"]);
    await valkey.send("ZADD", [f.cuesKey, ...f.cues.flatMap(([score, member]) => [String(score), member])]);
    await valkey.send("EXPIRE", [f.cuesKey, "300"]);
  };
  ctx.defer(async () => {
    await valkey.send("DEL", [fixture.liveKey, fixture.cuesKey]).catch(() => undefined);
    valkey.close();
  });
  await ctx.step(t(s, "a caption track is active for the broadcast"), plant);

  const session = await ctx.step(t(s, "a viewer lands on the relay"), async () => {
    for (let i = 0; i < MAX_STARTS; i++) {
      const api: ApiClient = ctx.platform.api().client;
      const p = await api.playback.start({ channel: ch.channel, deviceId: newDeviceId() });
      if (p.source === "relay") return { api, p };
      await api.playback.end({ sessionId: p.sessionId, token: p.token }).catch(() => undefined);
    }
    throw new Error(`no relay-assigned session in ${MAX_STARTS} starts`);
  });
  ctx.defer(() =>
    session.api.playback.end({ sessionId: session.p.sessionId, token: session.p.token }).catch(() => undefined),
  );
  ctx.assert(t(s, "the playlist is on the relay"), servedBy(session.p.playlistUrl, ext.relay.url));

  const advert = await ctx.step(t(s, "the relay's multivariant playlist carries SUBTITLES"), () =>
    waitFor(
      "SUBTITLES through the relay",
      async () => {
        await plant();
        const res = await statusOf(session.p.playlistUrl);
        return res.ok ? subtitleAdvert(await res.text()) : null;
      },
      { timeoutMs: 30_000, intervalMs: 1_000, signal: ctx.signal },
    ),
  );
  const subtitles = resolveUri(advert.uri, session.p.playlistUrl);
  ctx.assert(t(s, "the subtitle playlist is on the relay"), servedBy(subtitles, ext.relay.url));
  const fetchedAt = Date.now();
  const vtt = await ctx.step(t(s, "a .vtt through the relay"), async () => {
    const pl = await statusOf(subtitles);
    ctx.assert(t(s, "the subtitle playlist plays from the relay"), pl.ok, { status: pl.status });
    const p = parsePlaylist(await pl.text());
    if (p.kind !== "media" || p.segments.length === 0) throw new Error("the subtitle playlist lists no segment");
    const url = resolveUri(p.segments.at(-1)?.uri ?? "", subtitles);
    const r = await statusOf(url);
    return { status: r.status, cacheControl: r.headers.get("cache-control"), body: await r.text() };
  });
  ctx.assert(t(s, "the .vtt is served"), vtt.status === 200 && vtt.body.startsWith("WEBVTT"), {
    status: vtt.status,
  });
  ctx.assert(t(s, ".vtt is max-age=30, not immutable"), vttCacheControlOk(vtt.cacheControl), {
    cacheControl: vtt.cacheControl,
  });

  // The session fetched captions and playlists only: once a receipt period after the fetch is in,
  // the relay must have credited it no segment.
  await ctx.step(t(s, "a receipt period after the fetch arrives"), () =>
    waitFor(
      "a relay receipt after the .vtt fetch",
      async () => (await newestReceiptEnd(ctx, ext.relayId)) > fetchedAt || null,
      {
        timeoutMs: RECEIPT_TIMEOUT_MS,
        intervalMs: 5_000,
        signal: ctx.signal,
      },
    ),
  );
  const credited = await relayCredit(ctx, ext.relayId, session.p.sessionId);
  check(
    t(s, "the receipts' segment count leaves the .vtt out"),
    credited.segments === 0 && credited.bytes === 0,
    credited,
  );
}
