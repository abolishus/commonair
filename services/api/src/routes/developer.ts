// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.*`: token validation now; apps, tokens and EventSub come with the developer-platform unit. */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { bearerToken, resolveToken } from "../lib/caller.ts";
import { apiError, notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const developer = {
  apps: {
    list: os.developer.apps.list.handler(notImplemented),
    create: os.developer.apps.create.handler(notImplemented),
    update: os.developer.apps.update.handler(notImplemented),
    rotateSecret: os.developer.apps.rotateSecret.handler(notImplemented),
    remove: os.developer.apps.remove.handler(notImplemented),
  },
  tokens: {
    list: os.developer.tokens.list.handler(notImplemented),
    revoke: os.developer.tokens.revoke.handler(notImplemented),
    /** Twitch's GET /oauth2/validate shape, so existing bot libraries work unchanged. */
    validate: os.developer.tokens.validate.handler(async ({ context: { deps, req } }) => {
      const raw = bearerToken(req.headers);
      const caller = raw ? await resolveToken(deps, raw) : null;
      if (!caller || caller.kind !== "token") throw apiError("UNAUTHORIZED", "Invalid or expired access token");
      let clientId: string | null = null;
      if (caller.appId) {
        const [app] = await deps.db
          .select({ clientId: schema.oauthApps.clientId })
          .from(schema.oauthApps)
          .where(eq(schema.oauthApps.id, caller.appId));
        clientId = app?.clientId ?? null;
      }
      return {
        client_id: clientId,
        login: caller.user.username,
        user_id: caller.user.id,
        scopes: caller.scopes,
        expires_in: Math.max(0, Math.floor((caller.expiresAt.getTime() - deps.now().getTime()) / 1000)),
      };
    }),
  },
  events: {
    catalog: os.developer.events.catalog.handler(notImplemented),
    subscribe: os.developer.events.subscribe.handler(notImplemented),
    list: os.developer.events.list.handler(notImplemented),
    unsubscribe: os.developer.events.unsubscribe.handler(notImplemented),
    deliveries: os.developer.events.deliveries.handler(notImplemented),
    sendTest: os.developer.events.sendTest.handler(notImplemented),
    redeliver: os.developer.events.redeliver.handler(notImplemented),
  },
};
