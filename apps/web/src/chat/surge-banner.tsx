// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import type * as React from "react";

export interface SurgeBannerProps {
  channel: string;
  canModerate: boolean;
  signedIn: boolean;
  /** The latest chat settings from the `joined` and `settings` frames; null before the join. */
  settings: ChannelChatSettings | null;
  /** The latest surge state from the `joined` and `surge` frames; null until one arrives. */
  surge: { state: "off" | "on" | "suppressed"; until: string | null } | null;
  /** The viewer's last message was refused with `msg_verified_watch` (reset on reconnect). */
  gateDenied: boolean;
}

/**
 * The surge-mode banner for moderators and the gate hint for viewers (ADR 0015 decisions 6 and 7).
 * Stub: W1-watch-gate fills it.
 */
export function SurgeBanner(_props: SurgeBannerProps): React.JSX.Element | null {
  return null;
}
