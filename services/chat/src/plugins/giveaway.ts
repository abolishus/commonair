// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The giveaway chat plugin (decision (t)): while a giveaway with a keyword is open, a chat message
 * that is the keyword enters the sender. Owned by W3-giveaways; registered in `plugins/index.ts` by
 * the batch 7 contract step. It is a no-op while `GIVEAWAYS_ENABLED` is false (decision (a)), and a
 * stub (always a no-op) until the unit lands.
 */
import type { MessageMiddleware } from "../pipeline.ts";

export interface GiveawayPluginOptions {
  /** `GIVEAWAYS_ENABLED`. */
  enabled: boolean;
}

export function createGiveawayMiddleware(_opts: GiveawayPluginOptions): MessageMiddleware {
  return {
    name: "giveaway",
    async process() {
      return "continue";
    },
  };
}
