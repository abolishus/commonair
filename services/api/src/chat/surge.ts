// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `chat.surge.*` (ADR 0015 decision 6): surge-guard state and the moderator override. HTTP 501 until W1-watch-gate implements them. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const chatSurge = {
  state: os.chat.surge.state.handler(notImplemented),
  override: os.chat.surge.override.handler(notImplemented),
};
