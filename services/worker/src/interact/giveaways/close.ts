// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Close a giveaway at its closes_at. Owned by W3-giveaways; a no-op stub until it lands (batch 7 contract step §5.1). */
import { GIVEAWAY_JOBS, GiveawayCloseJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../../b7/stub.ts";
import { defineJob } from "../../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: GIVEAWAY_JOBS.close,
  description: "Close a giveaway at its closes_at",
  data: GiveawayCloseJob,
  handler: stubHandler(GIVEAWAY_JOBS.close),
});
