// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every job the worker runs. To add one: create `src/jobs/<name>.ts` exporting
 * `job = defineJob({ queue, name, description, data, schedule?, handler })` and
 * add it to this list.
 */
import { integrityJobs } from "../integrity/jobs.ts";
import type { JobDefinition } from "../runtime/registry.ts";
import { job as accountDeletion } from "./account-deletion.ts";
import { job as closeStaleSessions } from "./close-stale-sessions.ts";
import { job as coopCouncilRecompute } from "./coop-council-recompute.ts";
import { job as coopElectionsAdvance } from "./coop-elections-advance.ts";
import { job as coopMembershipSync } from "./coop-membership-sync.ts";
import { job as coopProposalsAdvance } from "./coop-proposals-advance.ts";
import { job as coopStreamHours } from "./coop-stream-hours.ts";
import { job as dmcaDisable } from "./dmca-disable.ts";
import { job as dmcaRestore } from "./dmca-restore.ts";
import { job as expireAuthRows } from "./expire-auth-rows.ts";
import { job as exportBuild } from "./export-build.ts";
import { job as exportCleanup } from "./export-cleanup.ts";
import { job as legalConsentRetention } from "./legal-consent-retention.ts";
import { job as liveCounters } from "./live-counters.ts";
import { job as moneyExpirePending } from "./money-expire-pending.ts";
import { job as moneyReleaseHolds } from "./money-release-holds.ts";
import { job as moneyRenew } from "./money-renew.ts";
import { job as moderationNciiClock } from "./moderation-ncii-clock.ts";
import { job as moderationNciiHash } from "./moderation-ncii-hash.ts";
import { job as moderationScan } from "./moderation-scan.ts";
import { moderationSchedules } from "./moderation-schedules.ts";
import { job as moderationT0Escalated } from "./moderation-t0-escalated.ts";
import { job as moderationT0Media } from "./moderation-t0-media.ts";
import { job as moderationT0 } from "./moderation-t0.ts";
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
  moneyExpirePending,
  moneyRenew,
  moneyReleaseHolds,
  moderationScan,
  moderationT0,
  moderationT0Media,
  moderationT0Escalated,
  moderationNciiClock,
  moderationNciiHash,
  ...moderationSchedules,
  accountDeletion,
  coopMembershipSync,
  coopProposalsAdvance,
  coopCouncilRecompute,
  coopElectionsAdvance,
  coopStreamHours,
  exportBuild,
  exportCleanup,
  dmcaDisable,
  dmcaRestore,
  legalConsentRetention,
] as readonly JobDefinition[];
