// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

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

/**
 * Removes the remote followers of a channel that turned federation off, once their actor `Delete`
 * is queued (decision (h), `b7/outbox-jobs.ts`). Worker-local until the contract carries it.
 */
export const FEDERATION_FOLLOWER_CLEANUP = "federation-follower-cleanup";
/** The channel, and the instant its federation went off: followers who arrived later are kept. */
export const FederationFollowerCleanupJob = z.object({ channelId: z.uuid(), upTo: z.iso.datetime({ offset: true }) });
export type FederationFollowerCleanupJob = z.infer<typeof FederationFollowerCleanupJob>;
