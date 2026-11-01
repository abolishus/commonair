// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sign and POST one activity to one remote inbox. Owned by N4-delivery; a no-op stub until it lands (batch 7 contract step §5.1). */
import { FEDERATION_JOBS, FederationDeliverJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.deliver,
  description: "Sign and POST one activity to one remote inbox",
  data: FederationDeliverJob,
  handler: stubHandler(FEDERATION_JOBS.deliver),
});
