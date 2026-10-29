// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.predictions.*`. Owned by E8-polls; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const predictions = {
  current: os.interact.predictions.current.handler(notImplemented),
  create: os.interact.predictions.create.handler(notImplemented),
  bet: os.interact.predictions.bet.handler(notImplemented),
  lock: os.interact.predictions.lock.handler(notImplemented),
  resolve: os.interact.predictions.resolve.handler(notImplemented),
  cancel: os.interact.predictions.cancel.handler(notImplemented),
};
