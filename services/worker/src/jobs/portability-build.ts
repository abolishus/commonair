// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Build a portability bundle export. Owned by W3-portability; a no-op stub until it lands (batch 7 contract step §5.1). */
import { PORTABILITY_JOBS, PortabilityBuildJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: PORTABILITY_JOBS.build,
  description: "Build a portability bundle export",
  data: PortabilityBuildJob,
  handler: stubHandler(PORTABILITY_JOBS.build),
});
