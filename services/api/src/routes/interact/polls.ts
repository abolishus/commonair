// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.polls.*` (E8-polls; logic in `../../interact/polls/service.ts`). */
import { createPoll, currentPoll, endPoll, votePoll } from "../../interact/polls/service.ts";
import { requireAuthority } from "../../interact/polls/shared.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const polls = {
  current: os.interact.polls.current.handler(({ context, input }) =>
    currentPoll(context.deps, input.channel, context.caller),
  ),
  create: os.interact.polls.create.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const channel = requireChannel(context);
    // The middleware admitted the caller; this names their role for the audit row.
    const authority = await requireAuthority(context.deps.db, caller, channel);
    return createPoll(context.deps, caller, authority, channel, input);
  }),
  vote: os.interact.polls.vote.handler(({ context, input }) => votePoll(context.deps, requireCaller(context), input)),
  end: os.interact.polls.end.handler(({ context, input }) => endPoll(context.deps, requireCaller(context), input)),
};
