// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P2P playback (ADR 0005 amendment 1): ICE servers for sessions that hold a P2P grant. Refusals
 * as `playback.heartbeat`: a bad token, an unknown session, an ended one; and no grant, no ICE
 * servers. Minting writes nothing, so there is no outbox or audit row.
 */
import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { iso } from "../lib/dto.ts";
import { apiError, conflict, notFound, precondition } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { iceServersFor, TurnNotConfigured } from "../p2p/turn.ts";

const { playbackSessions } = schema;

export const p2p = {
  iceServers: os.p2p.iceServers.handler(async ({ context, input }) => {
    const { deps } = context;
    const now = deps.now();
    // The same check as playback.heartbeat: a valid playback token for exactly this session.
    const r = await verifyPlaybackToken(deps.signingKey.publicKey, input.token, Math.floor(now.getTime() / 1000));
    if (!r.ok || r.value.sid !== input.sessionId) throw apiError("UNAUTHORIZED", "Invalid playback token");
    const [s] = await deps.db
      .select({ endedAt: playbackSessions.endedAt })
      .from(playbackSessions)
      .where(eq(playbackSessions.id, input.sessionId));
    if (!s) throw notFound("Playback session not found");
    if (s.endedAt) throw conflict("This playback session has ended");
    if ((await deps.valkey.exists(KEYS.p2pGrant(input.sessionId))) !== 1)
      throw precondition("p2p", "Peer-to-peer delivery is not enabled for this session");
    try {
      const answer = iceServersFor(
        {
          stunUrls: deps.env.P2P_STUN_URLS,
          turnUrls: deps.env.P2P_TURN_URLS,
          secret: deps.env.TURN_SHARED_SECRET,
          ttlSeconds: deps.env.TURN_CREDENTIAL_TTL_SECONDS,
        },
        input.sessionId,
        now,
      );
      return { iceServers: answer.iceServers, expiresAt: answer.expiresAt ? iso(answer.expiresAt) : null };
    } catch (err) {
      if (!(err instanceof TurnNotConfigured)) throw err;
      // Fail closed. turnEnv refuses to start like this; only hand-built deps get here.
      deps.logger.warn("p2p.iceServers: TURN relay configured without a shared secret");
      throw new ORPCError("INTERNAL_SERVER_ERROR", { status: 500, message: "ICE servers are unavailable" });
    }
  }),
};
