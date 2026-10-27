// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Frame shapes the pinned P2P client sends, copied from p2p-media-loader-core 4.0.0
 * (`node_modules/p2p-media-loader-core/src`, read 2026-10-27). Line numbers name the source.
 *
 * - Peer id: `generatePeerId(TRACKER_CLIENT_VERSION_PREFIX)` (`utils/peer.ts:3`, `:9-21`): the prefix
 *   `-PM0400-` plus 12 characters of `[A-Za-z0-9]`, 20 ASCII characters. One per `Core`, shared by
 *   every swarm it joins (`core.ts:158`).
 * - Offer id: `generateOfferId()` (`webtorrent/webtorrent-client/index.ts:68-76`), 20 characters
 *   of `[A-Za-z0-9]`.
 * - Info hash: `computeInfoHash(streamSwarmId)` (`stream-identity.ts:124-126`), 20 Base64
 *   characters (`src/infohash.ts`).
 * - Announce: `#buildAnnouncePayload` (`webtorrent-client/index.ts:544-571`): always `numwant`
 *   (= the number of offers it made, 0 when it makes none), `uploaded: 0`, `downloaded: 0`,
 *   `offers`; `event` only for `started` (first announce after each connect, `:200-217`) and
 *   `stopped` (`#sendStopped`, `:528-542`, when the rendition's loader is destroyed); `trackerid`
 *   only after a response carried `"tracker id"` (`:283-289`), which this tracker never sends.
 * - Offers: `{ offer: { type, sdp }, offer_id }` (`:503-506`); `type` is the local description's,
 *   `"offer"`.
 * - Answer: `#handleIncomingOffer` (`:607-614`): `info_hash`, `peer_id`, `to_peer_id`, `offer_id`
 *   and `answer: { type: "answer", sdp }`, with no `numwant`, `offers` or `event`.
 * - It never sends `scrape`, `left` or `event: "completed" | "update"`.
 *
 * What it reads back (`#onWsMessage`, `:224-334`): it drops a message whose string `info_hash`
 * is not its own; `"warning message"`; `"failure reason"` (an error, nothing else read);
 * `interval` (> 0, floored at 20 s); `"tracker id"`; then, ignoring its own `peer_id`, `peer_id`
 * plus `offer_id` plus an `offer` or `answer` that is `{ type, sdp }` with `type` in
 * offer/answer/pranswer/rollback. It never reads `complete`, `incomplete` or `scrape`.
 */
import { P2P_INFOHASH_VECTORS } from "@commonair/contracts/internal";

export const LIB = "p2p-media-loader-core@4.0.0";

/** A real vector hash (the client's `info_hash` for one derived stream swarm id). */
export const INFO_HASH = (P2P_INFOHASH_VECTORS[0] as { infoHash: string }).infoHash;
export const PEER_ID = "-PM0400-a1B2c3D4e5F6";
export const OTHER_PEER_ID = "-PM0400-Zz9Yy8Xx7Ww6";
export const OFFER_ID = "Qw3rTy5uI7oP9aS1dF3g";

export const OFFER_SDP = {
  type: "offer",
  sdp: "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n",
};
export const ANSWER_SDP = {
  type: "answer",
  sdp: "v=0\r\no=- 1946483019416331447 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n",
};

/** `#announce("started")` after connect, (`:200-217`, `:379-460`; the default makes five offers, one here). */
export const startedWithOffers = (infoHash = INFO_HASH, peerId = PEER_ID) => ({
  action: "announce",
  info_hash: infoHash,
  peer_id: peerId,
  numwant: 1,
  uploaded: 0,
  downloaded: 0,
  offers: [{ offer: OFFER_SDP, offer_id: OFFER_ID }],
  event: "started",
});

/** The periodic re-announce when `shouldGenerateOffers()` is false: no offers, `numwant: 0`. */
export const periodicNoOffers = (infoHash = INFO_HASH, peerId = PEER_ID) => ({
  action: "announce",
  info_hash: infoHash,
  peer_id: peerId,
  numwant: 0,
  uploaded: 0,
  downloaded: 0,
  offers: [],
});

/** A re-announce after a tracker sent `"tracker id"` (never this one): `trackerid` is echoed. */
export const periodicWithTrackerId = (infoHash = INFO_HASH, peerId = PEER_ID) => ({
  ...periodicNoOffers(infoHash, peerId),
  trackerid: "abc",
});

/** `#sendStopped` from `destroy()` (`:528-542`). */
export const stopped = (infoHash = INFO_HASH, peerId = PEER_ID) => ({
  action: "announce",
  info_hash: infoHash,
  peer_id: peerId,
  numwant: 0,
  uploaded: 0,
  downloaded: 0,
  offers: [],
  event: "stopped",
});

/** The answer to a relayed offer (`:607-614`). */
export const answer = (infoHash = INFO_HASH, peerId = PEER_ID, toPeerId = OTHER_PEER_ID, offerId = OFFER_ID) => ({
  action: "announce",
  info_hash: infoHash,
  peer_id: peerId,
  to_peer_id: toPeerId,
  offer_id: offerId,
  answer: ANSWER_SDP,
});

export type ClientEvent =
  | { kind: "ignored" }
  | { kind: "failure"; reason: string }
  | { kind: "interval"; seconds: number }
  | { kind: "offer"; peerId: string; offerId: string }
  | { kind: "answer"; peerId: string; offerId: string }
  | { kind: "none" };

const SDP_TYPES = new Set(["offer", "answer", "pranswer", "rollback"]);
const isSdp = (v: unknown) =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Record<string, unknown>).type === "string" &&
  SDP_TYPES.has((v as Record<string, unknown>).type as string) &&
  typeof (v as Record<string, unknown>).sdp === "string";

/** What `WebTorrentClient#onWsMessage` (`:224-334`) makes of one tracker message. */
export function clientReads(msg: Record<string, unknown>, own: { infoHash: string; peerId: string }): ClientEvent {
  if (typeof msg.info_hash === "string" && msg.info_hash !== own.infoHash) return { kind: "ignored" };
  if (typeof msg["failure reason"] === "string") return { kind: "failure", reason: msg["failure reason"] };
  if (typeof msg.interval === "number" && msg.interval > 0) return { kind: "interval", seconds: msg.interval };
  const { peer_id: peerId, offer_id: offerId } = msg;
  if (typeof peerId === "string" && peerId === own.peerId) return { kind: "ignored" };
  if (typeof peerId !== "string" || typeof offerId !== "string") return { kind: "none" };
  if (isSdp(msg.offer)) return { kind: "offer", peerId, offerId };
  if (isSdp(msg.answer)) return { kind: "answer", peerId, offerId };
  return { kind: "none" };
}
