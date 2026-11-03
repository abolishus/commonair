// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Webhook job names and payloads now live in the shared contract; re-exported for existing imports. */
export {
  DeliverJob,
  FanoutJob,
  RedeliverJob,
  RevocationJob,
  TestEventJob,
  VerifyCallbackJob,
  WEBHOOK_JOBS,
} from "@commonair/contracts/internal";

/** Batch 8 job names (contract step §3.6); the API enqueues the on-demand ones, so they live in the contract. */
export { B8_JOBS, type B8JobName } from "@commonair/contracts/internal";

/** The follower cleanup (decision (h), `b7/outbox-jobs.ts`) is `FEDERATION_JOBS.followerCleanup`. */
export { FederationFollowerCleanupJob } from "@commonair/contracts/internal";
