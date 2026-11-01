// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `federation.*`: studio and admin procedures. Contract-step stub: N4-api fills it. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const federation = {
  settings: {
    get: os.federation.settings.get.handler(() => notImplemented()),
    update: os.federation.settings.update.handler(() => notImplemented()),
  },
  followers: {
    list: os.federation.followers.list.handler(() => notImplemented()),
    remove: os.federation.followers.remove.handler(() => notImplemented()),
  },
  admin: {
    blocks: {
      list: os.federation.admin.blocks.list.handler(() => notImplemented()),
      add: os.federation.admin.blocks.add.handler(() => notImplemented()),
      remove: os.federation.admin.blocks.remove.handler(() => notImplemented()),
    },
    keys: {
      rotate: os.federation.admin.keys.rotate.handler(() => notImplemented()),
    },
  },
};
