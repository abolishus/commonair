// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `federation.*` (ADR 0030, decision (c)): studio settings and remote followers, and the admin
 * domain blocks and key rotation. Every procedure answers FORBIDDEN (`federation_disabled`) while
 * `FEDERATION_ENABLED` is false. The logic lives in `../federation/`.
 */
import { os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { addBlock, listBlocks, removeBlock } from "../federation/admin.ts";
import { rotateKeys } from "../federation/keys.ts";
import {
  getSettings,
  listFollowers,
  removeFollower,
  requireFederationEnabled,
  requireOwner,
  updateSettings,
} from "../federation/settings.ts";

export const federation = {
  settings: {
    get: os.federation.settings.get.handler(async ({ context }) => {
      requireFederationEnabled(context.deps);
      return getSettings(context.deps, requireChannel(context));
    }),
    update: os.federation.settings.update.handler(async ({ context, input }) => {
      requireFederationEnabled(context.deps);
      const c = requireChannel(context);
      const caller = requireCaller(context);
      requireOwner(c, caller.user.id);
      return updateSettings(context.deps, c, caller.user.id, input.enabled);
    }),
  },
  followers: {
    list: os.federation.followers.list.handler(async ({ context, input }) => {
      requireFederationEnabled(context.deps);
      const c = requireChannel(context);
      requireOwner(c, requireCaller(context).user.id);
      return listFollowers(context.deps, c.id, input);
    }),
    remove: os.federation.followers.remove.handler(async ({ context, input }) => {
      requireFederationEnabled(context.deps);
      const c = requireChannel(context);
      requireOwner(c, requireCaller(context).user.id);
      return removeFollower(context.deps, c.id, input.id);
    }),
  },
  admin: {
    blocks: {
      list: os.federation.admin.blocks.list.handler(async ({ context }) => {
        requireFederationEnabled(context.deps);
        return listBlocks(context.deps);
      }),
      add: os.federation.admin.blocks.add.handler(async ({ context, input }) => {
        requireFederationEnabled(context.deps);
        return addBlock(context.deps, requireCaller(context).user.id, input.domain);
      }),
      remove: os.federation.admin.blocks.remove.handler(async ({ context, input }) => {
        requireFederationEnabled(context.deps);
        return removeBlock(context.deps, requireCaller(context).user.id, input.domain);
      }),
    },
    keys: {
      rotate: os.federation.admin.keys.rotate.handler(async ({ context, input }) => {
        requireFederationEnabled(context.deps);
        return { rotated: await rotateKeys(context.deps, requireCaller(context).user.id, input.channel) };
      }),
    },
  },
};
