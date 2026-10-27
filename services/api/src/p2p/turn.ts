// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ICE servers for P2P playback (ADR 0005 amendment 1, decision 2): the instance's own coturn,
 * STUN always, the TURN relay only when the operator configured `P2P_TURN_URLS`.
 *
 * TURN credentials follow the TURN REST scheme coturn checks with `use-auth-secret`:
 *
 *   username   = "<expiry, epoch seconds>:<opaque id>"
 *   credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))
 *
 * coturn can log usernames, so the opaque id is never the session id. It is
 *
 *   subkey = HMAC-SHA256(TURN_SHARED_SECRET, TURN_ID_LABEL)
 *   id     = base64url(HMAC-SHA256(subkey, sessionId)[0 .. TURN_ID_BYTES))
 *
 * with the label `commonair/turn-id/v1` and 16 bytes (22 base64url characters, 128 bits): stable
 * per session, so per-user quotas and a debugging operator can tell sessions apart, unlinkable to
 * the session id without the secret, and a separate subkey so the id is no HMAC the credential
 * scheme itself could ever produce. Changing either constant changes every id; bump the label's
 * version if it ever must.
 */
import { createHmac } from "node:crypto";

export const TURN_ID_LABEL = "commonair/turn-id/v1";
export const TURN_ID_BYTES = 16;

export interface IceConfig {
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  /** Required when `turnUrls` is non-empty (the env refinement already refuses to start without). */
  secret?: string | undefined;
  ttlSeconds: number;
}

export interface IceServerEntry {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceAnswer {
  iceServers: IceServerEntry[];
  /** When the TURN credentials stop working; null without TURN (nothing expires). */
  expiresAt: Date | null;
}

/** The relay is configured but cannot mint credentials coturn would accept. */
export class TurnNotConfigured extends Error {
  constructor() {
    super("P2P_TURN_URLS is set without TURN_SHARED_SECRET");
    this.name = "TurnNotConfigured";
  }
}

/** The opaque, per-session part of a TURN username (see the header). */
export function turnOpaqueId(secret: string, sessionId: string): string {
  const subkey = createHmac("sha256", secret).update(TURN_ID_LABEL).digest();
  return createHmac("sha256", subkey).update(sessionId).digest().subarray(0, TURN_ID_BYTES).toString("base64url");
}

/** coturn's `use-auth-secret` password for a username. */
export function turnPassword(secret: string, username: string): string {
  return createHmac("sha1", secret).update(username).digest("base64");
}

/** Username and password valid until `now + ttlSeconds` (whole seconds, as coturn compares). */
export function turnCredentials(secret: string, sessionId: string, ttlSeconds: number, now: Date) {
  const expiry = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const username = `${expiry}:${turnOpaqueId(secret, sessionId)}`;
  return { username, credential: turnPassword(secret, username), expiresAt: new Date(expiry * 1000) };
}

/**
 * The answer for one granted session: one STUN entry without credentials, and one TURN entry with
 * fresh credentials only when the relay is configured. Both empty: no servers at all.
 */
export function iceServersFor(config: IceConfig, sessionId: string, now: Date): IceAnswer {
  const iceServers: IceServerEntry[] = [];
  if (config.stunUrls.length > 0) iceServers.push({ urls: [...config.stunUrls] });
  if (config.turnUrls.length === 0) return { iceServers, expiresAt: null };
  if (!config.secret) throw new TurnNotConfigured();
  const { username, credential, expiresAt } = turnCredentials(config.secret, sessionId, config.ttlSeconds, now);
  iceServers.push({ urls: [...config.turnUrls], username, credential });
  return { iceServers, expiresAt };
}
