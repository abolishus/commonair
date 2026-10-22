// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const interact = {
  polls: {
    current: os.interact.polls.current.handler(notImplemented),
    create: os.interact.polls.create.handler(notImplemented),
    vote: os.interact.polls.vote.handler(notImplemented),
    end: os.interact.polls.end.handler(notImplemented),
  },
  predictions: {
    current: os.interact.predictions.current.handler(notImplemented),
    create: os.interact.predictions.create.handler(notImplemented),
    bet: os.interact.predictions.bet.handler(notImplemented),
    lock: os.interact.predictions.lock.handler(notImplemented),
    resolve: os.interact.predictions.resolve.handler(notImplemented),
    cancel: os.interact.predictions.cancel.handler(notImplemented),
  },
  raids: {
    start: os.interact.raids.start.handler(notImplemented),
    cancel: os.interact.raids.cancel.handler(notImplemented),
  },
  alerts: {
    list: os.interact.alerts.list.handler(notImplemented),
    set: os.interact.alerts.set.handler(notImplemented),
    test: os.interact.alerts.test.handler(notImplemented),
  },
  goals: {
    list: os.interact.goals.list.handler(notImplemented),
    create: os.interact.goals.create.handler(notImplemented),
    end: os.interact.goals.end.handler(notImplemented),
  },
  overlays: {
    token: os.interact.overlays.token.handler(notImplemented),
    status: os.interact.overlays.status.handler(notImplemented),
    revoke: os.interact.overlays.revoke.handler(notImplemented),
    state: os.interact.overlays.state.handler(notImplemented),
  },
};
