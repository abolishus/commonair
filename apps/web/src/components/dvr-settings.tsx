// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

/**
 * The channel's DVR settings on the stream manager (`/dashboard`): on/off and the window, capped
 * by the instance (`channels.mediaSettings` / `updateMediaSettings`, ADR 0016). Stub from the W2
 * contract step: W2-dvr fills it (`apps/web/src/components/dvr-settings*`).
 */
export function DvrSettings(_props: { channel: string }): React.JSX.Element | null {
  return null;
}
