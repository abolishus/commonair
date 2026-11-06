// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability.*` (ADR 0037, decisions (j)–(p)): move links, "tell me if they move" grants, the
 * move notice, the bundle export and the bundle import. The logic lives in `../portability/`.
 *
 * Links are managed by whoever manages the channel (owner or editor). Moving, exporting and
 * importing are the owner's alone: they speak for, or replace, the whole channel.
 */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { channelAvatar, channelBySlug } from "../lib/dto.ts";
import { forbidden } from "../lib/errors.ts";
import { os, requireCaller, requireChannel, type Ctx } from "../lib/orpc.ts";
import { clearMove, myGrants, setGrant, setGrants, setMove } from "../portability/audience.ts";
import { getImport, listImports, presignArchive, previewImport, startImport } from "../portability/imports.ts";
import { createLink, findLink, linkState, listLinks, revokeLink } from "../portability/links.ts";
import { createExport } from "../privacy/exports.ts";

/** The channel, when the caller owns it (editors may manage links, not move or replace the channel). */
function ownedChannel(context: Ctx) {
  const c = requireChannel(context);
  const caller = requireCaller(context);
  if (c.ownerId !== caller.user.id) throw forbidden("Only the channel owner can do this");
  return { c, caller };
}

export const portability = {
  links: {
    list: os.portability.links.list.handler(async ({ context }) => listLinks(context.deps, requireChannel(context).id)),
    create: os.portability.links.create.handler(async ({ context, input }) => {
      const c = requireChannel(context);
      const caller = requireCaller(context);
      return createLink(context.deps, {
        channelId: c.id,
        slug: c.slug,
        actorId: caller.user.id,
        expiresAt: input.expiresAt,
      });
    }),
    revoke: os.portability.links.revoke.handler(async ({ context, input }) => {
      const c = requireChannel(context);
      const caller = requireCaller(context);
      return revokeLink(context.deps, { channelId: c.id, id: input.id, actorId: caller.user.id });
    }),
    resolve: os.portability.links.resolve.handler(async ({ context: { deps }, input }) => {
      const c = await channelBySlug(deps, input.channel);
      const link = c ? await findLink(deps.db, c.id, input.nonce) : null;
      if (!c || !link) return { state: "unknown" as const, channel: null };
      const [owner] = await deps.db
        .select({ image: schema.users.image })
        .from(schema.users)
        .where(eq(schema.users.id, c.ownerId));
      return {
        state: linkState(link, deps.now()),
        channel: {
          id: c.id,
          slug: c.slug,
          displayName: c.displayName,
          avatarUrl: channelAvatar(deps, c, owner?.image ?? null),
          title: c.title,
          followerCount: c.followerCount,
        },
      };
    }),
  },
  grants: {
    set: os.portability.grants.set.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      return setGrant(context.deps, { userId: caller.user.id, slug: input.channel, enabled: input.enabled });
    }),
    setMany: os.portability.grants.setMany.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      return setGrants(context.deps, { userId: caller.user.id, slugs: input.channels, enabled: input.enabled });
    }),
    mine: os.portability.grants.mine.handler(async ({ context }) =>
      myGrants(context.deps, requireCaller(context).user.id),
    ),
  },
  move: {
    set: os.portability.move.set.handler(async ({ context, input }) => {
      const { c, caller } = ownedChannel(context);
      return setMove(context.deps, { channelId: c.id, actorId: caller.user.id, movedTo: input.movedTo });
    }),
    clear: os.portability.move.clear.handler(async ({ context }) => {
      const { c, caller } = ownedChannel(context);
      return clearMove(context.deps, { channelId: c.id, actorId: caller.user.id });
    }),
  },
  bundle: {
    // The shared export pipeline (cooldown, build, TTL, mail); the worker builds the bundle.
    create: os.portability.bundle.create.handler(async ({ context }) => {
      const { caller } = ownedChannel(context);
      return createExport(context.deps, caller.user.id, "bundle");
    }),
  },
  imports: {
    upload: os.portability.imports.upload.handler(async ({ context, input }) => {
      const { c } = ownedChannel(context);
      return presignArchive(context.deps, c.id, input.sizeBytes);
    }),
    preview: os.portability.imports.preview.handler(async ({ context, input }) => {
      const { c, caller } = ownedChannel(context);
      return previewImport(context.deps, { channelId: c.id, userId: caller.user.id, key: input.key });
    }),
    start: os.portability.imports.start.handler(async ({ context, input }) => {
      const { c, caller } = ownedChannel(context);
      return startImport(context.deps, {
        channelId: c.id,
        userId: caller.user.id,
        id: input.id,
        choices: input.choices,
        assertEmoteRights: input.assertEmoteRights,
      });
    }),
    get: os.portability.imports.get.handler(async ({ context, input }) => {
      const { c } = ownedChannel(context);
      return getImport(context.deps, c.id, input.id);
    }),
    list: os.portability.imports.list.handler(async ({ context }) => {
      const { c } = ownedChannel(context);
      return listImports(context.deps, c.id);
    }),
  },
};
