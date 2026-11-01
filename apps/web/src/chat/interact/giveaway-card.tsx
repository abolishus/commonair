// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { InteractClient } from "./client.ts";
import type { GiveawayDto } from "./state.ts";

export interface GiveawayCardProps {
  channel: string;
  giveaway: GiveawayDto;
  signedIn: boolean;
  /** `giveawayEnter`; tests pass a fake. */
  client: InteractClient;
  /** The giveaway as `interact.giveaways.enter` returned it. */
  onEntered: (giveaway: GiveawayDto) => void;
}

/**
 * The viewer's giveaway card in the chat panel (ADR 0039): the enter button, the eligibility
 * reason, the "no purchase necessary" line, the official-rules link and the link to the public
 * verify page. Only mounted while the instance has giveaways on. Stub from the batch 7 contract
 * step: W3-giveaways fills it.
 */
export function GiveawayCard(_props: GiveawayCardProps): React.JSX.Element | null {
  return null;
}
