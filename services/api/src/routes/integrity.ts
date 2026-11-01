// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.*`. `flags` and `decide` (admins) live in `../admin/integrity.ts` (E7-admin);
 * `channelSummary` is still HTTP 501 until W2-rollup-analytics implements it. The W2 contract
 * step's stubs below (attestations, keys, and the new top-level `analytics` and `transparency`)
 * answer 501 too; the scaffolding moves them to their own route files.
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
  attestations: {
    list: os.integrity.attestations.list.handler(notImplemented),
    get: os.integrity.attestations.get.handler(notImplemented),
    share: os.integrity.attestations.share.handler(notImplemented),
    shared: os.integrity.attestations.shared.handler(notImplemented),
    verify: os.integrity.attestations.verify.handler(notImplemented),
  },
  keys: {
    list: os.integrity.keys.list.handler(notImplemented),
    compromise: os.integrity.keys.compromise.handler(notImplemented),
  },
};

/** W2-rollup-analytics (`routes/analytics.ts` once the scaffolding moves it). */
export const analytics = {
  broadcast: os.analytics.broadcast.handler(notImplemented),
  range: os.analytics.range.handler(notImplemented),
  exclusions: os.analytics.exclusions.handler(notImplemented),
  pnl: os.analytics.pnl.handler(notImplemented),
  shared: os.analytics.shared.handler(notImplemented),
  shareLink: {
    list: os.analytics.shareLink.list.handler(notImplemented),
    create: os.analytics.shareLink.create.handler(notImplemented),
    revoke: os.analytics.shareLink.revoke.handler(notImplemented),
  },
};

/** W2-enforcement-report (`routes/transparency.ts` once the scaffolding moves it). */
export const transparency = {
  enforcement: os.transparency.enforcement.handler(notImplemented),
};
