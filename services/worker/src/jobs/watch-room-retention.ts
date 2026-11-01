// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Daily: delete watch rooms ended over 30 days ago and end rooms empty for 10 minutes (ADR 0017 decision 1). */
import { WATCH_ROOM_JOBS, WatchRoomRetentionJob, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { runRetention } from "../watch-rooms/retention.ts";

export const job = defineJob({
  queue: QUEUES.watchRooms,
  name: WATCH_ROOM_JOBS.retention,
  description: "Daily: delete watch rooms ended over 30 days ago and end rooms empty for 10 minutes",
  data: WatchRoomRetentionJob,
  schedule: { pattern: "29 3 * * *" },
  handler: async (_data, ctx) => runRetention(ctx),
});
