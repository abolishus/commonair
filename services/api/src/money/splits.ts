// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.splits.*` and `money.treasurer.splits.*` (W2-splits, ADR 0013, batch 6 decisions (a),
 * (i)): versioned revenue splits, their acceptances, and the treasurer's shortfall write-offs and
 * suspense release/forfeit. Contract-step stubs (HTTP 501) until W2-splits implements them; the
 * database (`0043_w2_protections.sql`) already enforces the split and suspense rules.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const splitHandlers = {
  list: os.money.splits.list.handler(notImplemented),
  propose: os.money.splits.propose.handler(notImplemented),
  accept: os.money.splits.accept.handler(notImplemented),
  reject: os.money.splits.reject.handler(notImplemented),
  end: os.money.splits.end.handler(notImplemented),
};

export const treasurerSplitHandlers = {
  writeOffs: os.money.treasurer.splits.writeOffs.handler(notImplemented),
  proposeWriteOff: os.money.treasurer.splits.proposeWriteOff.handler(notImplemented),
  approveWriteOff: os.money.treasurer.splits.approveWriteOff.handler(notImplemented),
  releaseSuspense: os.money.treasurer.splits.releaseSuspense.handler(notImplemented),
  forfeitSuspense: os.money.treasurer.splits.forfeitSuspense.handler(notImplemented),
};
