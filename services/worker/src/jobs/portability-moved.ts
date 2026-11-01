// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** On channel.moved: email each grant holder once, then drop the grants. Owned by W3-portability; a no-op stub until it lands (batch 7 contract step §5.1). */
import { PORTABILITY_JOBS, PortabilityMovedJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: PORTABILITY_JOBS.moved,
  description: "On channel.moved: email each grant holder once, then drop the grants",
  data: PortabilityMovedJob,
  handler: stubHandler(PORTABILITY_JOBS.moved),
});
