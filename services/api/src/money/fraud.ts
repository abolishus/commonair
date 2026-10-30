// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `money.treasurer.fraudFlags.*` (ADR 0036): the payment fraud floor's review flow. HTTP 501 until W1-fraud-floor implements them. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const treasurerFraudHandlers = {
  list: os.money.treasurer.fraudFlags.list.handler(notImplemented),
  raise: os.money.treasurer.fraudFlags.raise.handler(notImplemented),
  review: os.money.treasurer.fraudFlags.review.handler(notImplemented),
  decide: os.money.treasurer.fraudFlags.decide.handler(notImplemented),
  release: os.money.treasurer.fraudFlags.release.handler(notImplemented),
};
