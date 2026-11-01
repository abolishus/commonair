// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `twitchImport.*` (ADR 0031, decision (b)). The logic lives in `../twitch-import/`. Only the
 * channel's owner imports: an import rewrites the channel's setup.
 */
import { forbidden } from "../lib/errors.ts";
import { os, requireCaller, requireChannel, type Ctx } from "../lib/orpc.ts";
import { connect, importStatus, latestPreview, startTwitchImport } from "../twitch-import/service.ts";

function ownedChannel(context: Ctx) {
  const c = requireChannel(context);
  const caller = requireCaller(context);
  if (c.ownerId !== caller.user.id) throw forbidden("Only the channel owner can do this");
  return { c, caller };
}

export const twitchImport = {
  status: os.twitchImport.status.handler(async ({ context }) => {
    const { c } = ownedChannel(context);
    return importStatus(context.deps, c);
  }),
  connect: os.twitchImport.connect.handler(async ({ context }) => {
    const { c, caller } = ownedChannel(context);
    return connect(context.deps, {
      channelId: c.id,
      userId: caller.user.id,
      sessionId: caller.kind === "session" ? caller.sessionId : null,
    });
  }),
  preview: os.twitchImport.preview.handler(async ({ context }) => {
    const { c } = ownedChannel(context);
    return latestPreview(context.deps, c);
  }),
  start: os.twitchImport.start.handler(async ({ context, input }) => {
    const { c, caller } = ownedChannel(context);
    return startTwitchImport(context.deps, {
      channelId: c.id,
      channelLanguage: c.language,
      userId: caller.user.id,
      id: input.id,
      choices: input.choices,
      assertEmoteRights: input.assertEmoteRights,
    });
  }),
};
