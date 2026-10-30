// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.blocks.*` (ADR 0012 decision 8): users the caller blocked. HTTP 501 until W1-calm-chat implements them. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const meBlocks = {
  list: os.me.blocks.list.handler(notImplemented),
  ids: os.me.blocks.ids.handler(notImplemented),
  add: os.me.blocks.add.handler(notImplemented),
  remove: os.me.blocks.remove.handler(notImplemented),
};
