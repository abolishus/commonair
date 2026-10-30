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
import { job as chatRetention } from "./chat-retention.ts";
import { job as chatSurgeGuard } from "./chat-surge-guard.ts";
import { job as closeStaleSessions } from "./close-stale-sessions.ts";
import { job as coopCouncilRecompute } from "./coop-council-recompute.ts";
import { job as coopElectionsAdvance } from "./coop-elections-advance.ts";
import { job as coopMembershipSync } from "./coop-membership-sync.ts";
import { job as coopProposalsAdvance } from "./coop-proposals-advance.ts";
import { job as coopStreamHours } from "./coop-stream-hours.ts";
import { job as dmcaDisable } from "./dmca-disable.ts";
import { job as dmcaRestore } from "./dmca-restore.ts";
import { job as expireAuthRows } from "./expire-auth-rows.ts";
import { job as interactTick } from "./interact-tick.ts";
import { job as exportBuild } from "./export-build.ts";
import { job as exportCleanup } from "./export-cleanup.ts";
import { job as legalConsentRetention } from "./legal-consent-retention.ts";
import { job as liveCounters } from "./live-counters.ts";
import { job as oauthExpire } from "./oauth-expire.ts";
import { job as moneyExpirePending } from "./money-expire-pending.ts";
import { job as moneyFraudScan } from "./money-fraud-scan.ts";
import { job as moneyReconcile } from "./money-reconcile.ts";
import { job as moneyReleaseHolds } from "./money-release-holds.ts";
import { job as moneyRenew } from "./money-renew.ts";
import { job as notifyDiscord } from "./notify-discord.ts";
import { job as notifyEmailDigest } from "./notify-email-digest.ts";
import { job as notifyGoLive } from "./notify-go-live.ts";
import { job as notifyPrune } from "./notify-prune.ts";
import { job as notifyPush } from "./notify-push.ts";
import { job as moderationNciiClock } from "./moderation-ncii-clock.ts";
import { job as moderationNciiHash } from "./moderation-ncii-hash.ts";
import { job as moderationScan } from "./moderation-scan.ts";
import { moderationSchedules } from "./moderation-schedules.ts";
import { sorJobs } from "./moderation-sor.ts";
import { job as moderationT0Escalated } from "./moderation-t0-escalated.ts";
import { job as moderationT0Media } from "./moderation-t0-media.ts";
import { job as moderationT0 } from "./moderation-t0.ts";
import { job as pointsAccrue } from "./points-accrue.ts";
import { job as pruneWebhookDeliveries } from "./prune-webhook-deliveries.ts";
import { job as raidsExecute } from "./raids-execute.ts";
import { job as relaysOffline } from "./relays-offline.ts";
import { job as vodPlacement } from "./vod-placement.ts";
import { job as vodRetention } from "./vod-retention.ts";
import { job as webhookDeliver } from "./webhook-deliver.ts";
import { job as webhookFanout } from "./webhook-fanout.ts";
import { job as webhookRedeliver } from "./webhook-redeliver.ts";
import { job as webhookRevocation } from "./webhook-revocation.ts";
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
  vodPlacement,
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
  ...sorJobs,
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
  // Interactivity (E8, ADR 0026).
  interactTick,
  raidsExecute,
  pointsAccrue,
  // Developer platform (E9, ADR 0027).
  webhookRevocation,
  oauthExpire,
  // Feature wins, wave 1 (W1).
  chatRetention,
  chatSurgeGuard,
  moneyFraudScan,
  moneyReconcile,
  // Notifications (N1, ADR 0028).
  notifyGoLive,
  notifyPush,
  notifyEmailDigest,
  notifyDiscord,
  notifyPrune,
] as readonly JobDefinition[];
