// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 contract step (.claude/briefs/w3/contract-step.md §2.4, §5.1): every new procedure
 * answers 501 until its unit fills it. Temporary: the seams part moves each group into the route
 * file its unit owns (`routes/{watch-rooms,portability,jury,twitch-import,federation}.ts`,
 * `routes/interact/giveaways.ts`, `relay/purges.ts`) and deletes this file.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const watchRooms = {
  create: os.watchRooms.create.handler(() => notImplemented()),
  get: os.watchRooms.get.handler(() => notImplemented()),
  invite: os.watchRooms.invite.handler(() => notImplemented()),
  join: os.watchRooms.join.handler(() => notImplemented()),
  leave: os.watchRooms.leave.handler(() => notImplemented()),
  close: os.watchRooms.close.handler(() => notImplemented()),
  mine: os.watchRooms.mine.handler(() => notImplemented()),
};

export const portability = {
  links: {
    list: os.portability.links.list.handler(() => notImplemented()),
    create: os.portability.links.create.handler(() => notImplemented()),
    revoke: os.portability.links.revoke.handler(() => notImplemented()),
    resolve: os.portability.links.resolve.handler(() => notImplemented()),
  },
  grants: {
    set: os.portability.grants.set.handler(() => notImplemented()),
    mine: os.portability.grants.mine.handler(() => notImplemented()),
  },
  move: {
    set: os.portability.move.set.handler(() => notImplemented()),
    clear: os.portability.move.clear.handler(() => notImplemented()),
  },
  bundle: {
    create: os.portability.bundle.create.handler(() => notImplemented()),
  },
  imports: {
    upload: os.portability.imports.upload.handler(() => notImplemented()),
    preview: os.portability.imports.preview.handler(() => notImplemented()),
    start: os.portability.imports.start.handler(() => notImplemented()),
    get: os.portability.imports.get.handler(() => notImplemented()),
    list: os.portability.imports.list.handler(() => notImplemented()),
  },
};

export const giveaways = {
  current: os.interact.giveaways.current.handler(() => notImplemented()),
  open: os.interact.giveaways.open.handler(() => notImplemented()),
  enter: os.interact.giveaways.enter.handler(() => notImplemented()),
  close: os.interact.giveaways.close.handler(() => notImplemented()),
  draw: os.interact.giveaways.draw.handler(() => notImplemented()),
  cancel: os.interact.giveaways.cancel.handler(() => notImplemented()),
  verify: os.interact.giveaways.verify.handler(() => notImplemented()),
};

export const jury = {
  optIn: os.jury.optIn.handler(() => notImplemented()),
  optOut: os.jury.optOut.handler(() => notImplemented()),
  status: os.jury.status.handler(() => notImplemented()),
  panel: os.jury.panel.handler(() => notImplemented()),
  cases: os.jury.cases.handler(() => notImplemented()),
  vote: os.jury.vote.handler(() => notImplemented()),
  results: os.jury.results.handler(() => notImplemented()),
  flags: {
    list: os.jury.flags.list.handler(() => notImplemented()),
  },
};

export const twitchImport = {
  status: os.twitchImport.status.handler(() => notImplemented()),
  connect: os.twitchImport.connect.handler(() => notImplemented()),
  preview: os.twitchImport.preview.handler(() => notImplemented()),
  start: os.twitchImport.start.handler(() => notImplemented()),
};

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

/** `relays.purges` (W3-dvr-relay fills it in `relay/purges.ts`). */
export const relayPurges = os.relays.purges.handler(() => notImplemented());
