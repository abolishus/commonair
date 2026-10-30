// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `coop.feeSchedule` (feature-wins §4.1): every change to the platform cut and payout rules. HTTP 501 until W1-breakdown implements it. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const feeScheduleHandler = os.coop.feeSchedule.handler(notImplemented);
