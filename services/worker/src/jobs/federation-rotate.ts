// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Daily: rotate actor keys older than the rotation age. Owned by N4-delivery; a no-op stub until it lands (batch 7 contract step §5.1). */
import { FEDERATION_JOBS, FederationRotateJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.rotate,
  description: "Daily: rotate actor keys older than the rotation age",
  data: FederationRotateJob,
  schedule: { pattern: "37 4 * * *" },
  handler: stubHandler(FEDERATION_JOBS.rotate),
});
