// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The middleware registry. Plugins (the channel bot, the stream-key-leak scanner, …) add
 * themselves here; they run in array order after the built-in rules.
 */
import type { MessageMiddleware } from "../pipeline.ts";
import { noopMiddleware } from "./noop.ts";

export const plugins: MessageMiddleware[] = [noopMiddleware];
