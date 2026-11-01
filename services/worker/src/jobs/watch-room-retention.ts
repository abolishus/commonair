// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Daily: delete watch rooms ended over 30 days ago and end rooms empty for 10 minutes. Owned by W3-watch-rooms; a no-op stub until it lands (batch 7 contract step §5.1). */
import { WATCH_ROOM_JOBS, WatchRoomRetentionJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.watchRooms,
  name: WATCH_ROOM_JOBS.retention,
  description: "Daily: delete watch rooms ended over 30 days ago and end rooms empty for 10 minutes",
  data: WatchRoomRetentionJob,
  schedule: { pattern: "29 3 * * *" },
  handler: stubHandler(WATCH_ROOM_JOBS.retention),
});
