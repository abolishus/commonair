// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `ncii.*` (E4c): not implemented yet (HTTP 501); the E4c API unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const ncii = {
  submit: os.ncii.submit.handler(notImplemented),
  queue: os.ncii.queue.handler(notImplemented),
  decide: os.ncii.decide.handler(notImplemented),
};
