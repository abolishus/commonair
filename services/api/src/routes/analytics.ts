// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `analytics.*` (W2-rollup-analytics, batch 6 decision (k)): owner views of the per-broadcast
 * rollup and its share links. Contract-step stubs (HTTP 501) until that unit implements them; the
 * queries belong in `../analytics/**` (except `appeals.ts`, W2b-group-appeals').
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

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
