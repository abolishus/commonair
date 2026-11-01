// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { ChannelSummary } from "../../lib/channel-summary.ts";

export interface MovedNoticeProps {
  /** The channel's display name, for the notice text. */
  channelName: string;
  /** `Channel.movedTo`: where the channel moved and when; null when it has not moved. */
  movedTo: ChannelSummary["movedTo"];
}

/**
 * The "moved to …" notice on the channel page (ADR 0037), with the external-link note. Stub from
 * the batch 7 contract step: W3-portability fills it (`apps/web/src/components/portability/**`).
 */
export function MovedNotice(_props: MovedNoticeProps): React.JSX.Element | null {
  return null;
}
