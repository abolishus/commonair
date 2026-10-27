// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.enforcement.*`: statements of reasons (ADR 0019). HTTP 501 until W0-sor replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const meEnforcement = {
  list: os.me.enforcement.list.handler(notImplemented),
};
