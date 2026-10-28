// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ICE servers for a P2P session come only from `p2p.iceServers` (ADR 0005 amendment 1,
 * decision 2): the instance's own STUN, and TURN with time-limited credentials when the operator
 * turned the relay on. Any refusal or network error means no P2P for the session.
 */
import type { Api } from "../../lib/api.ts";

export interface IceAnswer {
  iceServers: RTCIceServer[];
  /** Epoch ms when TURN credentials expire; null when nothing expires (STUN only). */
  expiresAt: number | null;
}

type IceClient = Pick<Api["p2p"], "iceServers">;

/** Fetch the session's ICE servers; null on any refusal or error (the caller stays on HTTP). */
export async function fetchIceServers(
  client: { p2p: IceClient },
  session: { sessionId: string; token: string },
): Promise<IceAnswer | null> {
  try {
    const res = await client.p2p.iceServers(session);
    const expires = res.expiresAt === null ? null : Date.parse(res.expiresAt);
    return {
      // Copy only the fields RTCPeerConnection knows; never pass undefined credentials along.
      iceServers: res.iceServers.map((s) => ({
        urls: [...s.urls],
        ...(s.username === undefined ? {} : { username: s.username }),
        ...(s.credential === undefined ? {} : { credential: s.credential }),
      })),
      expiresAt: expires !== null && Number.isFinite(expires) ? expires : null,
    };
  } catch {
    return null;
  }
}

/** Refresh credentials at about 80 % of their remaining lifetime (at least 5 s from now). */
export function iceRefreshDelay(expiresAt: number | null, now: number = Date.now()): number | null {
  if (expiresAt === null) return null;
  const ttl = expiresAt - now;
  return Math.max(5_000, Math.floor(ttl * 0.8));
}
