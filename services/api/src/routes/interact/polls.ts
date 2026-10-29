// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.polls.*`. Owned by E8-polls; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const polls = {
  current: os.interact.polls.current.handler(notImplemented),
  create: os.interact.polls.create.handler(notImplemented),
  vote: os.interact.polls.vote.handler(notImplemented),
  end: os.interact.polls.end.handler(notImplemented),
};
