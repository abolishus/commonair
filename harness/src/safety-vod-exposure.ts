// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 10: VOD exposure (ADR 0009 amendment 1, docs/testing/w0-selectors.md,
 * "VOD states" and "Scenarios"). Runs on its own:
 *
 * 1. streamer S with VODs on goes live; while it records, `/media/vods/<id>/index.m3u8` and a
 *    segment URL answer 404 and the objects exist under the private `recordings/<id>/` only;
 * 2. after the broadcast the public VOD plays from `/media`;
 * 3. S switches it to `subscribers`: `/media` answers 404 within 5 s, subscriber U's `playlistUrl`
 *    plays through `/vod/` (playlist and a segment), non-subscriber N gets no URL (NOT_FOUND), and
 *    U's VOD token is refused on `/hls`;
 * 4. S removes it: `/media` and U's old `/vod/` URL both answer 404 within 5 s;
 * 5. after the placement sweep (ops tick `vod-placement`) no object of the VOD is under `vods/`.
 *
 * U's subscription is a row written with `DATABASE_URL` (the owner connection, as the operator
 * CLI uses): the step is about media exposure, not checkout. The media bucket is read with the
 * repo `.env` credentials (`S3_*`), read-only. Nothing here logs a token or an object key.
 */
import { mediaPath } from "@commonair/contracts/internal";
import { vodPrefix } from "@commonair/contracts/storage";
import { createDb, uuidv7 } from "@commonair/db";
import { OpsHooks } from "./e6/ops.ts";
import { apiError, errorOf, isNotFound } from "./safety.ts";
import { internalSecret, listMediaKeys, mediaBucketConfig, type MediaBucketConfig } from "./safety-io.ts";
import {
  type Run,
  type Streamer,
  API_SETTLE_MS,
  benign,
  newStreamer,
  publisher,
  title,
  waitLive,
} from "./safety-run.ts";
import type { SignedInUser } from "./users.ts";
import { waitFor } from "./wait.ts";

/** The origin's per-instance state cache (5 s), plus one second of slack for the request itself. */
export const STATE_WINDOW_MS = 6_000;
const VOD_READY_TIMEOUT_MS = 5 * 60_000;
const PLACEMENT_TIMEOUT_MS = 2 * 60_000;
const RECORD_SECONDS = 20;

/** The first media segment URI of an HLS media playlist (with its query), or null. */
export function firstSegmentUri(playlist: string): string | null {
  return playlist.split(/\r?\n/).find((l) => l.trim() !== "" && !l.startsWith("#")) ?? null;
}

/** Every URI of a rewritten VOD playlist carries the token (`t`): segment lines and `URI="…"`. */
export function everyUriTokenized(playlist: string): boolean {
  const lines = playlist.split(/\r?\n/).map((l) => l.trim());
  const uris = [
    ...lines.filter((l) => l !== "" && !l.startsWith("#")),
    ...lines.flatMap((l) => [...l.matchAll(/URI="([^"]*)"/g)].map((m) => m[1] ?? "")),
  ];
  return uris.length > 0 && uris.every((u) => /[?&]t=/.test(u));
}

const statusOf = async (run: Run, url: string): Promise<number> => {
  const res = await fetch(url, { signal: AbortSignal.any([run.ctx.signal, AbortSignal.timeout(10_000)]) });
  await res.body?.cancel();
  return res.status;
};

/** Poll until `url` answers `status`; returns how long it took (ms). Throws after `timeoutMs`. */
async function untilStatus(run: Run, what: string, url: string, status: number, timeoutMs: number): Promise<number> {
  const started = Date.now();
  await waitFor(what, async () => (await statusOf(run, url)) === status, {
    timeoutMs,
    intervalMs: 250,
    signal: run.ctx.signal,
  });
  return Date.now() - started;
}

async function subscribe(databaseUrl: string, subscriberId: string, channelId: string): Promise<void> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    await handle.sql`
      insert into subscriptions (id, subscriber_id, channel_id, tier, status, provider, price_cents, currency,
                                 current_period_end)
      values (${uuidv7()}, ${subscriberId}, ${channelId}, 1, 'active', 'manual', 500, 'usd',
              now() + interval '30 days')`;
  } finally {
    await handle.close();
  }
}

async function storagePrefixOf(databaseUrl: string, vodId: string): Promise<string | null> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    const [r] = await handle.sql<{ p: string }[]>`select storage_prefix as p from vods where id = ${vodId}`;
    return r?.p ?? null;
  } finally {
    await handle.close();
  }
}

async function signUp(run: Run, prefix: string): Promise<SignedInUser> {
  const u = await run.ctx.platform.signUp({ prefix });
  run.emails.push(u.email);
  return u;
}

export async function runVodExposureStep(run: Run): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => title(10, w);
  const bucket = mediaBucketConfig(ctx.env);
  ctx.assert(t("S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are set (object checks)"), bucket !== null);
  const secret = internalSecret(ctx.env);
  ctx.assert(t("INTERNAL_API_SECRET is set (ops tick vod-placement)"), secret !== undefined);
  if (bucket === null || secret === undefined) return;
  const ops = new OpsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  const origin = ctx.env.HARNESS_ORIGIN_URL.replace(/\/+$/, "");
  const media = (vodId: string, file: string) => `${origin}/media/vods/${vodId}/${file}`;

  const s = await ctx.step(t("sign up streamer S (VODs on), subscriber U and viewer N"), async () => {
    const streamer = await newStreamer(run, "ts10_s");
    await streamer.user.api.client.channels.update({ channel: streamer.channel, vodEnabled: true });
    return streamer;
  });
  const [u, n] = await Promise.all([signUp(run, "ts10_u"), signUp(run, "ts10_n")]);
  await ctx.step(t("U subscribes to S (subscription row)"), () => subscribe(run.databaseUrl, u.me.id, s.channelId));

  // ------------------------------------------------------------ 1. while recording
  const { pub } = await publisher(run, s, benign(run, 10));
  await ctx.step(t("S goes live"), async () => {
    await pub.start();
    await waitLive(run, s.channel);
  });
  const vodId = await recordingVod(run, s);
  ctx.data("vodExposureVodId", vodId);
  const segment = await ctx.step(t("the recording's objects are under recordings/<id>/ only"), () =>
    waitFor(
      "a recorded segment under recordings/<id>/",
      async () =>
        (await listMediaKeys(bucket, vodPrefix(vodId, "private"), 50)).find((k) => k.endsWith(".m4s")) ?? null,
      { timeoutMs: API_SETTLE_MS * 2, intervalMs: 1_000, signal: ctx.signal },
    ),
  );
  const segmentFile = segment.slice(vodPrefix(vodId, "private").length);
  const publicWhileRecording = await listMediaKeys(bucket, vodPrefix(vodId, "public"), 5);
  ctx.assert(t("nothing of the recording is under vods/<id>/"), publicWhileRecording.length === 0, {
    objects: publicWhileRecording.length,
  });
  const recordingStatus = {
    playlist: await statusOf(run, media(vodId, "index.m3u8")),
    segment: await statusOf(run, media(vodId, segmentFile)),
  };
  ctx.assert(
    t("/media/vods/<id>/ answers 404 for the recording's playlist and a segment"),
    recordingStatus.playlist === 404 && recordingStatus.segment === 404,
    recordingStatus,
  );

  // ------------------------------------------------------------ 2. public VOD
  await ctx.step(t(`S streams ${RECORD_SECONDS} s more, then ends the broadcast`), async () => {
    await Bun.sleep(RECORD_SECONDS * 1000);
    await pub.stop();
    await waitFor(
      `${s.channel} offline`,
      async () => (await run.anon().channels.get({ channel: s.channel })).live === null,
      {
        timeoutMs: 60_000,
        intervalMs: 500,
        signal: ctx.signal,
      },
    );
  });
  const ready = await ctx.step(t("the VOD is ready and public"), () =>
    waitFor(
      "the VOD ready",
      async () => {
        const v = await run
          .anon()
          .vods.get({ id: vodId })
          .catch(() => null);
        return v?.status === "ready" && v.playlistUrl ? v : null;
      },
      { timeoutMs: VOD_READY_TIMEOUT_MS, intervalMs: 3_000, signal: ctx.signal },
    ),
  );
  const publicUrl = ready.playlistUrl as string;
  ctx.assert(t("the public VOD's playlistUrl is a /media URL"), new URL(publicUrl).pathname.startsWith("/media/vods/"));
  ctx.assert(t("the public VOD plays from /media"), (await statusOf(run, media(vodId, "index.m3u8"))) === 200);

  // ------------------------------------------------------------ 3. subscribers
  await ctx.step(t("S switches the VOD to subscribers"), () =>
    s.user.api.client.vods.update({ id: vodId, visibility: "subscribers" }),
  );
  const hidMs = await ctx.step(t("/media answers 404 within 5 s"), () =>
    untilStatus(run, "/media 404 after re-scoping", media(vodId, "index.m3u8"), 404, STATE_WINDOW_MS),
  );
  ctx.data("vodExposureMediaHiddenMs", hidMs);
  const subscriberUrl = await ctx.step(t("U's playlistUrl is a /vod/ URL"), async () => {
    const v = await u.api.client.vods.get({ id: vodId });
    return v.playlistUrl;
  });
  ctx.assert(
    t("U's playlistUrl uses the token route, not /media"),
    subscriberUrl !== null && new URL(subscriberUrl).pathname === `/vod/${vodId}/index.m3u8`,
  );
  if (subscriberUrl === null) return;
  const playlist = await ctx.step(t("U plays the VOD through /vod/"), async () => {
    const res = await fetch(subscriberUrl, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) });
    return { status: res.status, cache: res.headers.get("cache-control"), text: await res.text() };
  });
  ctx.assert(
    t("the /vod/ playlist answers 200, private"),
    playlist.status === 200 && playlist.cache === "private, no-store",
    {
      status: playlist.status,
      cache: playlist.cache,
    },
  );
  ctx.assert(t("every URI of the /vod/ playlist carries the token"), everyUriTokenized(playlist.text));
  const seg = firstSegmentUri(playlist.text);
  const segStatus = seg ? await statusOf(run, new URL(seg, subscriberUrl).toString()) : 0;
  ctx.assert(t("a segment plays through /vod/ with the token"), segStatus === 200 || segStatus === 206, {
    status: segStatus,
  });
  const nGet = await errorOf(() => n.api.client.vods.get({ id: vodId }));
  ctx.assert(t("non-subscriber N gets no URL (vods.get NOT_FOUND)"), isNotFound(nGet), { code: apiError(nGet).code });
  const vodToken = new URL(subscriberUrl).searchParams.get("t") ?? "";
  const hls = await statusOf(run, `${origin}/hls/${mediaPath(s.channel)}/index.m3u8?t=${encodeURIComponent(vodToken)}`);
  ctx.assert(t("U's VOD token is refused on /hls"), hls === 401 || hls === 403, { status: hls });

  // ------------------------------------------------------------ 4. removed
  await ctx.step(t("S removes the VOD"), () => s.user.api.client.vods.remove({ id: vodId }));
  const removedMs = await ctx.step(t("/media and U's old /vod/ URL answer 404 within 5 s"), async () => {
    const [a, b] = await Promise.all([
      untilStatus(run, "/media 404 after removal", media(vodId, "index.m3u8"), 404, STATE_WINDOW_MS),
      untilStatus(run, "/vod/ 404 after removal", subscriberUrl, 404, STATE_WINDOW_MS),
    ]);
    return Math.max(a, b);
  });
  ctx.data("vodExposureRemovedMs", removedMs);

  // ------------------------------------------------------------ 5. placement sweep
  await ctx.step(t("ops tick vod-placement: nothing of the removed VOD is under vods/"), () =>
    placedPrivately(run, ops, bucket, vodId),
  );
}

/** The streamer's VOD while it records (the owner's list shows `recording` VODs). */
async function recordingVod(run: Run, s: Streamer): Promise<string> {
  return run.ctx.step(title(10, "the broadcast's VOD is recording"), () =>
    waitFor(
      "a recording VOD",
      async () => {
        const page = await s.user.api.client.vods.list({ channel: s.channel, limit: 5 });
        return page.items.find((v) => v.status === "recording")?.id ?? null;
      },
      { timeoutMs: API_SETTLE_MS, intervalMs: 1_000, signal: run.ctx.signal },
    ),
  );
}

async function placedPrivately(run: Run, ops: OpsHooks, bucket: MediaBucketConfig, vodId: string): Promise<void> {
  const { value } = await ops.tickUntil(
    "vod-placement",
    "the VOD under recordings/<id>/ with nothing under vods/<id>/",
    async () => {
      const prefix = await storagePrefixOf(run.databaseUrl, vodId);
      if (prefix !== vodPrefix(vodId, "private")) return null;
      const left = await listMediaKeys(bucket, vodPrefix(vodId, "public"), 5);
      return left.length === 0 ? { prefix } : null;
    },
    { timeoutMs: PLACEMENT_TIMEOUT_MS },
  );
  const left = await listMediaKeys(bucket, vodPrefix(vodId, "public"), 5);
  run.ctx.assert(title(10, "storage_prefix is recordings/<id>/ and no object is under vods/<id>/"), left.length === 0, {
    privatePrefix: value.prefix === vodPrefix(vodId, "private"),
    left: left.length,
  });
}
