// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `coop.*` (E5): a thin map onto the handlers in `src/coop/`. */
import { councilHandlers } from "../coop/council.ts";
import { membershipHandlers } from "../coop/membership.ts";
import { patronageHandlers } from "../coop/patronage.ts";
import { proposalHandlers } from "../coop/proposals.ts";
import { transparencyHandler } from "../money/reports.ts";

export const coop = {
  membership: membershipHandlers.membership,
  buyShare: membershipHandlers.buyShare,
  shares: membershipHandlers.shares,
  exit: membershipHandlers.exit,
  appointWorker: membershipHandlers.appointWorker,
  settings: councilHandlers.settings,
  proposals: proposalHandlers,
  council: councilHandlers.council,
  elections: councilHandlers.elections,
  board: councilHandlers.board,
  patronage: patronageHandlers,
  transparency: transparencyHandler,
};
