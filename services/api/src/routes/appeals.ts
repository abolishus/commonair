// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `appeals.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const appeals = {
  create: os.appeals.create.handler(notImplemented),
  mine: os.appeals.mine.handler(notImplemented),
  queue: os.appeals.queue.handler(notImplemented),
  resolve: os.appeals.resolve.handler(notImplemented),
};
