// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chat.bans.bulk` (overhaul wave 4, J5-d): time out every sender of a message wave, optionally
 * deleting its messages. The rules are in `chat-bulk/plan.ts`, the writes in `chat-bulk/apply.ts`.
 */
import { bulkTimeout } from "../chat-bulk/apply.ts";
import { os, requireCaller, requireChannel } from "../lib/orpc.ts";

export const chatBansBulk = {
  bulk: os.chat.bans.bulk.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    return bulkTimeout(context.deps, {
      channel: requireChannel(context),
      callerId: caller.user.id,
      messageIds: input.messageIds,
      durationSeconds: input.durationSeconds,
      reason: input.reason,
      deleteMessages: input.deleteMessages,
    });
  }),
};
