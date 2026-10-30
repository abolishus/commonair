// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notifications.push.*` (ADR 0028 decisions 1 and 6): browser push subscriptions. Off on the
 * instance, `subscribe` answers PRECONDITION_FAILED `web_push_disabled`; `status` and
 * `unsubscribe` keep working so a browser can still clean up. No audit rows: a member's own device.
 */
import { precondition } from "../../lib/errors.ts";
import { os, requireCaller } from "../../lib/orpc.ts";
import {
  countSubscriptions,
  deleteSubscription,
  endpointHash,
  normalizeKeys,
  sealSubscription,
  upsertSubscription,
  validateEndpoint,
} from "../../notifications/push/subscriptions.ts";

export const push = {
  status: os.notifications.push.status.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const { env, db } = context.deps;
    const enabled = env.WEB_PUSH_ENABLED;
    return {
      enabled,
      vapidPublicKey: enabled ? (env.VAPID_PUBLIC_KEY ?? null) : null,
      subscriptions: await countSubscriptions(db, caller.user.id),
    };
  }),

  subscribe: os.notifications.push.subscribe.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { env, db } = context.deps;
    if (!env.WEB_PUSH_ENABLED) throw precondition("web_push_disabled", "Browser push is off on this instance");
    const endpoint = validateEndpoint(input.endpoint, env.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS);
    const keys = normalizeKeys(input.keys);
    await upsertSubscription(db, {
      userId: caller.user.id,
      hash: await endpointHash(env.AUTH_SECRET, endpoint),
      subscription: await sealSubscription(env.AUTH_SECRET, endpoint, keys),
      now: context.deps.now(),
    });
    return { ok: true as const };
  }),

  unsubscribe: os.notifications.push.unsubscribe.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { env, db } = context.deps;
    await deleteSubscription(db, caller.user.id, await endpointHash(env.AUTH_SECRET, input.endpoint));
    return { ok: true as const };
  }),
};
