// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { meter } from "@commonair/observability";

/** Instruments are no-ops until the OTLP SDK is registered by initTelemetry. */
const m = meter("commonair.worker");

export const metrics = {
  jobDuration: m.createHistogram("worker.job.duration", { unit: "ms", description: "Job handler duration" }),
  jobFailures: m.createCounter("worker.job.failures", { description: "Jobs whose handler threw" }),
  queueDepth: m.createObservableGauge("worker.queue.depth", { description: "Waiting + delayed jobs per queue" }),
  outboxLag: m.createHistogram("worker.outbox.lag", {
    unit: "ms",
    description: "Time from event occurrence to publication on the bus",
  }),
  outboxPublished: m.createCounter("worker.outbox.published", { description: "Outbox events published" }),
  outboxInvalid: m.createCounter("worker.outbox.invalid", { description: "Outbox events failing catalog validation" }),
  webhookAttempts: m.createCounter("worker.webhook.attempts", {
    description: "Webhook POST attempts by message type and outcome",
  }),
  segmentEntries: m.createCounter("worker.segments.entries", { description: "Segment stream entries processed" }),
};
