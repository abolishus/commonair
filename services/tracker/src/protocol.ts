// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The WebTorrent WebSocket tracker protocol subset that browser WebTorrent and
 * p2p-media-loader clients send (ADR 0005). Frames are JSON text. `info_hash`, `peer_id`,
 * `to_peer_id` and `offer_id` are 20-byte binary strings: 20 characters, each char code 0–255.
 * p2p-media-loader 4.0.0 sends 20 ASCII characters for all four (`tests/fixtures.ts`).
 */
import { ALLOWED_PER_GRANT } from "./infohash.ts";

export const LIMITS = {
  /** Largest text frame accepted; Bun closes the socket with 1009 above it. */
  maxFrameBytes: 64 * 1024,
  maxOffersPerAnnounce: 10,
  /**
   * Every allowed hash of one grant (10). The loader keeps a rendition's swarm for 30 s after a
   * level switch (`p2pInactiveLoaderDestroyTimeoutMs`) before it sends `stopped`, and audio is
   * a swarm of its own, so a session can briefly hold more than four; it can never hold a hash
   * outside its grant's set.
   */
  maxSwarmsPerSocket: ALLOWED_PER_GRANT,
  maxSdpLength: 16 * 1024,
  maxScrapeHashes: 10,
  /** Token bucket per socket: burst and sustained frames per second. */
  rateBurst: 20,
  ratePerSecond: 5,
  /** Seconds without traffic (Bun pings in between) before the socket is closed. */
  idleTimeoutSeconds: 150,
  /**
   * Bytes queued to a slow socket before it is closed: relayed offers are fan-out the receiver
   * did not ask to pace, so a reader that stalls must not grow server memory without bound.
   */
  backpressureBytes: 1024 * 1024,
  /** Re-announce interval told to clients, seconds. */
  announceInterval: 120,
} as const;

export const EVENTS = ["started", "stopped", "completed", "update"] as const;
export type AnnounceEvent = (typeof EVENTS)[number];

export interface Sdp {
  type: string;
  sdp: string;
}

export interface Offer {
  offer: Sdp;
  offerId: string;
}

export interface AnnounceFrame {
  action: "announce";
  infoHash: string;
  peerId: string;
  numwant?: number;
  left?: number;
  event?: AnnounceEvent;
  offers: Offer[];
  answer?: { sdp: Sdp; toPeerId: string; offerId: string };
}

export interface ScrapeFrame {
  action: "scrape";
  /** Empty means "every swarm this socket may see". */
  infoHashes: string[];
}

export type Frame = AnnounceFrame | ScrapeFrame;

export type ParseResult = { ok: true; frame: Frame } | { ok: false; reason: string; infoHash?: string };

/** A 20-character string whose every char code is 0–255. */
export function isBinaryId(v: unknown): v is string {
  if (typeof v !== "string" || v.length !== 20) return false;
  for (let i = 0; i < 20; i++) if (v.charCodeAt(i) > 255) return false;
  return true;
}

/** Lower-case hex of a binary id (40 characters for a valid one). */
export const binaryToHex = (v: string): string => Buffer.from(v, "latin1").toString("hex");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseSdp(v: unknown, type: "offer" | "answer"): Sdp | null {
  if (!isRecord(v) || v.type !== type || typeof v.sdp !== "string") return null;
  if (v.sdp.length === 0 || v.sdp.length > LIMITS.maxSdpLength) return null;
  return { type, sdp: v.sdp };
}

/** Parse and validate one text frame. Never throws. */
export function parseFrame(text: string): ParseResult {
  if (text.length > LIMITS.maxFrameBytes) return { ok: false, reason: "frame too large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  if (!isRecord(raw)) return { ok: false, reason: "invalid frame" };
  if (raw.action === "scrape") return parseScrape(raw);
  if (raw.action === "announce") return parseAnnounce(raw);
  return { ok: false, reason: "invalid action" };
}

function parseScrape(raw: Record<string, unknown>): ParseResult {
  const v = raw.info_hash;
  const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
  if (list.length > LIMITS.maxScrapeHashes) return { ok: false, reason: "too many info_hash values" };
  if (!list.every(isBinaryId)) return { ok: false, reason: "invalid info_hash" };
  return { ok: true, frame: { action: "scrape", infoHashes: [...new Set(list)] } };
}

function parseAnnounce(raw: Record<string, unknown>): ParseResult {
  if (!isBinaryId(raw.info_hash)) return { ok: false, reason: "invalid info_hash" };
  const infoHash = raw.info_hash;
  const fail = (reason: string): ParseResult => ({ ok: false, reason, infoHash });
  if (!isBinaryId(raw.peer_id)) return fail("invalid peer_id");

  const frame: AnnounceFrame = { action: "announce", infoHash, peerId: raw.peer_id, offers: [] };
  if (raw.numwant !== undefined) {
    if (!isCount(raw.numwant) || !Number.isInteger(raw.numwant)) return fail("invalid numwant");
    frame.numwant = raw.numwant;
  }
  for (const k of ["uploaded", "downloaded", "left"] as const)
    if (raw[k] !== undefined && raw[k] !== null && !isCount(raw[k])) return fail(`invalid ${k}`);
  if (isCount(raw.left)) frame.left = raw.left;
  if (raw.event !== undefined && raw.event !== null) {
    if (!(EVENTS as readonly unknown[]).includes(raw.event)) return fail("invalid event");
    frame.event = raw.event as AnnounceEvent;
  }

  if (raw.offers !== undefined) {
    if (!Array.isArray(raw.offers)) return fail("invalid offers");
    if (raw.offers.length > LIMITS.maxOffersPerAnnounce) return fail("too many offers");
    for (const o of raw.offers) {
      if (!isRecord(o) || !isBinaryId(o.offer_id)) return fail("invalid offer_id");
      const sdp = parseSdp(o.offer, "offer");
      if (!sdp) return fail("invalid offer");
      frame.offers.push({ offer: sdp, offerId: o.offer_id });
    }
  }

  if (raw.answer !== undefined) {
    const sdp = parseSdp(raw.answer, "answer");
    if (!sdp) return fail("invalid answer");
    if (!isBinaryId(raw.to_peer_id)) return fail("invalid to_peer_id");
    if (!isBinaryId(raw.offer_id)) return fail("invalid offer_id");
    if (frame.offers.length > 0) return fail("answer with offers");
    frame.answer = { sdp, toPeerId: raw.to_peer_id, offerId: raw.offer_id };
  }
  return { ok: true, frame };
}
