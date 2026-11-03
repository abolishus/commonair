// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-web's extensions (docs/testing/b8-selectors.md, "Scenarios"): `interact` `grace-bet-web` (a
 * viewer bets within the grace window from the web, `prediction-grace`, and the server accepts it)
 * and `giveaway-verify-mine` (the verify page marks the caller's own pseudonym); `twitch-import`
 * `channel-panels-banner` (after the import, the channel page shows `channel-panels` and
 * `channel-banner`). Stub entry points from the batch 8 contract step: B8-web fills them.
 */
import type { InteractB8Extension, TwitchImportB8Extension } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("B8-web not merged");
};

export async function stepGraceBetWeb(_run: InteractB8Extension): Promise<void> {
  notMerged();
}

export async function stepGiveawayVerifyMine(_run: InteractB8Extension): Promise<void> {
  notMerged();
}

export async function stepChannelPanelsBanner(_run: TwitchImportB8Extension): Promise<void> {
  notMerged();
}
