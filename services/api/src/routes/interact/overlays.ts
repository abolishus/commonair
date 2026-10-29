// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.overlays.*` (E6, ADR 0021; moved unchanged from `routes/interact.ts`). E8-raids-goals
 * fills `state.goals`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { OVERLAY_EVENTS_PATH } from "@commonair/contracts/events";
import { schema } from "@commonair/db";
import { audit } from "../../events/audit.ts";
import { iso, isoOrNull } from "../../lib/dto.ts";
import { apiError, badRequest, conflict, isUniqueViolation } from "../../lib/errors.ts";
import { os, overlayTokenOf, requireCaller, requireChannel } from "../../lib/orpc.ts";
import { overlayExpiry, overlayTokenLive } from "../../overlay/alerts.ts";
import { loadAlertConfigs } from "../../overlay/configs.ts";
import {
  currentOverlayToken,
  newOverlayToken,
  overlayTokenHash,
  publishOverlayRevoke,
  resolveOverlayToken,
} from "../../overlay/tokens.ts";
import type { Deps } from "../../deps.ts";

const { channels, overlayTokens } = schema;

export const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** The overlay page URLs on the public web origin, for a freshly created token. */
export function overlayUrls(deps: Deps, token: string) {
  const base = trimSlash(deps.site.publicUrl);
  const q = `?token=${encodeURIComponent(token)}`;
  return {
    alertsUrl: `${base}/overlay/alerts${q}`,
    goalsUrl: `${base}/overlay/goals${q}`,
    chatUrl: `${base}/overlay/chat${q}`,
  };
}

export const overlayEventsUrl = (deps: Deps, token: string) =>
  `${trimSlash(deps.env.API_PUBLIC_URL)}${OVERLAY_EVENTS_PATH}?token=${encodeURIComponent(token)}`;

export const overlays = {
  token: os.interact.overlays.token.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const channel = requireChannel(context);
    const now = deps.now();
    const expiry = overlayExpiry(input.expiresAt, now);
    if (!expiry.ok) throw badRequest(expiry.reason);
    const token = newOverlayToken();
    const tokenHash = await overlayTokenHash(token);
    let revokedOld = false;
    try {
      await deps.db.transaction(async (tx) => {
        // Serialize rotations of one channel; the partial unique index is the backstop.
        await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channel.id)).for("update");
        const old = await tx
          .update(overlayTokens)
          .set({ revokedAt: now })
          .where(and(eq(overlayTokens.channelId, channel.id), isNull(overlayTokens.revokedAt)))
          .returning({ id: overlayTokens.id });
        revokedOld = old.length > 0;
        const [row] = await tx
          .insert(overlayTokens)
          .values({ channelId: channel.id, tokenHash, expiresAt: expiry.expiresAt })
          .returning({ id: overlayTokens.id });
        if (!row) throw new Error("overlay token insert returned no row");
        await audit(tx, {
          actorType: "user",
          actorId: caller.user.id,
          action: "overlay.token.create",
          subjectType: "overlay_token",
          subjectId: row.id,
          channelId: channel.id,
          details: { expires: expiry.expiresAt !== null },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("Another overlay token was created at the same time");
      throw err;
    }
    if (revokedOld) await publishOverlayRevoke(deps, channel.id);
    return { token, ...overlayUrls(deps, token), expiresAt: isoOrNull(expiry.expiresAt) };
  }),

  status: os.interact.overlays.status.handler(async ({ context }) => {
    const { deps } = context;
    const channel = requireChannel(context);
    const row = await currentOverlayToken(deps.db, channel.id);
    if (!row || !overlayTokenLive(row, deps.now())) return { active: false, createdAt: null, expiresAt: null };
    return { active: true, createdAt: iso(row.createdAt), expiresAt: isoOrNull(row.expiresAt) };
  }),

  revoke: os.interact.overlays.revoke.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const channel = requireChannel(context);
    const revoked = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(overlayTokens)
        .set({ revokedAt: deps.now() })
        .where(and(eq(overlayTokens.channelId, channel.id), isNull(overlayTokens.revokedAt)))
        .returning({ id: overlayTokens.id });
      for (const r of rows)
        await audit(tx, {
          actorType: "user",
          actorId: caller.user.id,
          action: "overlay.token.revoke",
          subjectType: "overlay_token",
          subjectId: r.id,
          channelId: channel.id,
        });
      return rows.length;
    });
    // Revoking with no token is a no-op success: the outcome the caller wants already holds.
    if (revoked > 0) await publishOverlayRevoke(deps, channel.id);
    return { ok: true as const };
  }),

  state: os.interact.overlays.state.handler(async ({ context }) => {
    const { deps } = context;
    // The middleware resolved the token; resolve again here so the URL carries the same value.
    const token = overlayTokenOf(context.req);
    const resolved = token ? await resolveOverlayToken(deps.db, token, deps.now()) : null;
    if (!token || !resolved || resolved.channelId !== context.overlayChannelId)
      throw apiError("UNAUTHORIZED", "A valid overlay token is required");
    const [channel] = await deps.db
      .select({ slug: channels.slug })
      .from(channels)
      .where(eq(channels.id, resolved.channelId))
      .limit(1);
    if (!channel) throw apiError("UNAUTHORIZED", "A valid overlay token is required");
    return {
      channelSlug: channel.slug,
      alerts: await loadAlertConfigs(deps.db, resolved.channelId),
      goals: [],
      eventsUrl: overlayEventsUrl(deps, token),
    };
  }),
};
