// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer.events.*` (E9-subs): the EventSub catalog, subscriptions and the webhook delivery log
 * (ADR 0027 §3). Every procedure but `catalog` admits a session, a user access token or an app
 * access token; what each may see and create is decided in `developer/subscriptions/`:
 *
 * - **App of the subscription**: a user token's app (null for personal and bot tokens), an app
 *   token's app, or for a session `input.appId` (an app it owns and that is not suspended) or null.
 *   A token caller passing `appId` is refused.
 * - **Backing user**: scope-less types are backed by the user caller, or by the app's owner when
 *   an app subscribes. Scoped types are backed by the user caller (their authorization must cover
 *   the type and the condition must name them), or for an app by the broadcaster the condition
 *   names, who must have authorized the app for the scopes. A session without an app cannot create
 *   a scoped subscription (`token_required`).
 * - **Transport**: no webhook for WebSocket-only types (`websocket_only`); WebSocket needs a user
 *   token and binds the session to that authorization first.
 * - **Visibility**: a session sees its apps' subscriptions and its own personal ones; a user token
 *   its app's subscriptions backed by its user; an app token every subscription of its app.
 */
import { os, requireActor } from "../../lib/orpc.ts";
import {
  CATALOG,
  listDeliveries,
  listSubscriptions,
  redeliver,
  sendTest,
  subscribe,
  unsubscribe,
} from "../../developer/subscriptions/index.ts";

export const events = {
  catalog: os.developer.events.catalog.handler(() => CATALOG),
  subscribe: os.developer.events.subscribe.handler(({ context, input }) =>
    subscribe(context.deps, requireActor(context), input),
  ),
  list: os.developer.events.list.handler(({ context, input }) =>
    listSubscriptions(context.deps, requireActor(context), input),
  ),
  unsubscribe: os.developer.events.unsubscribe.handler(({ context, input }) =>
    unsubscribe(context.deps, requireActor(context), input.id),
  ),
  deliveries: os.developer.events.deliveries.handler(({ context, input }) =>
    listDeliveries(context.deps, requireActor(context), input),
  ),
  sendTest: os.developer.events.sendTest.handler(({ context, input }) =>
    sendTest(context.deps, requireActor(context), input.id),
  ),
  redeliver: os.developer.events.redeliver.handler(({ context, input }) =>
    redeliver(context.deps, requireActor(context), input.id),
  ),
};
