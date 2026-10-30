// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.unsubscribe` (ADR 0028 decision 4): the web confirm page's action. HTTP 501 until N1-email implements it. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const unsubscribe = os.notifications.unsubscribe.handler(notImplemented);
