// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Service-to-service contracts that are not part of the public API: internal
 * HTTP hooks, Valkey keys and streams, BullMQ queue names, and the chat
 * connection token. Internal HTTP calls carry `x-internal-secret: <INTERNAL_API_SECRET>`
 * and are served on the API under `/internal/*`, which Caddy never exposes.
 */
import { z } from "zod";
import {
  DELIVERY_SOURCES,
  EVIDENCE_KINDS,
  HASH_LIST_CATEGORIES,
  MODERATION_CATEGORIES,
  MODERATION_SUBJECTS,
  PLAYBACK_MODES,
  RENDITIONS,
} from "./enums.ts";

// Browser-safe P2P identifiers, re-exported so the tracker can use either entry.
export * from "./p2p.ts";

export const INTERNAL_SECRET_HEADER = "x-internal-secret";

/** Username MediaMTX accepts for internal readers/publishers (origin, media); password = MEDIA_INTERNAL_PASSWORD. */
export const MEDIA_INTERNAL_USER = "internal";

/**
 * Ingest URLs. Streamers publish to `rtmp://<host>/live/<slug>?key=<secret>`; OBS users enter
 * server `rtmp://<host>/live` and stream key `<slug>?key=<secret>`. WHIP clients POST to
 * `<whip base>/<slug>/whip` with `Authorization: Bearer <secret>`. The MediaMTX path is
 * always `live/<slug>`; renditions are published back as `live/<slug>/<rendition>`.
 */
export const mediaPath = (slug: string) => `live/${slug}`;
export const renditionPath = (slug: string, rendition: Exclude<(typeof RENDITIONS)[number], "source">) =>
  `live/${slug}/${rendition}`;
/**
 * The source with its audio re-encoded to AAC (video copied), published by media while the
 * ingest's audio is something HLS players cannot all decode (WHIP brings Opus; WebKit's native
 * HLS does not play it). Internal: origin serves it in place of the source while
 * `KEYS.sourceAac` is set; clients never name it.
 */
export const SOURCE_AAC_DIR = "aac";
export const SOURCE_AAC_STATES = { pending: "pending", live: "1" } as const;
export const sourceAacPath = (slug: string) => `live/${slug}/${SOURCE_AAC_DIR}`;

/** MediaMTX `authHTTPAddress` request body (MediaMTX 1.x). */
export const MediaMtxAuthRequest = z.object({
  user: z.string().default(""),
  password: z.string().default(""),
  token: z.string().default(""),
  ip: z.string(),
  action: z.enum(["publish", "read", "playback", "api", "metrics", "pprof"]),
  path: z.string().default(""),
  /** Empty for `api`/`metrics` actions (MediaMTX 1.21 sends ""). */
  protocol: z.enum(["rtsp", "rtmp", "hls", "webrtc", "srt"]).or(z.literal("")),
  id: z.string().nullable().optional(),
  query: z.string().default(""),
});
export type MediaMtxAuthRequest = z.infer<typeof MediaMtxAuthRequest>;

/** Posted by MediaMTX `runOnReady` / `runOnNotReady` hooks to the API. */
export const MediaReadyHook = z.object({
  path: z.string(),
  sourceType: z.string(),
  sourceId: z.string().default(""),
  query: z.string().default(""),
});
export const INTERNAL_ROUTES = {
  mediaAuth: "/internal/media/auth",
  mediaReady: "/internal/media/ready",
  mediaNotReady: "/internal/media/not-ready",
  /**
   * Trust & safety test hooks (served by the API only while `MODERATION_TEST_HOOKS=true`,
   * otherwise 404). `PUT` a `ModerationScriptBody`: the scripted classifier's scores for a channel.
   */
  moderationScript: "/internal/moderation/script",
  /** `POST` a `NciiTickBody`: run the NCII clock job once as of that time (test hooks only). */
  nciiTick: "/internal/moderation/ncii-tick",
  /**
   * Co-op test hook (served by the API only while `COOP_TEST_HOOKS=true`, otherwise 404). `POST` a
   * `CoopTickBody`: the API enqueues that `COOP_JOBS` job, waits for it (30 s) and returns its result.
   */
  coopTick: "/internal/coop/tick",
  /**
   * Operations test hook (E6; served by the API only while `OPS_TEST_HOOKS=true`, otherwise 404).
   * `POST` an `OpsTickBody`: the API enqueues that job, waits for it (60 s) and returns its result.
   */
  opsTick: "/internal/ops/tick",
  /** POST a DmcaTickBody: run the dmca-restore job once as of that time (test hooks only). */
  dmcaTick: "/internal/moderation/dmca-tick",
  /**
   * Interactivity test hook (served only while `INTERACT_TEST_HOOKS=true`, otherwise 404). `POST` an
   * `InteractTickBody`: the API enqueues that `INTERACT_JOBS` job, waits (30 s) and returns its
   * `InteractJobResult`.
   */
  interactTick: "/internal/interact/tick",
  /**
   * W2 analytics and attestation test hook (served only while `OPS_TEST_HOOKS=true`, otherwise
   * 404; harness only). `POST` an `AnalyticsTickBody`: the API enqueues that `ANALYTICS_JOBS` job for
   * one broadcast now, with the settle delay overridden, waits (60 s) and returns its result.
   */
  analyticsTick: "/internal/analytics/tick",
  /**
   * W2 test hook (same gate): `PUT` an `AnalyticsDisplayBypassBody`. While set, the analytics,
   * share-link and attestation reads skip the 24 h display delay for that channel
   * (`KEYS.analyticsDisplayBypass`, TTL `ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS`).
   */
  analyticsDisplayBypass: "/internal/analytics/display-bypass",
  /**
   * Chat dry run (W2-rehearsal, served by services/chat with the internal secret): `POST` a
   * `ChatDryRunBody`; the full send pipeline runs for a synthetic sender against the channel's
   * state and answers a `ChatDryRunResult`, never broadcasting or saving the message.
   */
  chatDryRun: "/internal/chat/dry-run",
  /**
   * Batch 7 decision (p): the worker hands a fetched image to the API's upload pipeline. `POST` an
   * `UploadCommitBody` (the image already written under `incoming/`); the API runs the same
   * `commitUpload` a user upload runs (hash lists, T0, classifier) and answers an
   * `UploadCommitResult`. Internal secret only.
   */
  uploadCommit: "/internal/uploads/commit",
  /**
   * Batch 7 test hooks (served only while `OPS_TEST_HOOKS=true`, otherwise 404; harness only).
   * `POST` a `B7TickBody`: the API enqueues that job now, waits (60 s) and returns its result.
   */
  b7Tick: "/internal/b7/tick",
  /** Same gate: `POST` a `WatchRoomAgeBody`: backdate a room (and end it) so retention sees it as old. */
  watchRoomAge: "/internal/watch-rooms/age",
  /** Same gate: `PUT` a `RelayPurgeHoldBody`: how long the purge feed holds an empty long poll (1 s in the harness). */
  relayPurgeHold: "/internal/relay/purge-hold",
} as const;

/**
 * Published on BUS.live by the API when a broadcast starts/ends or simulcast targets change, and by
 * media on transcode changes.
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("online"),
    channelId: z.uuid(),
    broadcastId: z.uuid(),
    slug: z.string(),
    path: z.string(),
    protocol: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("offline"),
    channelId: z.uuid(),
    broadcastId: z.uuid(),
    slug: z.string(),
    path: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("renditions"),
    channelId: z.uuid(),
    broadcastId: z.uuid(),
    renditions: z.array(z.enum(RENDITIONS)),
    at: z.string(),
  }),
  /**
   * Published by the API after a channel's simulcast targets change: media reconciles the pushes
   * of that channel's live broadcast (start enabled ones, stop disabled, removed or changed ones).
   */
  z.object({
    type: z.literal("simulcast-targets"),
    channelId: z.uuid(),
    at: z.string(),
  }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** Valkey keys shared across services. */
export const KEYS = {
  /** ZSET sessionId → last heartbeat (ms). Members older than 30 s are stale. */
  viewers: (channelId: string) => `viewers:${channelId}`,
  /** Cached verified viewer count for the channel (integer string, short TTL). */
  viewerCount: (channelId: string) => `viewer-count:${channelId}`,
  /** JSON array of active renditions for a live channel, set by media; absent = source only. */
  renditions: (channelId: string) => `renditions:${channelId}`,
  /**
   * `SOURCE_AAC_STATES` value (TTL refreshed by media): "pending" while the AAC copy is needed but
   * not live yet (origin answers the source with a retryable 503, so WebKit never gets Opus), "1"
   * while `sourceAacPath` carries the source. Absent: serve the source as is.
   */
  sourceAac: (channelId: string) => `source-aac:${channelId}`,
  /** HASH of simulcast target id → JSON {status,lastError,at}. */
  simulcastStatus: (broadcastId: string) => `simulcast:${broadcastId}`,
  /** HASH relayId → JSON {url,capacityMbps,status,load} for origin assignment. */
  relays: "relays:active",
  /** LIST of recent heartbeat evidence for a playback session (API writes, integrity reads). */
  integrityHeartbeats: (sessionId: string) => `integrity:hb:${sessionId}`,
  /** HASH of fetch counters for a playback session (worker's segment consumer writes, integrity reads). */
  integrityFetches: (sessionId: string) => `integrity:fetch:${sessionId}`,
  /** Rate-limit buckets. */
  rateLimit: (bucket: string, subject: string) => `rl:${bucket}:${subject}`,
  /**
   * HASH of P2P evidence for one playback session, written by the tracker on every authenticated
   * announce: `swarm` (a `p2pSwarm` id), `net` (the session's network: hex HMAC-SHA256 of the
   * announcing address's canonical /24 (IPv4) or /48 (IPv6) prefix, keyed with
   * `HMAC-SHA256(INTERNAL_API_SECRET, "p2p-net-v1")`), `first` / `last` (epoch ms), `announces`
   * (count). Expires P2P_EVIDENCE.peerTtlSeconds after the last write. Integrity reads it; only
   * the tracker writes it.
   */
  p2pPeer: (sessionId: string) => `p2p:peer:${sessionId}`,
  /**
   * ZSET peer `net` → epoch ms of the last **completed signalling exchange** this session took part
   * in with a peer on that network: the tracker relayed an offer between the two sessions and the
   * receiver's answer with the matching `offer_id` came back within 60 s. Both sides get the
   * other's `net`. Same TTL as `p2pPeer`; members older than the TTL are trimmed on write.
   */
  p2pLinks: (sessionId: string) => `p2p:links:${sessionId}`,
  /**
   * ZSET sessionId → last announce (epoch ms) for one swarm (`<channelId>:<infoHash hex>`).
   * Trimmed to the TTL window and given the same TTL on every write.
   */
  p2pSwarm: (swarm: string) => `p2p:swarm:${swarm}`,
  /**
   * ZSET sessionId → last announce (epoch ms) of every session on network `net` that announced to
   * any swarm of `channelId`. Unlike `p2pSwarm`, a `stopped` announce or a closed socket never
   * removes a member (leaving must not dodge the cap); members are trimmed to the TTL window and
   * the key gets the same TTL on every write. A session may hold several of its broadcast's stream
   * swarms (`p2pAllowedStreamSwarmIds`), so the per-network cap is counted here, per channel.
   */
  p2pChannelNet: (channelId: string, net: string) => `p2p:chnet:${channelId}:${net}`,
  /**
   * STRING: the session's P2P swarm id (the broadcast id), ADR 0005 amendment 1. Written by the
   * API at `playback.start` only when P2P is enabled for the session, TTL `P2P_GRANT_TTL_SECONDS`,
   * refreshed by each committed heartbeat, deleted by a heartbeat that finds the stream gated and
   * by `playback.end`. Read by the tracker (no grant, no socket; allowed info hashes derive from
   * it) and by `p2p.iceServers`. Absent means no P2P for that session, whatever the client says.
   */
  p2pGrant: (sessionId: string) => `p2p:grant:${sessionId}`,
  /**
   * Raw RGB 384×384 bytes of one sampled live frame for the classifier (media writes, the
   * worker's `moderation.scan` reads). TTL `MODERATION_FRAME_TTL_SECONDS`; never written anywhere
   * else unless the frame is flagged.
   */
  moderationFrame: (frameId: string) => `moderation:frame:${frameId}`,
  /** JSON `ModerationScores` for the scripted classifier (test hooks only). */
  moderationScript: (channelId: string) => `moderation:script:${channelId}`,
  /** HASH `<dir>|<metric>` → integer, for the minute starting at epochMinute × 60 s. */
  issuanceProduction: (epochMinute: number) => `issuance:production:${epochMinute}`,
  /** Claim marking a media object as counted (`<dir>/<file>`). */
  issuanceSeen: (object: string) => `issuance:seen:${object}`,
  /** Leader lock: the replica holding it computes relay issuance. */
  issuanceLock: "issuance:lock",
  /**
   * EventSub WebSocket session (hash, E9-ws): `instance`, `keepalive`, `connectedAt`, and once the
   * first subscription binds it `appId` ("" for personal tokens), `userId`, `tokenHash`. Expires
   * when the holding instance stops refreshing it.
   */
  eventsubSession: (sessionId: string) => `eventsub:session:${sessionId}`,
  /** ZSET of a grant's bound open session ids (score: bind time ms); `grant` = `${appId || "personal"}:${userId}`. */
  eventsubGrantSessions: (grant: string) => `eventsub:grant:${grant}`,
  /** One-time resume token (sha256) → session id, from a `session_reconnect`'s `reconnect_url`. */
  eventsubResume: (tokenHash: string) => `eventsub:resume:${tokenHash}`,
  /** Leader lock: the API instance holding it sweeps WebSocket subscriptions of vanished sessions. */
  eventsubSweepLock: "eventsub:sweep:lock",
  /** INCR on every accepted chat message of the channel (the bot's timers count lines). */
  botLines: (channelId: string) => `bot:lines:${channelId}`,
  /** The `botLines` value when the timer last fired. */
  botTimerMark: (timerId: string) => `bot:timer-mark:${timerId}`,
  /** SET NX PX lock: exactly one chat instance fires a due timer. */
  botTimerLock: (timerId: string) => `bot:timer-lock:${timerId}`,
  /** SET NX EX: a command's cooldown (per channel and command, not per user). */
  botCooldown: (channelId: string, command: string) => `bot:cooldown:${channelId}:${command}`,
  /**
   * ADR 0015 decision 1: STRING JSON `VerifiedWatchValue`, `SET … EX 600` by the integrity worker
   * after each scoring pass, for channels with the gate on or the surge guard enabled. The key is
   * per (channel, user); `b` in the value is the broadcast the seconds were earned on, and the gate
   * reads it only while `b` is the channel's live broadcast.
   *
   * Batch 7 decision (w), the raid carry: when a raid executes, the worker writes this key for the
   * **target** channel and each raider who was a verified watcher of the source in the last
   * `RAID_RULES.carryMinutes`, with `b` = the target's live broadcast, `s` and `f` = the source
   * value's, and a TTL of the surge's remaining time + 60 s (`raidCarryTtlSeconds`), through
   * `VERIFIED_WATCH_MERGE`. No separate carry key exists.
   *
   * Every writer (the scoring pass and the raid carry) uses the merge-write
   * `VERIFIED_WATCH_MERGE` (`services/worker/src/integrity/verified-watch.ts`), never a plain
   * `SET`: for the same broadcast `b` the larger `s` and the longer TTL are kept, so a scoring
   * pass never shortens or lowers a carry; a value for another broadcast is replaced.
   */
  verifiedWatch: (channelId: string, userId: string) => `verified-watch:${channelId}:${userId}`,
  /** ADR 0015 decision 6: STRING JSON `SurgeOverride`, TTL `until − now + 60 s`. */
  surgeOverride: (channelId: string) => `surge-override:${channelId}`,
  /** ADR 0015 decision 6: set while a recorded chat.surge.begin has no end yet (TTL 2 days). */
  surgeOpen: (channelId: string) => `surge-open:${channelId}`,
  /** ADR 0012 amendment 1 decision 4: STRING, the median viewer latency in seconds, TTL 60 s. */
  chatLatency: (channelId: string) => `chat-latency:${channelId}`,
  /**
   * W2-rehearsal (decision (f)): STRING JSON `RehearsalArm`, `SET … EX REHEARSAL_RULES.armTtlSeconds`
   * by `stream.rehearsal.arm`. While it exists `mediaAuth` accepts the channel's normal key and
   * `mediaReady` starts a `rehearsal` broadcast instead of a live one.
   */
  rehearsalArmed: (channelId: string) => `rehearsal:armed:${channelId}`,
  /**
   * Decision (f): STRING JSON `RehearsalArm`, set by `mediaReady` when a rehearsal starts, `EX
   * REHEARSAL_RULES.maxDurationSeconds + sessionGraceSeconds`. `mediaAuth` treats it like an arm, so
   * a reconnect after the arm's TTL still rehearses and never goes live. `stream.rehearsal.disarm`
   * deletes it with the arm (W2-rehearsal); a publish after that is live.
   */
  rehearsalSession: (channelId: string) => `rehearsal:session:${channelId}`,
  /**
   * Decision (f): STRING `"1"`, `EX REHEARSAL_RULES.kickCooldownSeconds`, set by whoever ends a
   * rehearsal with a kick (the W2-rehearsal cap and `disarm`, a moderation end: `afterBroadcastEnded`)
   * before kicking. While it exists `mediaAuth` refuses the channel's publishes, so the encoder's
   * automatic reconnect neither rehearses again nor goes live.
   */
  rehearsalKicked: (channelId: string) => `rehearsal:kicked:${channelId}`,
  /**
   * Decision (f): STRING JSON `RehearsalArm`, `EX 600`, the arm the latest authorized publish of
   * `slug` saw (`mediaAuth` writes, `mediaReady` reads; absent = live). `mediaReady` uses it only
   * while the arm or the session marker still holds the same `armId`.
   */
  rehearsalPublishMarker: (slug: string) => `media:publish-rehearsal:${slug}`,
  /** W2-rehearsal: STRING JSON report (worker writes every 5 s, the API reads), TTL 24 h. */
  rehearsalReport: (broadcastId: string) => `rehearsal:report:${broadcastId}`,
  /** W2 test hook: set while the 24 h analytics display delay is bypassed for the channel. */
  analyticsDisplayBypass: (channelId: string) => `analytics:display-bypass:${channelId}`,
  /** W2-dvr (ADR 0016 decision 6): cached catching-up (DVR mode) viewer count, beside `viewerCount`. */
  catchingUpCount: (channelId: string) => `catching-up-count:${channelId}`,
  /**
   * Batch 7 follow-up: STRING counter, `INCR` by media's frame scan for each sampled frame of a
   * rehearsal broadcast (never a live one), `EXPIRE REHEARSAL_REPORT_TTL_SECONDS`; the rehearsal
   * driver reads it into `RehearsalReport.moderation.samples`.
   */
  rehearsalModerationSamples: (broadcastId: string) => `rehearsal:moderation-samples:${broadcastId}`,
  /**
   * Batch 7 watch rooms (decision (q)): HASH member user id → JSON `RoomPresence` of the members
   * connected now, across chat instances. Each instance refreshes its members' fields; the key
   * expires `ROOM_PRESENCE_TTL_SECONDS` after the last refresh.
   */
  roomPresence: (roomId: string) => `room:presence:${roomId}`,
  /**
   * Decision (r): HASH member user id → JSON `RoomSyncReport` (the member's latest playhead). The
   * instance that owns the room's sync tick reads it every 2 s and publishes `room.sync {target}`.
   * The reserved field `_edge` (never a user id) holds chat's shared live-edge estimate, JSON
   * `{edge, at}` in epoch ms, so the 5 s cap is measured from the live edge, not the fastest member.
   */
  roomSync: (roomId: string) => `room:sync:${roomId}`,
  /** Decision (x) test hook: STRING seconds the purge feed holds an empty long poll (absent = `RELAY_PURGE_RULES.holdSeconds`). */
  relayPurgeHold: "relay-purge:hold",
  /**
   * Decision (x): STRING, the highest `relay_purges.seq` the cleanup deleted (the feed's reset
   * watermark). Only ever raised, and written before the delete.
   */
  relayPurgeWatermark: "relay-purge:watermark",
} as const;

/** `KEYS.roomPresence` field value. Ids and times only. */
export const RoomPresence = z.object({ instance: z.string().max(64), since: z.iso.datetime({ offset: true }) });
export type RoomPresence = z.infer<typeof RoomPresence>;
export const ROOM_PRESENCE_TTL_SECONDS = 60;
/** `KEYS.roomSync` field value: the member's playhead as a wall-clock instant, its mode, and when it was reported. */
export const RoomSyncReport = z.object({
  playheadWallclock: z.iso.datetime({ offset: true }),
  mode: z.enum(PLAYBACK_MODES),
  at: z.number().int(),
});
export type RoomSyncReport = z.infer<typeof RoomSyncReport>;

/** `KEYS.rehearsalArmed` value. Ids and times only. */
export const RehearsalArm = z.object({
  armId: z.uuid(),
  ownerId: z.uuid(),
  armedAt: z.iso.datetime({ offset: true }),
});
export type RehearsalArm = z.infer<typeof RehearsalArm>;
/** TTL of `KEYS.rehearsalReport`. */
export const REHEARSAL_REPORT_TTL_SECONDS = 86_400;
/** TTL of `KEYS.analyticsDisplayBypass`. */
export const ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS = 3600;

/** `KEYS.verifiedWatch` value: broadcast, gate-eligible seconds after jitter, privacy-relay fallback (ADR 0015 decisions 1, 4, 5). */
export const VerifiedWatchValue = z.object({
  b: z.uuid(),
  s: z.number().int().min(0),
  f: z.union([z.literal(0), z.literal(1)]),
});
export type VerifiedWatchValue = z.infer<typeof VerifiedWatchValue>;
/** `KEYS.surgeOverride` value. `by` is a user id or null for the job. */
export const SurgeOverride = z.object({
  state: z.enum(["on", "suppressed"]),
  since: z.string(),
  until: z.string(),
  by: z.uuid().nullable(),
});
export type SurgeOverride = z.infer<typeof SurgeOverride>;
/** ADR 0015 decision 4: verified-watch jitter (seconds) = HMAC-SHA256(INTERNAL_API_SECRET, prefix + broadcastId + ":" + userId) mod 31. */
export const VERIFIED_WATCH_JITTER = { prefix: "vw-jitter-v1:", modulo: 31 } as const;
export const VERIFIED_WATCH_TTL_SECONDS = 600;
/** ADR 0015 decision 4: denied sends per user per channel per minute before `msg_ratelimit`. */
export const WATCH_GATE_ATTEMPTS = { perMinute: 6, bucket: "chat-gate" } as const;

/**
 * Server-side P2P evidence rule (ADR 0005). Whether a client runs the P2P loader is client input,
 * so integrity never trusts `p2pCapable` or heartbeat `bytesP2p`. A session is P2P-evidenced for a
 * scoring window ending at `t` only if all hold:
 *
 * 1. it announced within `windowMs` (`p2pPeer.last >= t - windowMs`) to a swarm of its own channel;
 * 2. it completed a signalling exchange within `windowMs` with a peer on at least
 *    `minLinkedNetworks` network(s) other than its own `net` (`p2pLinks`), so merely announcing
 *    into a swarm that honest viewers populate earns nothing;
 * 3. its channel has at most `maxSessionsPerNetwork` in-window announcers on its `net`, counted
 *    across all of the channel's swarms (`ZCOUNT p2pChannelNet(channelId, net) (t-windowMs) +inf`);
 *    beyond that, no session on that network is evidenced (a farm behind one prefix cannot borrow
 *    an honest swarm's diversity or split into private swarms; honest viewers behind one large NAT
 *    lose only the P2P discount);
 * 4. at least one linked network from (2) is itself within the cap in (3), so two farm networks
 *    over the cap cannot vouch for each other.
 *
 * Evidenced sessions are judged "too few fetches" against the reduced P2P HTTP share and "too
 * many fetches" against share 1. Everyone else is judged as a plain HTTP session.
 */
export const P2P_EVIDENCE = {
  windowMs: 120_000,
  minLinkedNetworks: 1,
  maxSessionsPerNetwork: 16,
  peerTtlSeconds: 600,
  /** An offer relayed by the tracker must be answered within this to count as an exchange. */
  exchangeTimeoutMs: 60_000,
} as const;

/** TTL of `KEYS.p2pGrant`, in seconds: the default TRACKER_TOKEN_MAX_AGE_SECONDS. */
export const P2P_GRANT_TTL_SECONDS = 43_200;

/**
 * Swarm id used in `KEYS.p2pSwarm` and `p2pPeer.swarm`. `infoHash` is 40 lowercase hex characters
 * (the hex of the announced 20-character info hash), one of those the tracker derives from the
 * session's grant (`p2pAllowedStreamSwarmIds`); clients cannot choose others.
 */
export const p2pSwarmId = (channelId: string, infoHash: string) => `${channelId}:${infoHash.toLowerCase()}`;

/** Valkey streams (XADD) consumed by the worker. */
export const STREAMS = {
  /** One entry per segment/playlist served: fields of SegmentFetch. */
  segments: "stream:segments",
} as const;
export const SegmentFetch = z.object({
  sid: z.uuid(),
  cid: z.uuid(),
  src: z.enum(DELIVERY_SOURCES),
  rid: z.uuid().optional(),
  kind: z.enum(["playlist", "segment", "part"]),
  bytes: z.coerce.number().int().nonnegative(),
  /** Epoch ms. */
  at: z.coerce.number().int(),
  /**
   * Which media object was served (`<rendition dir>/<file>`), so integrity counts distinct
   * segments per session rather than requests. Optional for older producers.
   */
  obj: z.string().max(256).optional(),
  /**
   * ADR 0016 decision 6: which route served it, so integrity judges each playback mode's claimed
   * seconds against that mode's fetches. Absent = `live` (every producer before W2-dvr).
   */
  mode: z.enum(PLAYBACK_MODES).optional(),
});
export type SegmentFetch = z.infer<typeof SegmentFetch>;

/** BullMQ queues. Producers and consumers import names from here. */
export const QUEUES = {
  webhooks: "webhooks",
  clips: "clips",
  vodFinalize: "vod-finalize",
  exports: "exports",
  deletions: "deletions",
  integrity: "integrity",
  receipts: "receipts",
  email: "email",
  notifications: "notifications",
  retention: "retention",
  backups: "backups",
  /** Money housekeeping: pending-payment expiry, manual renewals, hold release (E4b). */
  payments: "payments",
  /** Trust & safety (E4c): `MODERATION_JOBS`. */
  moderation: "moderation",
  /** Co-op (E5): `COOP_JOBS`. Patronage runs are API calls (two-person approval), not jobs. */
  coop: "coop",
  /** Interactivity (E8, ADR 0026): `INTERACT_JOBS`. */
  interact: "interact",
  /** W2: the per-broadcast audience rollup and signed attestations (`ANALYTICS_JOBS`). */
  analytics: "analytics",
  /** W2-rehearsal: one driver job per armed rehearsal (`REHEARSAL_JOBS`). */
  rehearsal: "rehearsal",
  /** Batch 7: watch-room retention (`WATCH_ROOM_JOBS`). */
  watchRooms: "watch-rooms",
  /** Batch 7: the moved email, bundle builds and imports, Twitch imports (`PORTABILITY_JOBS`, `TWITCH_JOBS`). */
  portability: "portability",
  /** Batch 7: the advisory jury's draw and close (`JURY_JOBS`). */
  jury: "jury",
  /** Batch 7: ActivityPub inbox, delivery, fan-out, key rotation and sweeps (`FEDERATION_JOBS`). */
  federation: "federation",
  /** Batch 7: relay purge rows from the media-state events (`RELAY_PURGE_JOBS`). */
  relayPurge: "relay-purge",
} as const;

// Trust & safety (ADR 0006, docs/testing/e4c-selectors.md) ---------------------------------

/** A sampled frame lives in Valkey this long, then it is gone (unflagged frames are never stored). */
export const MODERATION_FRAME_TTL_SECONDS = 60;

/**
 * Job names on `QUEUES.moderation`. Producers: media (`scan`, `t0`), API (`t0` for uploads,
 * `t0Escalated`, `nciiClock` on the test hook), worker (`t0Media` and its schedules). The worker
 * owns every T0 transaction, so there is exactly one implementation of the T0 actions.
 */
export const MODERATION_JOBS = {
  scan: "scan",
  t0: "t0",
  t0Media: "t0-media",
  t0Escalated: "t0-escalated",
  nciiClock: "ncii-clock",
  nciiHash: "ncii-hash",
  evidenceAudit: "evidence-audit",
  ncmecUnfiled: "ncmec-unfiled",
  holdEligibility: "hold-eligibility",
  frameRetention: "frame-retention",
  incomingCleanup: "incoming-cleanup",
  dmcaDisable: "dmca-disable",
  dmcaRestore: "dmca-restore",
  /** Statements of reasons (ADR 0019 decision 5): build from `audit_log` every 15 s. */
  sorBuild: "sor-build",
  /** Daily: allowlisted audit rows older than 5 minutes without a statement raise an alert. */
  sorCoverage: "sor-coverage",
} as const;

/** 64 hex characters (a PDQ hash or a sha256). */
const Hex256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Per-category classifier scores in [0, 1]. A category the provider does not score is absent (never 0). */
export const ModerationScores = z.partialRecord(z.enum(MODERATION_CATEGORIES), z.number().min(0).max(1));
export type ModerationScores = z.infer<typeof ModerationScores>;

/** `MODERATION_JOBS.scan`: one sampled live frame; the RGB bytes are at `KEYS.moderationFrame(frameId)`. */
export const ModerationScanJob = z.object({
  frameId: z.uuid(),
  broadcastId: z.uuid(),
  channelId: z.uuid(),
  capturedAt: z.iso.datetime({ offset: true }),
  /** PDQ of the frame (media already matched it); null when the frame was below quality. */
  pdq: Hex256.nullable(),
  quality: z.number().int().min(0).max(100),
});
export type ModerationScanJob = z.infer<typeof ModerationScanJob>;

/**
 * One sealed evidence image travelling with a T0 job (seal format: `@commonair/moderation`
 * `seal`). `sha256` is of the plaintext. At most 1 MiB sealed, so it fits `evidence_objects`.
 */
export const SealedEvidence = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  contentType: z.enum(["image/webp", "image/jpeg", "image/png", "image/gif", "application/octet-stream"]),
  sealedBase64: z.base64().max(1_400_000),
  sha256: Hex256,
  sizeBytes: z.number().int().positive(),
  keyId: z.string().regex(/^[0-9a-f]{32}$/),
  pdq: Hex256.nullable(),
  pdqQuality: z.number().int().min(0).max(100).nullable(),
  capturedAt: z.iso.datetime({ offset: true }),
});
export type SealedEvidence = z.infer<typeof SealedEvidence>;

/**
 * `MODERATION_JOBS.t0`: a hash-list match. Media kicks the publisher before enqueueing; the API
 * rejects the upload before enqueueing. Enqueue with `jobId = t0JobId(subjectType, subjectId)` so
 * retries collapse; the worker retries the transaction until it lands.
 */
export const ModerationT0Job = z.object({
  subjectType: z.enum(MODERATION_SUBJECTS),
  /** Broadcast, VOD or clip id; for uploads the id the API minted for the rejected upload. */
  subjectId: z.uuid(),
  channelId: z.uuid(),
  /** The uploader for `upload`; otherwise resolved by the worker from the channel owner. */
  userId: z.uuid().nullable(),
  listCategory: z.enum(HASH_LIST_CATEGORIES),
  /** `pdq:operator-list` or `pdq:local` (the database block list). */
  provider: z.string().min(1).max(64),
  /** sha256 of the list file + entry count, or `local:<max id>` for the block list. */
  listVersion: z.string().min(1).max(200),
  distance: z.number().int().min(0).max(256),
  quality: z.number().int().min(0).max(100),
  capturedAt: z.iso.datetime({ offset: true }),
  /** The matched frame or upload (and for live, the frames around it), sealed. 1–8 objects. */
  evidence: z.array(SealedEvidence).min(1).max(8),
  /** For `upload`: which purpose was rejected (so support can explain), never the key. */
  uploadPurpose: z.enum(["avatar", "banner", "panel", "emote", "alert_image"]).optional(),
});
export type ModerationT0Job = z.infer<typeof ModerationT0Job>;
export const t0JobId = (subjectType: string, subjectId: string) => `t0:${subjectType}:${subjectId}`;

/** `MODERATION_JOBS.t0Media`: copy a T0 subject's VOD/clip/thumbnail objects to evidence, then delete the public copies. Idempotent. */
export const ModerationT0MediaJob = z.object({
  caseId: z.uuid(),
  holdId: z.uuid(),
  channelId: z.uuid(),
  /** The broadcast whose VODs, clips and thumbnails are copied; null for upload subjects. */
  broadcastId: z.uuid().nullable(),
});
export type ModerationT0MediaJob = z.infer<typeof ModerationT0MediaJob>;

/** `MODERATION_JOBS.t0Escalated`: a `legal` user confirmed a human-escalated case; run the full T0 actions. */
export const ModerationT0EscalatedJob = z.object({ caseId: z.uuid(), confirmedById: z.uuid() });
export type ModerationT0EscalatedJob = z.infer<typeof ModerationT0EscalatedJob>;

/** `MODERATION_JOBS.nciiClock`: scheduled every minute with no `asOf`; the test hook passes one. */
export const NciiClockJob = z.object({ asOf: z.iso.datetime({ offset: true }).optional() });
export type NciiClockJob = z.infer<typeof NciiClockJob>;
export const NciiClockResult = z.object({
  escalated24: z.number().int(),
  escalated36: z.number().int(),
  autoHidden: z.number().int(),
});
export type NciiClockResult = z.infer<typeof NciiClockResult>;

/**
 * `MODERATION_JOBS.nciiHash`: after `ncii.decide` → `removed` (the API already unpublished every
 * resolved subject in its transaction), hash the removed content (frames every sample interval,
 * quality ≥ 50) into `local_hash_list` as `ncii`, then delete the objects. Idempotent.
 */
export const NciiHashJob = z.object({ requestId: z.uuid() });
export type NciiHashJob = z.infer<typeof NciiHashJob>;

/** Body of `INTERNAL_ROUTES.moderationScript`. */
export const ModerationScriptBody = z.object({ channelId: z.uuid(), scores: ModerationScores });
/** Body of `INTERNAL_ROUTES.nciiTick`; the response is `NciiClockResult`. */
export const NciiTickBody = z.object({ asOf: z.iso.datetime({ offset: true }) });

/**
 * `MODERATION_JOBS.dmcaDisable`: after `dmca.action` → `actioned` (the API already unpublished every
 * resolved item in its transaction), move the items' objects to the private DMCA prefix. Idempotent.
 */
export const DmcaDisableJob = z.object({ noticeId: z.uuid() });
export type DmcaDisableJob = z.infer<typeof DmcaDisableJob>;
/** `MODERATION_JOBS.dmcaRestore`: restore countered content whose waiting period ended (as of `asOf`, default now). */
export const DmcaRestoreJob = z.object({ asOf: z.iso.datetime({ offset: true }).optional() });
export type DmcaRestoreJob = z.infer<typeof DmcaRestoreJob>;
export const DmcaRestoreResult = z.object({ restored: z.number().int(), counters: z.number().int() });
export type DmcaRestoreResult = z.infer<typeof DmcaRestoreResult>;
/** Body of `INTERNAL_ROUTES.dmcaTick`; the response is `DmcaRestoreResult`. */
export const DmcaTickBody = z.object({ asOf: z.iso.datetime({ offset: true }) });
export type DmcaTickBody = z.infer<typeof DmcaTickBody>;

/**
 * Chat connection token, issued by the API (`chat.connectToken`) and verified by the
 * chat service: base64url(JSON ChatTokenClaims) "." base64url(HMAC-SHA256(key, claimsBytes)),
 * key = HMAC-SHA256(INTERNAL_API_SECRET, "chat-token-v1").
 */
export const ChatTokenClaims = z.object({
  v: z.literal(1),
  /** Null for anonymous read-only connections. */
  uid: z.uuid().nullable(),
  /** OAuth app id when the connection is on behalf of an app/bot. */
  app: z.uuid().nullable(),
  scopes: z.array(z.string()),
  exp: z.number().int(),
});
export type ChatTokenClaims = z.infer<typeof ChatTokenClaims>;
export const CHAT_TOKEN_TTL_SECONDS = 300;

/** Job names and payloads on QUEUES.webhooks (producers: API and outbox relay; consumer: worker). */
export const WEBHOOK_JOBS = {
  /** Outbox event → matching subscriptions → one `deliver` job each. */
  fanout: "fanout",
  deliver: "deliver",
  /** Enqueued by the API right after a webhook subscription is created. */
  verifyCallback: "verify-callback",
  /** `developer.events.sendTest`. */
  testEvent: "test-event",
  /** `developer.events.redeliver`. */
  redeliver: "redeliver",
  /** A webhook subscription was revoked by the API (grant revoked, app suspended): tell the receiver once. */
  revocation: "revocation",
} as const;

export const FanoutJob = z.object({ eventId: z.uuid() });
export const DeliverJob = z.object({
  subscriptionId: z.uuid(),
  eventId: z.uuid(),
  attempt: z.number().int().min(1).default(1),
  /** Test events have no outbox row: the synthesized payload travels with the job. */
  sample: z.record(z.string(), z.unknown()).optional(),
});
export type DeliverJob = z.infer<typeof DeliverJob>;
export const VerifyCallbackJob = z.object({ subscriptionId: z.uuid() });
export const TestEventJob = z.object({ subscriptionId: z.uuid(), eventId: z.uuid().optional() });
export const RedeliverJob = z.object({ deliveryId: z.uuid() });
export const RevocationJob = z.object({ subscriptionId: z.uuid() });
export type RevocationJob = z.infer<typeof RevocationJob>;

// Notifications (N1, ADR 0028) ---------------------------------------------------------------

/**
 * Job names on `QUEUES.notifications`, `QUEUES.email` and `QUEUES.retention` (N1, ADR 0028 decision
 * 8). Producers: the outbox relay (`goLive`, one per `stream.online`), the go-live job (`push`,
 * `discord`, and its own next page), the API (`discord` for `notifications.discord.test`).
 * `emailDigest` and `prune` are scheduled.
 */
export const NOTIFY_JOBS = {
  goLive: "go-live",
  push: "push",
  discord: "discord",
  emailDigest: "email-digest",
  prune: "notify-prune",
} as const;
/** `NOTIFY_JOBS.goLive`: one page of the channel's followers after `after` (null: the first page). */
export const GoLiveJob = z.object({ eventId: z.uuid(), after: z.uuid().nullable().default(null) });
export type GoLiveJob = z.infer<typeof GoLiveJob>;
/** `NOTIFY_JOBS.push`: every push subscription of one member for one go-live. */
export const PushJob = z.object({ eventId: z.uuid(), userId: z.uuid(), channelId: z.uuid(), broadcastId: z.uuid() });
export type PushJob = z.infer<typeof PushJob>;
/** `NOTIFY_JOBS.discord`: one post (`test`: the studio's test button, no cooldown, no broadcast). */
export const DiscordJob = z.object({
  channelId: z.uuid(),
  eventId: z.uuid().nullable(),
  broadcastId: z.uuid().nullable(),
  test: z.boolean().default(false),
});
export type DiscordJob = z.infer<typeof DiscordJob>;
export const EmailDigestJob = z.object({});
export const NotifyPruneJob = z.object({});

// Co-op (E5, ADR 0020, docs/testing/e5-selectors.md) ----------------------------------------

/**
 * Job names on `QUEUES.coop` (all scheduled by the worker; the API enqueues them only on the test
 * hook). Each step the jobs take is one transaction with its audit row and event.
 */
export const COOP_JOBS = {
  /** Hourly: `syncMemberships` (streamers by hours, viewers by subscription; respects voluntary exits). */
  membershipSync: "membership-sync",
  /** Every 15 s: discussion → council review → voting → decided (+ tally) → applied. */
  proposalsAdvance: "proposals-advance",
  /** Daily: seat a new council term when none is current, the month changed, or a seat is vacant. */
  councilRecompute: "council-recompute",
  /** Every minute: nominating → voting, then `closeElection` when voting ends. */
  electionsAdvance: "elections-advance",
  /**
   * Test hook only (no schedule here): run the integrity `stream-hours` pass now, under its run
   * lock, so a test streamer qualifies without waiting for the 5-minute integrity schedule.
   */
  streamHours: "stream-hours",
} as const;
export type CoopJobName = (typeof COOP_JOBS)[keyof typeof COOP_JOBS];
export const COOP_JOB_NAMES = Object.values(COOP_JOBS) as [CoopJobName, ...CoopJobName[]];
/** Every co-op job takes an empty payload: it works from the database state and the clock. */
export const CoopJob = z.object({});
export type CoopJob = z.infer<typeof CoopJob>;

/** Body of `INTERNAL_ROUTES.coopTick`; the response is the job's `CoopJobResult`. */
export const CoopTickBody = z.object({ job: z.enum(COOP_JOB_NAMES) });
export type CoopTickBody = z.infer<typeof CoopTickBody>;
/** What a co-op job returns (counts only; logged and returned by the test hook). */
export const CoopJobResult = z.record(z.string(), z.number().int());
export type CoopJobResult = z.infer<typeof CoopJobResult>;

// Data export and operations (E6, ADR 0021, docs/testing/e6-selectors.md) --------------------

/** An export's archive and signed link live this long after it completes (also the SigV4 maximum). */
export const EXPORT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** One export per kind per user in this window (`RATE_LIMITED` with `retryAfterSeconds`). */
export const EXPORT_COOLDOWN_SECONDS = 24 * 60 * 60;
/** `manifest.json` `formatVersion` of the archive; bump on any incompatible change to its files. */
export const EXPORT_FORMAT_VERSION = 1;

/** Jobs on `QUEUES.exports`. */
export const EXPORT_JOBS = {
  /** Enqueued by `me.exports.create` (job id = export id): build, upload, email the link. */
  build: "export-build",
  /** Hourly: delete archives past `expires_at`, mark the exports `expired`. */
  cleanup: "export-cleanup",
} as const;
export const ExportBuildJob = z.object({ exportId: z.uuid() });
export type ExportBuildJob = z.infer<typeof ExportBuildJob>;
/** Object key of an export archive in `S3_BUCKET_EXPORTS`; the worker writes nothing else there. */
export const exportObjectKey = (userId: string, exportId: string) => `exports/${userId}/${exportId}.zip`;

/** Jobs the ops test hook can run now. Each already runs on its own schedule. */
export const OPS_TICK_JOBS = [
  "account-deletion",
  "export-cleanup",
  "vod-retention",
  "vod-placement",
  // W1: the harness runs these now through the ops hook.
  "chat-retention",
  "chat-surge-guard",
  "money-fraud-scan",
  "money-reconcile",
  // N1: notifications retention (ADR 0028), run now by the unit's test and the harness.
  "notify-prune",
] as const;
/** Body of `INTERNAL_ROUTES.opsTick`; the response is the job's result (counts only). */
export const OpsTickBody = z.object({ job: z.enum(OPS_TICK_JOBS) });
export type OpsTickBody = z.infer<typeof OpsTickBody>;
export const OpsJobResult = z.record(z.string(), z.number().int());
export type OpsJobResult = z.infer<typeof OpsJobResult>;

// Interactivity (E8, ADR 0026, docs/testing/e8-selectors.md) -------------------------------

/** Jobs on `QUEUES.interact`; all scheduled by the worker, enqueued by the API only on the test hook. */
export const INTERACT_JOBS = {
  /** Every 2 s: end due polls, lock due predictions, emit throttled `*.progress` events. */
  tick: "interact-tick",
  /** Every 2 s: execute or cancel raids whose countdown ended. */
  raidsExecute: "raids-execute",
  /** Every 60 s: credit gate-eligible watch time (ADR 0026 decision 1). */
  pointsAccrue: "points-accrue",
} as const;
export type InteractJobName = (typeof INTERACT_JOBS)[keyof typeof INTERACT_JOBS];
export const INTERACT_JOB_NAMES = Object.values(INTERACT_JOBS) as [InteractJobName, ...InteractJobName[]];
/** Every interactivity job takes an empty payload: it works from the database state and the clock. */
export const InteractJob = z.object({});
export type InteractJob = z.infer<typeof InteractJob>;
/** Body of `INTERNAL_ROUTES.interactTick`; the response is the job's `InteractJobResult`. */
export const InteractTickBody = z.object({ job: z.enum(INTERACT_JOB_NAMES) });
export type InteractTickBody = z.infer<typeof InteractTickBody>;
/** What an interactivity job returns (counts only; logged and returned by the test hook). */
export const InteractJobResult = z.record(z.string(), z.number().int());
export type InteractJobResult = z.infer<typeof InteractJobResult>;

// Feature wins, wave 2 (W2; .claude/briefs/w2/contract-step.md §1.4) ------------------------

/**
 * Jobs on `QUEUES.analytics`. Producers: the outbox relay (`broadcastRollup` delayed by
 * `AUDIENCE_SETTLE_SECONDS` on `stream.offline`, `reason: "rescore"` on `integrity.sessions.rescored`;
 * `integrityAttestation` on `analytics.rollup.ready`), the worker's daily `attestationReconcile`
 * schedule, and the API on the test hook (`reason: "test"`). Both per-broadcast jobs are idempotent
 * and safe to re-run; enqueue with `jobId = analyticsJobId(name, broadcastId, reason)`.
 */
export const ANALYTICS_JOBS = {
  broadcastRollup: "broadcast-rollup",
  /** Daily: purge per-minute audience rows past retention for broadcasts no rollup touches. */
  broadcastRollupRetention: "broadcast-rollup-retention",
  integrityAttestation: "integrity-attestation",
  /** Daily: re-check broadcasts re-scored or re-rolled after their latest attestation entry. */
  attestationReconcile: "attestation-reconcile",
} as const;
export type AnalyticsJobName = (typeof ANALYTICS_JOBS)[keyof typeof ANALYTICS_JOBS];
export const BroadcastRollupJob = z.object({
  broadcastId: z.uuid(),
  reason: z.enum(["offline", "rescore", "test"]),
  /** Test hook only: settle delay to wait for instead of `AUDIENCE_SETTLE_SECONDS` (0 = now). */
  settleSeconds: z.number().int().min(0).max(86_400).optional(),
});
export type BroadcastRollupJob = z.infer<typeof BroadcastRollupJob>;
export const IntegrityAttestationJob = z.object({
  broadcastId: z.uuid(),
  reason: z.enum(["rollup", "recheck", "reconcile", "test"]),
});
export type IntegrityAttestationJob = z.infer<typeof IntegrityAttestationJob>;
export const AttestationReconcileJob = z.object({});
export const analyticsJobId = (name: AnalyticsJobName, broadcastId: string, reason: string) =>
  `${name}:${broadcastId}:${reason}`;
/** What an analytics job returns (counts only). */
export const AnalyticsJobResult = z.record(z.string(), z.number().int());
export type AnalyticsJobResult = z.infer<typeof AnalyticsJobResult>;
/** Body of `INTERNAL_ROUTES.analyticsTick`; the response is the job's `AnalyticsJobResult`. */
export const AnalyticsTickBody = z.object({
  job: z.enum([ANALYTICS_JOBS.broadcastRollup, ANALYTICS_JOBS.integrityAttestation]),
  broadcastId: z.uuid(),
  /** Defaults to 0: run as if the settle delay had passed. */
  settleSeconds: z.number().int().min(0).max(86_400).default(0),
});
export type AnalyticsTickBody = z.infer<typeof AnalyticsTickBody>;
/** Body of `INTERNAL_ROUTES.analyticsDisplayBypass`. */
export const AnalyticsDisplayBypassBody = z.object({ channelId: z.uuid(), enabled: z.boolean() });
export type AnalyticsDisplayBypassBody = z.infer<typeof AnalyticsDisplayBypassBody>;

/** Jobs on `QUEUES.rehearsal`: one driver per arm, started on `rehearsal.armed` (`jobId = rehearsal-<armId>`: BullMQ refuses a two-part id with a colon). */
export const REHEARSAL_JOBS = { driver: "rehearsal-driver", capSweep: "rehearsal-cap-sweep" } as const;
export const RehearsalDriverJob = z.object({ armId: z.uuid(), channelId: z.uuid() });
export type RehearsalDriverJob = z.infer<typeof RehearsalDriverJob>;

/** Body of `INTERNAL_ROUTES.chatDryRun`: one simulated message for a channel. Never stored. */
export const ChatDryRunBody = z.object({
  channelId: z.uuid(),
  /** A stable synthetic sender id (never a real account) so duplicate and rate rules apply per sender. */
  senderKey: z.string().min(1).max(64),
  body: z.string().min(1).max(500),
});
export type ChatDryRunBody = z.infer<typeof ChatDryRunBody>;
export const ChatDryRunResult = z.object({
  outcome: z.enum(["accepted", "held", "rejected"]),
  /** The notice code the sender would have seen (`CHAT_NOTICE` codes), null when accepted. */
  code: z.string().max(64).nullable(),
});
export type ChatDryRunResult = z.infer<typeof ChatDryRunResult>;

// Batch 7: W3, N3, N4 (.claude/briefs/w3/contract-step.md §2.6) -----------------------------

/** Jobs on `QUEUES.watchRooms`. `retention` runs daily (and on the test hook). */
export const WATCH_ROOM_JOBS = { retention: "watch-room-retention" } as const;
export const WatchRoomRetentionJob = z.object({});

/**
 * Jobs on `QUEUES.portability`. `moved`: on `channel.moved`, one email per grant holder, then the
 * grants go (decision (l); `jobId = portabilityJobId("moved", eventId)`). `build`: a `bundle`
 * export. `import`: `applyBundle` for one import.
 */
export const PORTABILITY_JOBS = {
  moved: "portability-moved",
  build: "portability-build",
  import: "portability-import",
} as const;
export const PortabilityMovedJob = z.object({ channelId: z.uuid(), eventId: z.uuid() });
export type PortabilityMovedJob = z.infer<typeof PortabilityMovedJob>;
export const PortabilityBuildJob = z.object({ exportId: z.uuid() });
export type PortabilityBuildJob = z.infer<typeof PortabilityBuildJob>;
export const PortabilityImportJob = z.object({ importId: z.uuid() });
export type PortabilityImportJob = z.infer<typeof PortabilityImportJob>;
/** Twitch import (N3) on `QUEUES.portability`: fetch from Helix, build a `twitch` bundle, `applyBundle`. */
export const TWITCH_JOBS = { import: "import-twitch" } as const;
export const TwitchImportJob = z.object({ importId: z.uuid() });
export type TwitchImportJob = z.infer<typeof TwitchImportJob>;
/** Stable BullMQ ids (no colon: BullMQ refuses a two-part id with one). */
export const portabilityJobId = (name: string, id: string) => `${name}-${id}`;

/** Giveaways (decision (t)) on `QUEUES.interact`: the timed close, delayed to `closes_at`. */
export const GIVEAWAY_JOBS = { close: "giveaway-close" } as const;
export const GiveawayCloseJob = z.object({ giveawayId: z.uuid() });
export type GiveawayCloseJob = z.infer<typeof GiveawayCloseJob>;

/** Jobs on `QUEUES.jury` (decision (u)): `draw` monthly (and on the test hook), `close` 14 days after a draw. */
export const JURY_JOBS = { draw: "jury-draw", close: "jury-close" } as const;
export const JuryDrawJob = z.object({});
export const JuryCloseJob = z.object({ panelId: z.uuid().optional() });
export type JuryCloseJob = z.infer<typeof JuryCloseJob>;

/**
 * Jobs on `QUEUES.federation` (ADR 0030). `inbox`: process one inbox item (`federation.inbox.received`).
 * `deliver`: POST one activity to one inbox. `fanout`: turn one outbox event into deliveries for a
 * channel's followers. `rotate`: rotate actor keys older than `FEDERATION_RULES.keyRotateDays`.
 * `sweep`: drop inbox items and failing inboxes past `FEDERATION_RULES.dropAfterDays`.
 */
export const FEDERATION_JOBS = {
  inbox: "federation-inbox",
  deliver: "federation-deliver",
  fanout: "federation-fanout",
  rotate: "federation-rotate",
  sweep: "federation-sweep",
} as const;
export const FederationInboxJob = z.object({ itemId: z.uuid() });
export type FederationInboxJob = z.infer<typeof FederationInboxJob>;
export const FederationFanoutJob = z.object({ eventId: z.uuid() });
export type FederationFanoutJob = z.infer<typeof FederationFanoutJob>;
export const FederationDeliverJob = z.object({
  channelId: z.uuid(),
  /** The remote inbox (or shared inbox) URL. */
  inbox: z.url(),
  /** The `federation_objects` id the activity is about, or null for an `Accept` or `Reject`. */
  objectId: z.uuid().nullable(),
  /** The activity JSON to sign and send. */
  activity: z.record(z.string(), z.unknown()),
  attempt: z.number().int().min(1).default(1),
});
export type FederationDeliverJob = z.infer<typeof FederationDeliverJob>;
export const FederationRotateJob = z.object({ channelId: z.uuid().optional() });
export const FederationSweepJob = z.object({});
export const federationJobId = (name: string, id: string) => `${name}-${id}`;

/** Relay purges (decision (x)) on `QUEUES.relayPurge`: write `relay_purges` rows for one outbox event. */
export const RELAY_PURGE_JOBS = { emit: "relay-purge" } as const;
export const relayPurgeJobId = (name: string, id: string) => `${name}-${id}`;
export const RelayPurgeEmitJob = z.object({ eventId: z.uuid() });
export type RelayPurgeEmitJob = z.infer<typeof RelayPurgeEmitJob>;

/** Body of `INTERNAL_ROUTES.uploadCommit` (decision (p)). `key` is the `incoming/` key the worker wrote. */
export const UploadCommitBody = z.object({
  channelId: z.uuid(),
  userId: z.uuid(),
  key: z.string().min(1).max(300),
  purpose: z.enum(["panel", "emote"]),
});
export type UploadCommitBody = z.infer<typeof UploadCommitBody>;
/** The published key and URL, or the same opaque refusal a user upload gets. */
export const UploadCommitResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), key: z.string(), url: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal("upload_rejected") }),
]);
export type UploadCommitResult = z.infer<typeof UploadCommitResult>;

/** Jobs `INTERNAL_ROUTES.b7Tick` runs now (test hooks only). */
export const B7_TICK_JOBS = [
  WATCH_ROOM_JOBS.retention,
  JURY_JOBS.draw,
  JURY_JOBS.close,
  GIVEAWAY_JOBS.close,
  FEDERATION_JOBS.rotate,
  FEDERATION_JOBS.sweep,
] as const;
export const B7TickBody = z.object({
  job: z.enum(B7_TICK_JOBS),
  /** The job's payload (validated by the job's own schema). */
  data: z.record(z.string(), z.unknown()).default({}),
});
export type B7TickBody = z.infer<typeof B7TickBody>;
export const B7JobResult = z.record(z.string(), z.number().int());
export type B7JobResult = z.infer<typeof B7JobResult>;
/** Body of `INTERNAL_ROUTES.watchRoomAge`: end the room (if open) and move its times this many days back. */
export const WatchRoomAgeBody = z.object({ roomId: z.uuid(), days: z.number().int().min(1).max(365) });
export type WatchRoomAgeBody = z.infer<typeof WatchRoomAgeBody>;
/** Body of `INTERNAL_ROUTES.relayPurgeHold`; null restores the default. */
export const RelayPurgeHoldBody = z.object({ seconds: z.number().int().min(1).max(25).nullable() });
export type RelayPurgeHoldBody = z.infer<typeof RelayPurgeHoldBody>;
