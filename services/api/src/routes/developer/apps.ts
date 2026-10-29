// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.apps.*` (E9-apps): register, update, rotate and delete OAuth apps (ADR 0027 §1). */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const apps = {
  list: os.developer.apps.list.handler(notImplemented),
  create: os.developer.apps.create.handler(notImplemented),
  update: os.developer.apps.update.handler(notImplemented),
  rotateSecret: os.developer.apps.rotateSecret.handler(notImplemented),
  remove: os.developer.apps.remove.handler(notImplemented),
};
