// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Process one ActivityPub inbox item. Owned by N4-delivery; a no-op stub until it lands (batch 7 contract step §5.1). */
import { FEDERATION_JOBS, FederationInboxJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.inbox,
  description: "Process one ActivityPub inbox item",
  data: FederationInboxJob,
  handler: stubHandler(FEDERATION_JOBS.inbox),
});
