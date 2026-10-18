// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `legal.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const legal = {
  current: os.legal.current.handler(notImplemented),
  get: os.legal.get.handler(notImplemented),
  consent: os.legal.consent.handler(notImplemented),
};
