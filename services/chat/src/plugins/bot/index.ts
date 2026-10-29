// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The built-in channel bot (E8, ADR 0026 decision 6): commands, timers, song requests, points.
 * Owned by E8-bot-engine; until it lands every message passes through untouched.
 */
import type { MessageMiddleware } from "../../pipeline.ts";

export const botMiddleware: MessageMiddleware = {
  name: "channel-bot",
  async process() {
    return "continue";
  },
};
