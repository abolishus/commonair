// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notifications.unsubscribe` (ADR 0028 decision 4): the web confirm page's action, for anyone
 * holding the link (no session; the `write` bucket limits it per address). Mail clients use the
 * one-click route (`notifications/email-unsubscribe.ts`); both apply the same rows.
 */
import { badRequest } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";
import { applyUnsubscribe } from "../../notifications/unsubscribe/apply.ts";

export const unsubscribe = os.notifications.unsubscribe.handler(async ({ context, input }) => {
  const { deps } = context;
  const userId = await applyUnsubscribe(deps.db, deps.env.AUTH_SECRET, input.list, input.token);
  if (userId === null) throw badRequest("This unsubscribe link is not valid");
  deps.logger.info("email unsubscribe applied", { userId, list: input.list, via: "page" });
  return { list: input.list };
});
