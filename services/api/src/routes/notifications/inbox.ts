// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.unreadCount` (ADR 0028): the bell's badge. HTTP 501 until N1-inbox implements it. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const unreadCount = os.notifications.unreadCount.handler(notImplemented);
