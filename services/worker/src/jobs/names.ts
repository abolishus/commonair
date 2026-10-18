// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Job names and payloads that other services enqueue (the API enqueues the
 * webhook verification, test and redelivery jobs on QUEUES.webhooks).
 * CONTRACT-REQUEST: move WEBHOOK_JOBS and these payload schemas into
 * `@commonair/contracts/internal` next to QUEUES so producers do not import the worker.
 */
import { z } from "zod";

export const WEBHOOK_JOBS = {
  /** Outbox event → matching subscriptions → one `deliver` job each. */
  fanout: "fanout",
  deliver: "deliver",
  /** Enqueued by the API right after a webhook subscription is created. */
  verifyCallback: "verify-callback",
  /** `eventsub.subscriptions.sendTest`. */
  testEvent: "test-event",
  /** `eventsub.subscriptions.redeliver`. */
  redeliver: "redeliver",
} as const;

export const FanoutJob = z.object({ eventId: z.uuid() });
export const DeliverJob = z.object({
  subscriptionId: z.uuid(),
  eventId: z.uuid(),
  attempt: z.number().int().min(1).default(1),
  /** Test events have no outbox row: the synthesized payload travels with the job. */
  sample: z.record(z.string(), z.unknown()).optional(),
});
export const VerifyCallbackJob = z.object({ subscriptionId: z.uuid() });
export const TestEventJob = z.object({ subscriptionId: z.uuid(), eventId: z.uuid().optional() });
export const RedeliverJob = z.object({ deliveryId: z.uuid() });

export type DeliverJob = z.infer<typeof DeliverJob>;
