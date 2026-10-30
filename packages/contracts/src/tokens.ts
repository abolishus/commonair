// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wire formats for signed tokens and receipts. Crypto lives in @commonair/tokens
 * (TypeScript) and relay/internal/tokens (Go); both are tested against the same
 * vectors in packages/tokens/vectors.json.
 *
 * Playback token: base64url(claims JSON) "." base64url(Ed25519 signature over the
 * claims bytes), signed by the origin key. Carried as `?t=` on every playlist and
 * segment request; refreshed by heartbeats before `exp`.
 *
 * Relay receipt: the relay signs the exact UTF-8 bytes of the payload JSON with its
 * own Ed25519 key; it sends base64url(payload bytes) and base64url(signature).
 */
import { z } from "zod";
import { DELIVERY_SOURCES } from "./enums.ts";

export const PlaybackClaims = z
  .object({
    v: z.literal(1),
    /** Playback session id. */
    sid: z.uuid(),
    /** Channel id and MediaMTX path the token is valid for. */
    cid: z.uuid(),
    /**
     * A MediaMTX path (`live/<…>`) for live playback, **or** `vodTokenPath(vodId)` = `vod/<id>`
     * for a VOD token (`@commonair/contracts/storage`, ADR 0009 amendment 1: `src = "origin"`,
     * same key, lifetime capped by `VOD_TOKEN_MAX_TTL_SECONDS`). No MediaMTX path starts `vod/`,
     * so the live `/hls` route (`services/origin/src/auth.ts`, exact path match) and the relay
     * (`relay/internal/tokens/playback.go` `Binding.Check`, path prefix) refuse a VOD token by
     * path mismatch; no separate token kind, crypto or vector.
     */
    path: z.string(),
    src: z.enum(DELIVERY_SOURCES),
    /** Relay id when src = relay. */
    rid: z.uuid().optional(),
    /**
     * Data mode (ADR 0018): the viewer's bitrate ceiling in bit/s. Only on origin tokens for a live
     * path; the origin keeps variants with BANDWIDTH ≤ dm plus the audio-only variant. Absent = off.
     */
    dm: z.number().int().min(32_000).max(8_000_000).optional(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .refine((c) => (c.src === "relay") === (c.rid !== undefined), "rid is required exactly when src is relay")
  .refine(
    (c) => c.dm === undefined || (c.src === "origin" && !c.path.startsWith("vod/")),
    "dm only on origin tokens for a live path",
  );
export type PlaybackClaims = z.infer<typeof PlaybackClaims>;

export const PLAYBACK_TOKEN_TTL_SECONDS = 120;
export const RECEIPT_INTERVAL_SECONDS = 60;
