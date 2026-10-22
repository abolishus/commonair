// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.*`. E6 builds alerts and the overlay (docs/testing/e6-selectors.md "Overlays and
 * alerts", ADR 0021); polls, predictions, raids and goals stay 501.
 */
import { and, eq, isNull } from "drizzle-orm";
import { dto } from "@commonair/contracts";
import { BUS, OVERLAY_EVENTS_PATH } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { audit } from "../events/audit.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { apiError, badRequest, conflict, isUniqueViolation, notImplemented, rateLimited } from "../lib/errors.ts";
import { os, overlayTokenOf, requireCaller, requireChannel } from "../lib/orpc.ts";
import { rateLimitKey } from "../lib/ratelimit.ts";
import { overlayExpiry, overlayTokenLive, renderAlert, sampleSource, type AlertConfig } from "../overlay/alerts.ts";
import { loadAlertConfigs } from "../overlay/configs.ts";
import { overlayHub } from "../overlay/stream.ts";
import {
  currentOverlayToken,
  newOverlayToken,
  overlayTokenHash,
  publishOverlayRevoke,
  resolveOverlayToken,
} from "../overlay/tokens.ts";
import type { Deps } from "../deps.ts";

const { alertConfigs, channels, overlayTokens } = schema;

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** The overlay page URLs on the public web origin, for a freshly created token. */
function overlayUrls(deps: Deps, token: string) {
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

export const interact = {
  polls: {
    current: os.interact.polls.current.handler(notImplemented),
    create: os.interact.polls.create.handler(notImplemented),
    vote: os.interact.polls.vote.handler(notImplemented),
    end: os.interact.polls.end.handler(notImplemented),
  },
  predictions: {
    current: os.interact.predictions.current.handler(notImplemented),
    create: os.interact.predictions.create.handler(notImplemented),
    bet: os.interact.predictions.bet.handler(notImplemented),
    lock: os.interact.predictions.lock.handler(notImplemented),
    resolve: os.interact.predictions.resolve.handler(notImplemented),
    cancel: os.interact.predictions.cancel.handler(notImplemented),
  },
  raids: {
    start: os.interact.raids.start.handler(notImplemented),
    cancel: os.interact.raids.cancel.handler(notImplemented),
  },
  alerts: {
    list: os.interact.alerts.list.handler(async ({ context }) => {
      const channel = requireChannel(context);
      return loadAlertConfigs(context.deps.db, channel.id);
    }),

    set: os.interact.alerts.set.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const channel = requireChannel(context);
      // E6 renders text and animation only; alert media needs uploads first (ADR 0021).
      if (input.template.imageKey !== undefined || input.template.soundKey !== undefined)
        throw badRequest("Alert images and sounds are not supported yet");
      const template = {
        message: input.template.message,
        animation: input.template.animation,
        showMessage: input.template.showMessage,
      };
      const config: AlertConfig = {
        type: input.type,
        enabled: input.enabled,
        template,
        minAmountCents: input.minAmountCents,
        durationMs: input.durationMs,
      };
      await deps.db.transaction(async (tx) => {
        const values = {
          enabled: config.enabled,
          template,
          minAmountCents: config.minAmountCents,
          durationMs: config.durationMs,
          updatedAt: deps.now(),
        };
        await tx
          .insert(alertConfigs)
          .values({ channelId: channel.id, type: config.type, ...values })
          .onConflictDoUpdate({ target: [alertConfigs.channelId, alertConfigs.type], set: values });
        await audit(tx, {
          actorType: "user",
          actorId: caller.user.id,
          action: "alert.update",
          subjectType: "channel",
          subjectId: channel.id,
          channelId: channel.id,
          details: { type: config.type, enabled: config.enabled },
        });
      });
      overlayHub(deps).invalidateConfigs(channel.id);
      return config;
    }),

    test: os.interact.alerts.test.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const channel = requireChannel(context);
      // A write that reaches every open overlay: the write bucket on top of the default one.
      const nowMs = deps.now().getTime();
      const rl = await deps.rateLimitStore.hit(
        rateLimitKey("write", `u:${caller.user.id}`),
        deps.rateLimits.write,
        nowMs,
        `${nowMs}:${crypto.randomUUID()}`,
      );
      if (!rl.allowed) throw rateLimited(rl.retryAfterSeconds);
      const configs = await loadAlertConfigs(deps.db, channel.id);
      const config = configs.find((c) => c.type === input.type);
      if (!config) throw new Error(`no alert config for ${input.type}`);
      const alert = dto.OverlayAlert.parse(
        renderAlert(config, sampleSource(input.type, uuidv7(), deps.now(), deps.env.CURRENCY)),
      );
      await deps.valkey.publish(BUS.overlay(channel.id), JSON.stringify(alert));
      return { ok: true as const };
    }),
  },
  goals: {
    list: os.interact.goals.list.handler(notImplemented),
    create: os.interact.goals.create.handler(notImplemented),
    end: os.interact.goals.end.handler(notImplemented),
  },
  overlays: {
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
  },
};
