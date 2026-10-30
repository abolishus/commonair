// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.discord.*` (ADR 0028 decision 5): a channel's Discord webhook. HTTP 501 until N1-discord implements them. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const discord = {
  get: os.notifications.discord.get.handler(notImplemented),
  set: os.notifications.discord.set.handler(notImplemented),
  remove: os.notifications.discord.remove.handler(notImplemented),
  test: os.notifications.discord.test.handler(notImplemented),
};
