// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.push.*` (ADR 0028 decisions 1 and 6): browser push subscriptions. HTTP 501 until N1-push implements them. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const push = {
  status: os.notifications.push.status.handler(notImplemented),
  subscribe: os.notifications.push.subscribe.handler(notImplemented),
  unsubscribe: os.notifications.push.unsubscribe.handler(notImplemented),
};
