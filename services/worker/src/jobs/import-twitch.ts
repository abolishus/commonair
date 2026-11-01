// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fetch a channel from Twitch, build a twitch bundle and apply it. Owned by N3-import; a no-op stub until it lands (batch 7 contract step §5.1). */
import { TWITCH_JOBS, TwitchImportJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: TWITCH_JOBS.import,
  description: "Fetch a channel from Twitch, build a twitch bundle and apply it",
  data: TwitchImportJob,
  handler: stubHandler(TWITCH_JOBS.import),
});
