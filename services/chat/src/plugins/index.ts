// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The middleware registry. Plugins (the channel bot, the stream-key-leak scanner, …) add
 * themselves here; they run in array order after the built-in rules.
 */
import type { MessageMiddleware } from "../pipeline.ts";
import { createBotMiddleware } from "./bot/index.ts";
import { noopMiddleware } from "./noop.ts";

/** A fresh set per chat service, so two services in one process never share a bot engine. */
export function plugins(): MessageMiddleware[] {
  return [noopMiddleware, createBotMiddleware()];
}
