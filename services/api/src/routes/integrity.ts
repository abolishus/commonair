// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.*`. `flags` and `decide` (admins) live in `../admin/integrity.ts` (E7-admin);
 * `channelSummary` is still HTTP 501 until W2-rollup-analytics implements it.
 */
import { decideFlag, listFlags } from "../admin/integrity.ts";
import { notImplemented } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";

export const integrity = {
  channelSummary: os.integrity.channelSummary.handler(notImplemented),
  flags: os.integrity.flags.handler(({ context, input }) => listFlags(context.deps, input)),
  decide: os.integrity.decide.handler(({ context, input }) =>
    decideFlag(context.deps, requireCaller(context).user.id, input),
  ),
};
