// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.admin.*` (E9-apps): every app on the instance, suspend and unsuspend (ADR 0027 §4). */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const admin = {
  list: os.developer.admin.list.handler(notImplemented),
  suspend: os.developer.admin.suspend.handler(notImplemented),
  unsuspend: os.developer.admin.unsuspend.handler(notImplemented),
};
