// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.goals.*`. Owned by E8-raids-goals; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const goals = {
  list: os.interact.goals.list.handler(notImplemented),
  create: os.interact.goals.create.handler(notImplemented),
  end: os.interact.goals.end.handler(notImplemented),
};
