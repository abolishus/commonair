// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Service-to-service contracts that are not part of the public API: internal
 * HTTP hooks, Valkey keys and streams, BullMQ queue names, and the chat
 * connection token. Internal HTTP calls carry `x-internal-secret: <INTERNAL_API_SECRET>`
 * and are served on the API under `/internal/*`, which Caddy never exposes.
 */
import { z } from "zod";
import { DELIVERY_SOURCES, RENDITIONS } from "./enums.ts";

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
} as const;

/** Published on BUS.live by the API when a broadcast starts/ends, and by media on transcode changes. */
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
   * the key gets the same TTL on every write. Client-chosen info hashes make per-swarm counts
   * meaningless, so the per-network cap is counted here, per channel.
   */
  p2pChannelNet: (channelId: string, net: string) => `p2p:chnet:${channelId}:${net}`,
} as const;

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

/** Swarm id used in `KEYS.p2pSwarm` and `p2pPeer.swarm`. `infoHash` is 40 lowercase hex characters. */
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
});
export type SegmentFetch = z.infer<typeof SegmentFetch>;

/** BullMQ queues. Producers and consumers import names from here. */
export const QUEUES = {
  webhooks: "webhooks",
  clips: "clips",
  vodFinalize: "vod-finalize",
  exports: "exports",
  deletions: "deletions",
  patronage: "patronage",
  council: "council",
  integrity: "integrity",
  receipts: "receipts",
  email: "email",
  notifications: "notifications",
  retention: "retention",
  backups: "backups",
} as const;

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
