// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { RENDITIONS } from "@commonair/contracts/enums";
import { KEYS, mediaPath, P2P_GRANT_TTL_SECONDS, SurgeOverride } from "@commonair/contracts/internal";
import { PLAYBACK_TOKEN_TTL_SECONDS, type PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { recordHeartbeat } from "@commonair/integrity";
import { hmacHex, signPlaybackToken, verifyPlaybackToken } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { channelBySlug, iso } from "../lib/dto.ts";
import { apiError, conflict, notFound, precondition } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { viewerCount } from "../lib/viewers.ts";
import { assignSource, RelayEntry, type Assignment } from "../playback/delivery.ts";
import { recordP2PHeartbeat } from "../playback/metrics.ts";
import { MIN_HEARTBEAT_WALL_SECONDS, nextVerdict, type VerifyState } from "../playback/verify.ts";
import { chatSettingsOf } from "./chat.ts";
import { confirmedAdult } from "./me.ts";

const { playbackSessions, broadcasts, categories } = schema;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Refresh the token when it has less than this left. */
const REFRESH_BEFORE_SECONDS = 60;
const VERIFY_STATE_TTL_SECONDS = 3600;
const verifyKey = (sid: string) => `playback-verify:${sid}`;

export async function activeRelays(deps: Deps) {
  const raw = await deps.valkey.hgetall(KEYS.relays);
  const out: ({ id: string } & RelayEntry)[] = [];
  for (const [id, json] of Object.entries(raw)) {
    try {
      const parsed = RelayEntry.safeParse(JSON.parse(json));
      if (parsed.success) out.push({ id, ...parsed.data });
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

/**
 * The tracker authenticates the socket with the playback token (ADR 0005), so its announces
 * become server-side swarm evidence for this session.
 */
function trackerUrl(deps: Deps, token: string): string {
  const u = new URL(deps.env.P2P_TRACKER_URL);
  u.searchParams.set("t", token);
  return u.toString();
}

function playlistBase(deps: Deps, a: Assignment): string {
  const base =
    a.source === "relay"
      ? a.url
      : a.source === "cdn"
        ? (deps.env.CDN_BASE_URL ?? deps.env.PLAYBACK_PUBLIC_URL)
        : deps.env.PLAYBACK_PUBLIC_URL;
  return base.replace(/\/+$/, "");
}

export const playlistUrl = (base: string, path: string, token: string) =>
  `${base}/hls/${path}/index.m3u8?t=${encodeURIComponent(token)}`;

/**
 * `dm` (ADR 0018 decision 1) rides only on origin tokens: callers move a data-mode session to the
 * origin before minting, and the claim schema refuses anything else.
 */
async function signFor(
  deps: Deps,
  sid: string,
  channelId: string,
  path: string,
  a: Assignment,
  dataMode: number | null,
) {
  const iat = Math.floor(deps.now().getTime() / 1000);
  const claims: PlaybackClaims = {
    v: 1,
    sid,
    cid: channelId,
    path,
    src: a.source,
    ...(a.source === "relay" ? { rid: a.relayId } : {}),
    ...(dataMode !== null ? { dm: dataMode } : {}),
    iat,
    exp: iat + PLAYBACK_TOKEN_TTL_SECONDS,
  };
  return { token: await signPlaybackToken(deps.signingKey, claims), claims };
}

async function renditionsFor(deps: Deps, channelId: string) {
  const raw = await deps.valkey.get(KEYS.renditions(channelId));
  if (!raw) return ["source" as const];
  try {
    const parsed = z.array(z.enum(RENDITIONS)).safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.length > 0 ? parsed.data : ["source" as const];
  } catch {
    return ["source" as const];
  }
}

async function checkToken(deps: Deps, sessionId: string, token: string): Promise<PlaybackClaims> {
  const r = await verifyPlaybackToken(deps.signingKey.publicKey, token, Math.floor(deps.now().getTime() / 1000));
  if (!r.ok || r.value.sid !== sessionId) throw apiError("UNAUTHORIZED", "Invalid playback token");
  return r.value;
}

/** A mature category forces the label even if the broadcast row predates the category flag. */
async function inMatureCategory(deps: Deps, ids: (string | null)[]): Promise<boolean> {
  const present = ids.filter((id): id is string => id !== null);
  if (present.length === 0) return false;
  const rows = await deps.db
    .select({ id: categories.id })
    .from(categories)
    .where(and(inArray(categories.id, present), eq(categories.mature, true)))
    .limit(1);
  return rows.length > 0;
}

/** `MATURE_GATE`: the same answer for signed-out, under-age and unconfirmed viewers. */
export const matureGate = () =>
  apiError("FORBIDDEN", "Confirm you are 18 or older to watch this stream", { reason: "mature_gate" });

/**
 * Whether a broadcast needs a signed-in, 18+-confirmed viewer: the broadcast, its channel or a
 * category is mature, or a T1 case restricts it (the player is blurred behind an interstitial,
 * and only confirmed adults may reveal it).
 */
async function gated(
  deps: Deps,
  b: { mature: boolean; categoryId: string | null; restrictedAt: Date | null },
  c: { mature: boolean; categoryId: string | null },
): Promise<boolean> {
  return (
    b.mature || c.mature || b.restrictedAt !== null || (await inMatureCategory(deps, [b.categoryId, c.categoryId]))
  );
}

/** `gated` for a session's broadcast as it stands now (false for a session without one). */
async function sessionGated(deps: Deps, broadcastId: string | null): Promise<boolean> {
  if (!broadcastId) return false;
  const [row] = await deps.db
    .select({ b: broadcasts, c: { mature: schema.channels.mature, categoryId: schema.channels.categoryId } })
    .from(broadcasts)
    .innerJoin(schema.channels, eq(schema.channels.id, broadcasts.channelId))
    .where(eq(broadcasts.id, broadcastId));
  return row ? gated(deps, row.b, row.c) : false;
}

type ChannelRow = typeof schema.channels.$inferSelect;

/** ADR 0015 decision 7: the instance flag is on and the channel set a verified-watch minimum. */
const watchGateOn = (deps: Deps, c: ChannelRow) =>
  deps.env.CHAT_WATCH_GATE === "on" && chatSettingsOf(c).minVerifiedWatchSeconds > 0;

/** ADR 0015 decision 6: surge mode is on for the channel. A Valkey error reads as off (fail toward serving). */
async function surgeActive(deps: Deps, channelId: string): Promise<boolean> {
  if (deps.env.CHAT_SURGE_GUARD !== "on") return false;
  try {
    const raw = await deps.valkey.get(KEYS.surgeOverride(channelId));
    if (!raw) return false;
    const parsed = SurgeOverride.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.state === "on";
  } catch {
    return false;
  }
}

export const playback = {
  start: os.playback.start.handler(async ({ context, input }) => {
    const { deps, caller, req } = context;
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    if (c.suspendedAt) throw precondition("channel_active", "This channel is suspended");
    const [b] = c.liveBroadcastId
      ? await deps.db.select().from(broadcasts).where(eq(broadcasts.id, c.liveBroadcastId))
      : [];
    if (!b || b.endedAt) throw precondition("live", "This channel is offline");
    const isGated = await gated(deps, b, c);
    if (isGated && !(await confirmedAdult(deps, caller?.user.id))) throw matureGate();

    const sid = uuidv7();
    const path = mediaPath(c.slug);
    // ADR 0015 decision 2: a signed-in viewer of a gated or surging channel stays off the CDN, so
    // their fetches reach a server that can judge them.
    const avoidCdn = caller !== null && (watchGateOn(deps, c) || (await surgeActive(deps, c.id)));
    const assignment = assignSource({
      sessionId: sid,
      relays: await activeRelays(deps),
      cdn: {
        enabled: deps.env.CDN_PROVIDER === "origin-pull" && Boolean(deps.env.CDN_BASE_URL),
        threshold: deps.env.CDN_BURST_VIEWER_THRESHOLD,
      },
      channelVerifiedViewers: await viewerCount(deps, c.id),
      avoidCdn,
      // ADR 0018 decision 4: data-mode sessions are origin sessions (the origin filters per token).
      originOnly: input.dataMode !== null,
    });
    const network = deps.classifier.classify(req.ip);
    // P2P shows the viewer's address to peers (ADR 0005 amendment 1), so 18+, mature-category and
    // T1-restricted streams never get it, and native HLS (WebKit) cannot run the loader.
    // `p2pCapable` is the player's opt-in policy: it applies the operator default
    // (`instance.info` `features.p2pDefault`), so a viewer who has not opted in never gets a grant.
    // There are no private or subscriber-only live streams yet (`visibility` is VOD only); whoever
    // adds one excludes it here.
    // Data mode never gets P2P (ADR 0018 decision 6): uploading to peers spends the viewer's budget.
    const p2pAvailable = deps.env.P2P_ENABLED && !input.nativeHls && !isGated && input.dataMode === null;
    const p2pEnabled = p2pAvailable && input.p2pCapable;
    await deps.db.insert(playbackSessions).values({
      id: sid,
      channelId: c.id,
      broadcastId: b.id,
      userId: caller?.user.id ?? null,
      deviceHash: await hmacHex(deps.env.AUTH_SECRET, `device:${input.deviceId}`),
      ipHash: req.ipHash,
      userAgent: req.userAgent?.slice(0, 256) ?? null,
      asn: network.asn,
      datacenter: network.hosting ? (network.label ?? "hosting") : null,
      // Always the HTTP delivery source, never `p2p`: whether the P2P loader runs is client input
      // (`p2pCapable`, `nativeHls`). Integrity lowers the expected HTTP share only on the
      // tracker's server-side swarm evidence (P2P_EVIDENCE), never on this record.
      assignedSource: assignment.source,
      relayId: assignment.source === "relay" ? assignment.relayId : null,
      startedAt: deps.now(),
      fingerprint: { embed: input.embed, nativeHls: input.nativeHls },
    });
    // The grant is what the tracker and `p2p.iceServers` check; the swarm id is the broadcast id.
    if (p2pEnabled) await deps.valkey.set(KEYS.p2pGrant(sid), b.id, "EX", P2P_GRANT_TTL_SECONDS);
    const { token, claims } = await signFor(deps, sid, c.id, path, assignment, input.dataMode);
    return {
      sessionId: sid,
      token,
      playlistUrl: playlistUrl(playlistBase(deps, assignment), path, token),
      source: assignment.source,
      p2p: {
        enabled: p2pEnabled,
        available: p2pAvailable,
        trackerUrls: p2pEnabled ? [trackerUrl(deps, token)] : [],
        swarmId: b.id,
        digestUrl: `${deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "")}/p2p-digest`,
      },
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      expiresAt: iso(new Date(claims.exp * 1000)),
      renditions: await renditionsFor(deps, c.id),
      captions: [],
      dataMode: claims.dm ?? null,
    };
  }),

  heartbeat: os.playback.heartbeat.handler(async ({ context, input }) => {
    const { deps } = context;
    const claims = await checkToken(deps, input.sessionId, input.token);
    const [s] = await deps.db.select().from(playbackSessions).where(eq(playbackSessions.id, input.sessionId));
    if (!s) throw notFound("Playback session not found");
    if (s.endedAt) throw conflict("This playback session has ended");
    const now = deps.now();
    const wallSeconds = (now.getTime() - (s.lastHeartbeatAt ?? s.startedAt).getTime()) / 1000;
    // A beat sooner than the floor is ignored outright: no counters, no clock, no verification
    // evidence. Flooding cannot mint watch time, inflate heartbeat counts or feed the scorer.
    // Token refresh and relay moves wait for the next beat at the normal interval.
    if (wallSeconds < MIN_HEARTBEAT_WALL_SECONDS) return { ok: true as const, throttled: true };

    const raw = await deps.valkey.hgetall(verifyKey(s.id));
    const state: VerifyState = { consistent: Number(raw.consistent ?? 0) || 0, engaged: raw.engaged === "1" };
    const v = nextVerdict(s.verdict, state, {
      playedSeconds: input.playedSeconds,
      wallSeconds,
      visible: input.visible,
      muted: input.muted,
    });
    // Watch time never exceeds wall-clock time (plus jitter).
    const watched = Math.round(Math.min(input.playedSeconds, wallSeconds + 5));
    const updated = await deps.db
      .update(playbackSessions)
      .set({
        heartbeats: sql`${playbackSessions.heartbeats} + 1`,
        watchSeconds: sql`${playbackSessions.watchSeconds} + ${Math.max(0, watched)}`,
        bytesHttp: sql`${playbackSessions.bytesHttp} + ${input.bytesHttp}`,
        bytesP2p: sql`${playbackSessions.bytesP2p} + ${input.bytesP2p}`,
        stalls: sql`${playbackSessions.stalls} + ${input.stalls}`,
        latencyMs: input.latencySeconds === null ? s.latencyMs : input.latencySeconds * 1000,
        ttffMs: s.ttffMs ?? input.ttffMs,
        lastHeartbeatAt: now,
        ...(input.fingerprint ? { fingerprint: { ...s.fingerprint, ...input.fingerprint } } : {}),
      })
      // Compare-and-set on the clock we read: of two concurrent beats only one is credited.
      .where(
        and(
          eq(playbackSessions.id, s.id),
          isNull(playbackSessions.endedAt),
          s.lastHeartbeatAt === null
            ? isNull(playbackSessions.lastHeartbeatAt)
            : eq(playbackSessions.lastHeartbeatAt, s.lastHeartbeatAt),
        ),
      )
      .returning({ id: playbackSessions.id });
    if (updated.length === 0) return { ok: true as const };
    // Interim promotion only for sessions the integrity scorer has not decided: once scored_at is
    // set its verdict stands (no demotion, no re-promotion), and its media_unconfirmed hold is
    // never lifted here.
    let promoted = false;
    if (v.verdict !== s.verdict && v.verdict === "verified" && s.scoredAt === null)
      promoted =
        (
          await deps.db
            .update(playbackSessions)
            .set({ verdict: v.verdict })
            .where(
              and(
                eq(playbackSessions.id, s.id),
                eq(playbackSessions.verdict, "pending"),
                isNull(playbackSessions.scoredAt),
                sql`not (${playbackSessions.verdictReasons} @> array['media_unconfirmed']::text[])`,
              ),
            )
            .returning({ id: playbackSessions.id })
        ).length > 0;
    recordP2PHeartbeat(input);
    // Evidence for the integrity scorer (worker), which takes over verdicts from verify.ts.
    await recordHeartbeat(deps.valkey, s.id, {
      at: now.getTime(),
      playedSeconds: input.playedSeconds,
      bufferSeconds: input.bufferSeconds,
      visible: input.visible,
      muted: input.muted,
      stalls: input.stalls,
      bytesHttp: input.bytesHttp,
      bytesP2p: input.bytesP2p,
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    });
    // ADR 0018 decision 3: absent carries the token's ceiling forward, null turns data mode off.
    const dataMode = input.dataMode === undefined ? (claims.dm ?? null) : input.dataMode;
    const dataModeChanged = dataMode !== (claims.dm ?? null);
    // A stream that became gated mid-session (T1 restriction, mature flag, mature category) loses
    // P2P: the grant goes, and the tracker closes the socket at its next re-check. Only sessions
    // holding a grant pay for the gate query.
    let gate: boolean | undefined;
    const granted = (await deps.valkey.exists(KEYS.p2pGrant(s.id))) === 1;
    if (granted) gate = await sessionGated(deps, s.broadcastId);
    const tx = deps.valkey
      .multi()
      .hset(verifyKey(s.id), { consistent: String(v.state.consistent), engaged: v.state.engaged ? "1" : "0" })
      .expire(verifyKey(s.id), VERIFY_STATE_TTL_SECONDS)
      .zadd(KEYS.viewers(s.channelId), now.getTime(), s.id);
    if (granted) {
      // Data mode loses P2P as a gated stream does (ADR 0018 decision 6).
      if (gate || dataMode !== null) tx.del(KEYS.p2pGrant(s.id));
      else tx.expire(KEYS.p2pGrant(s.id), P2P_GRANT_TTL_SECONDS);
    }
    // A newly verified viewer should show up without waiting for the cache to expire.
    if (promoted) tx.del(KEYS.viewerCount(s.channelId));
    await tx.exec();

    // Move viewers off a relay that left the active set (KEYS.relays holds active relays only:
    // drained, timed-out, suspended and retired relays are all removed from it). The new token
    // and playlist point at the origin, and the session is re-recorded as origin-delivered:
    // integrity then judges it on origin fetches. That fails safe: an honest viewer's relay
    // segments are missing from the origin count, but no watch time goes unproven.
    let assignment: Assignment | null = null;
    // Turning data mode on moves a relay or CDN session to the origin the same way (ADR 0018
    // decision 4); turning it off leaves the session where it is.
    if (dataMode !== null && claims.src !== "origin") {
      assignment = { source: "origin" };
      await deps.db
        .update(playbackSessions)
        .set({ assignedSource: "origin", relayId: null })
        .where(eq(playbackSessions.id, s.id));
    } else if (claims.src === "relay" && claims.rid) {
      const relays = await activeRelays(deps);
      if (!relays.some((r) => r.id === claims.rid && r.status === "active")) {
        assignment = { source: "origin" };
        await deps.db
          .update(playbackSessions)
          .set({ assignedSource: "origin", relayId: null })
          .where(eq(playbackSessions.id, s.id));
      }
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    // A changed ceiling re-mints now, not at the refresh point, so the player can reload at once.
    if (!assignment && !dataModeChanged && claims.exp - nowSeconds > REFRESH_BEFORE_SECONDS)
      return { ok: true as const };
    const a: Assignment =
      assignment ??
      (claims.src === "relay" && claims.rid
        ? {
            source: "relay",
            relayId: claims.rid,
            url: (await activeRelays(deps)).find((r) => r.id === claims.rid)?.url ?? "",
          }
        : claims.src === "cdn"
          ? { source: "cdn" }
          : { source: "origin" });
    // A label or restriction that arrived mid-stream applies at the next refresh.
    gate ??= await sessionGated(deps, s.broadcastId);
    if (gate && !(await confirmedAdult(deps, s.userId ?? undefined)))
      throw apiError("FORBIDDEN", "Confirm you are 18 or older to watch this stream");
    const { token } = await signFor(deps, s.id, s.channelId, claims.path, a, dataMode);
    return {
      ok: true as const,
      token,
      ...(assignment ? { switchTo: playlistUrl(playlistBase(deps, assignment), claims.path, token) } : {}),
    };
  }),

  end: os.playback.end.handler(async ({ context, input }) => {
    const { deps } = context;
    await checkToken(deps, input.sessionId, input.token);
    const [s] = await deps.db
      .update(playbackSessions)
      .set({ endedAt: deps.now() })
      .where(and(eq(playbackSessions.id, input.sessionId), isNull(playbackSessions.endedAt)))
      .returning({ channelId: playbackSessions.channelId });
    if (s)
      await deps.valkey
        .multi()
        .zrem(KEYS.viewers(s.channelId), input.sessionId)
        .del(verifyKey(input.sessionId), KEYS.viewerCount(s.channelId))
        // The tracker closes an ended session's socket at its next re-check.
        .del(KEYS.p2pGrant(input.sessionId))
        .exec();
    return { ok: true as const };
  }),
};
