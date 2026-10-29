// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Delivery-time authorization of a webhook subscription. The API checks the
 * same rules at subscribe time; the worker re-checks on every delivery because
 * tokens are revoked and moderators removed after a subscription exists. The
 * rules live in `@commonair/contracts/eventsub` (pure) and `@commonair/db` (queries).
 */
import type { EventType } from "@commonair/contracts/events";
import { authorizeSubscription, type AuthorizationResult } from "@commonair/db";
import type { WorkerContext } from "../context.ts";
import type { SubscriptionRow } from "./messages.ts";

export { bindingFor, broadcasterOf, conditionComplete, type Binding } from "@commonair/contracts/eventsub";
export type { AuthorizationResult } from "@commonair/db";

export const authorize = (ctx: WorkerContext, sub: SubscriptionRow, type: EventType): Promise<AuthorizationResult> =>
  authorizeSubscription(ctx.db, sub, type, ctx.now());
