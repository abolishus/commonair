// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `clips.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const clips = {
  create: os.clips.create.handler(notImplemented),
  list: os.clips.list.handler(notImplemented),
  get: os.clips.get.handler(notImplemented),
  remove: os.clips.remove.handler(notImplemented),
};
