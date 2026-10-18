// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `vods.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const vods = {
  list: os.vods.list.handler(notImplemented),
  get: os.vods.get.handler(notImplemented),
  update: os.vods.update.handler(notImplemented),
  remove: os.vods.remove.handler(notImplemented),
};
