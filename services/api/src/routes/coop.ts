// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `coop.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const coop = {
  membership: os.coop.membership.handler(notImplemented),
  buyShare: os.coop.buyShare.handler(notImplemented),
  exit: os.coop.exit.handler(notImplemented),
  appointWorker: os.coop.appointWorker.handler(notImplemented),
  settings: os.coop.settings.handler(notImplemented),
  proposals: {
    list: os.coop.proposals.list.handler(notImplemented),
    get: os.coop.proposals.get.handler(notImplemented),
    create: os.coop.proposals.create.handler(notImplemented),
    submit: os.coop.proposals.submit.handler(notImplemented),
    withdraw: os.coop.proposals.withdraw.handler(notImplemented),
    comments: os.coop.proposals.comments.handler(notImplemented),
    comment: os.coop.proposals.comment.handler(notImplemented),
    vote: os.coop.proposals.vote.handler(notImplemented),
    councilRespond: os.coop.proposals.councilRespond.handler(notImplemented),
  },
  council: os.coop.council.handler(notImplemented),
  elections: {
    list: os.coop.elections.list.handler(notImplemented),
    nominate: os.coop.elections.nominate.handler(notImplemented),
    vote: os.coop.elections.vote.handler(notImplemented),
    create: os.coop.elections.create.handler(notImplemented),
  },
  board: os.coop.board.handler(notImplemented),
  patronage: {
    statements: os.coop.patronage.statements.handler(notImplemented),
    statement: os.coop.patronage.statement.handler(notImplemented),
    run: os.coop.patronage.run.handler(notImplemented),
    approve: os.coop.patronage.approve.handler(notImplemented),
  },
  transparency: os.coop.transparency.handler(notImplemented),
};
