// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notifications.preferences.*` (ADR 0028 decision 4; overhaul wave 4, D7.3): a default per
 * preference type and medium, and go-live channel overrides. Only the media `PREFERENCE_MEDIA`
 * offers for a type can be set; anything else is BAD_REQUEST.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { channelBySlug } from "../../lib/dto.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import { os, requireCaller } from "../../lib/orpc.ts";
import { recordDigestConsent } from "../../notifications/preferences/consent.ts";
import { mediumOffered } from "../../notifications/preferences/offered.ts";
import { deleteOverride, loadPreferences, upsertPreference } from "../../notifications/preferences/store.ts";

const { follows } = schema;

export const preferences = {
  get: os.notifications.preferences.get.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    return loadPreferences(context.deps.db, caller.user.id, input.type);
  }),

  set: os.notifications.preferences.set.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const userId = caller.user.id;
    if (!mediumOffered(input.type, input.medium)) throw badRequest("This notification is not offered by that medium");
    if (input.channel === null) {
      if (input.enabled === null) throw badRequest("A default cannot be removed; set it on or off");
      const enabled = input.enabled;
      await deps.db.transaction(async (tx) => {
        const now = deps.now();
        await upsertPreference(tx, { userId, type: input.type, medium: input.medium, channelId: null }, enabled, now);
        // The weekly digest is opt-in mail: every opt-in and opt-out is kept as a consent record.
        if (input.type === "digest_weekly") await recordDigestConsent(tx, userId, enabled, "settings", now);
      });
      return loadPreferences(deps.db, userId, input.type);
    }
    // Only go-live alerts are per channel; the other types are one choice per member.
    if (input.type !== "go_live") throw badRequest("Only go-live notifications can be set per channel");
    const channel = await channelBySlug(deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    const [follow] = await deps.db
      .select({ channelId: follows.channelId })
      .from(follows)
      .where(and(eq(follows.followerId, userId), eq(follows.channelId, channel.id)))
      .limit(1);
    if (!follow) throw badRequest("Follow the channel to set its notifications");
    const key = { userId, type: input.type, medium: input.medium, channelId: channel.id };
    if (input.enabled === null) await deleteOverride(deps.db, key);
    else await upsertPreference(deps.db, key, input.enabled, deps.now());
    return loadPreferences(deps.db, userId, input.type);
  }),
};
