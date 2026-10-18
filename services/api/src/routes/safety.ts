// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `safety.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const safety = {
  report: os.safety.report.handler(notImplemented),
  queue: os.safety.queue.handler(notImplemented),
  resolve: os.safety.resolve.handler(notImplemented),
  modLog: os.safety.modLog.handler(notImplemented),
  auditLog: os.safety.auditLog.handler(notImplemented),
  dmca: {
    submit: os.safety.dmca.submit.handler(notImplemented),
    counter: os.safety.dmca.counter.handler(notImplemented),
    queue: os.safety.dmca.queue.handler(notImplemented),
    action: os.safety.dmca.action.handler(notImplemented),
  },
  suspend: os.safety.suspend.handler(notImplemented),
};
