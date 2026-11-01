// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Turn one outbox event into deliveries to the channel's followers. Owned by N4-delivery; a no-op stub until it lands (batch 7 contract step §5.1). */
import { FEDERATION_JOBS, FederationFanoutJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.fanout,
  description: "Turn one outbox event into deliveries to the channel's followers",
  data: FederationFanoutJob,
  handler: stubHandler(FEDERATION_JOBS.fanout),
});
