// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `integrity.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const integrity = {
  channelSummary: os.integrity.channelSummary.handler(notImplemented),
  flags: os.integrity.flags.handler(notImplemented),
  decide: os.integrity.decide.handler(notImplemented),
};
