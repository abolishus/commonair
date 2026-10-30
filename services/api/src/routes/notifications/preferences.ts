// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.preferences.*` (ADR 0028 decision 4). HTTP 501 until N1-inbox implements them. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const preferences = {
  get: os.notifications.preferences.get.handler(notImplemented),
  set: os.notifications.preferences.set.handler(notImplemented),
};
