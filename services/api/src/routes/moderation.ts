// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `moderation.*` (E4c): not implemented yet (HTTP 501); the E4c API unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const moderation = {
  queue: os.moderation.queue.handler(notImplemented),
  case: os.moderation.case.handler(notImplemented),
  frame: os.moderation.frame.handler(notImplemented),
  review: os.moderation.review.handler(notImplemented),
  t0Queue: os.moderation.t0Queue.handler(notImplemented),
  t0Confirm: os.moderation.t0Confirm.handler(notImplemented),
  t0Dismiss: os.moderation.t0Dismiss.handler(notImplemented),
  evidence: os.moderation.evidence.handler(notImplemented),
  ncmecReports: os.moderation.ncmecReports.handler(notImplemented),
  ncmecReport: os.moderation.ncmecReport.handler(notImplemented),
  ncmecFile: os.moderation.ncmecFile.handler(notImplemented),
  holds: os.moderation.holds.handler(notImplemented),
};
