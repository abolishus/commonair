// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.alerts.*` (E6, ADR 0021; moved unchanged from `routes/interact.ts`). */
import { dto } from "@commonair/contracts";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { audit } from "../../events/audit.ts";
import { badRequest, rateLimited } from "../../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";
import { rateLimitKey } from "../../lib/ratelimit.ts";
import { renderAlert, sampleSource, type AlertConfig } from "../../overlay/alerts.ts";
import { loadAlertConfigs } from "../../overlay/configs.ts";
import { overlayHub } from "../../overlay/stream.ts";

const { alertConfigs } = schema;

export const alerts = {
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
};
