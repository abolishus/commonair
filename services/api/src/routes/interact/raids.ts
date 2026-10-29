// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.raids.*`. Owned by E8-raids-goals; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const raids = {
  start: os.interact.raids.start.handler(notImplemented),
  cancel: os.interact.raids.cancel.handler(notImplemented),
  current: os.interact.raids.current.handler(notImplemented),
  setPolicy: os.interact.raids.setPolicy.handler(notImplemented),
};
