// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.events.*` (E9-subs): the EventSub catalog, subscriptions and the webhook delivery log (ADR 0027 §3). */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const events = {
  catalog: os.developer.events.catalog.handler(notImplemented),
  subscribe: os.developer.events.subscribe.handler(notImplemented),
  list: os.developer.events.list.handler(notImplemented),
  unsubscribe: os.developer.events.unsubscribe.handler(notImplemented),
  deliveries: os.developer.events.deliveries.handler(notImplemented),
  sendTest: os.developer.events.sendTest.handler(notImplemented),
  redeliver: os.developer.events.redeliver.handler(notImplemented),
};
