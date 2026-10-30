// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notifications.discord.*` (ADR 0028 decision 5): a channel's Discord webhook, set by its owner
 * or an editor. The URL is write-only: sealed on `set`, never in a response, log or audit row. The
 * contract only accepts Discord webhook URLs; the worker re-checks before every post.
 */
import { audit } from "../../events/audit.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";
import {
  deleteWebhook,
  sealWebhookUrl,
  testMinute,
  upsertWebhook,
  webhookStatus,
} from "../../notifications/discord/webhook.ts";
import { notifyQueue } from "../../notifications/queue.ts";

type Action = "set" | "remove" | "test";

/** A channel setting change by its owner or editor; `details` names the action only. */
const auditRow = (actorId: string, channelId: string, action: Action) => ({
  actorType: "user" as const,
  actorId,
  action: `discord_webhook.${action}`,
  subjectType: "channel",
  subjectId: channelId,
  channelId,
  details: { action },
});

export const discord = {
  get: os.notifications.discord.get.handler(async ({ context }) => {
    const c = requireChannel(context);
    return webhookStatus(context.deps.db, c.id);
  }),

  set: os.notifications.discord.set.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const c = requireChannel(context);
    const { deps } = context;
    const sealedUrl = await sealWebhookUrl(deps.env.AUTH_SECRET, input.url);
    return deps.db.transaction(async (tx) => {
      const status = await upsertWebhook(tx, { channelId: c.id, sealedUrl, setBy: caller.user.id, now: deps.now() });
      await audit(tx, auditRow(caller.user.id, c.id, "set"));
      return status;
    });
  }),

  remove: os.notifications.discord.remove.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const c = requireChannel(context);
    await context.deps.db.transaction(async (tx) => {
      // Removing nothing is still "removed": the studio's state is the same either way.
      if (await deleteWebhook(tx, c.id)) await audit(tx, auditRow(caller.user.id, c.id, "remove"));
    });
    return { ok: true as const };
  }),

  test: os.notifications.discord.test.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const c = requireChannel(context);
    const { deps } = context;
    const status = await webhookStatus(deps.db, c.id);
    // No webhook: nothing to post to. The status says so; no job, no audit row.
    if (!status.configured) return status;
    // One post per channel and minute (the job id); the result shows on the next `get`.
    await notifyQueue(deps).enqueueDiscordTest(c.id, testMinute(deps.now()));
    await audit(deps.db, auditRow(caller.user.id, c.id, "test"));
    return status;
  }),
};
