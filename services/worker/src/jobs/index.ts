// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every job the worker runs. To add one: create `src/jobs/<name>.ts` exporting
 * `job = defineJob({ queue, name, description, data, schedule?, handler })` and
 * add it to this list.
 */
import { integrityJobs } from "../integrity/jobs.ts";
import type { JobDefinition } from "../runtime/registry.ts";
import { job as closeStaleSessions } from "./close-stale-sessions.ts";
import { job as expireAuthRows } from "./expire-auth-rows.ts";
import { job as liveCounters } from "./live-counters.ts";
import { job as pruneWebhookDeliveries } from "./prune-webhook-deliveries.ts";
import { job as relaysOffline } from "./relays-offline.ts";
import { job as vodRetention } from "./vod-retention.ts";
import { job as webhookDeliver } from "./webhook-deliver.ts";
import { job as webhookFanout } from "./webhook-fanout.ts";
import { job as webhookRedeliver } from "./webhook-redeliver.ts";
import { job as webhookTestEvent } from "./webhook-test-event.ts";
import { job as webhookVerifyCallback } from "./webhook-verify-callback.ts";

export const JOBS = [
  webhookFanout,
  webhookDeliver,
  webhookVerifyCallback,
  webhookTestEvent,
  webhookRedeliver,
  liveCounters,
  closeStaleSessions,
  relaysOffline,
  expireAuthRows,
  pruneWebhookDeliveries,
  vodRetention,
  ...integrityJobs(),
] as readonly JobDefinition[];
