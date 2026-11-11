// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import { StatusBadge } from "@commonair/ui";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import { activeModes, modeChipHint, modeChipLabel } from "./modes.ts";

/**
 * The chat modes that are on, as quiet chips above the composer (`chat-mode-chips`; J5-b's "state
 * chip that viewers also see"). Each chip's sentence is read with it; nothing renders when no mode
 * is on.
 */
export function ModeChips({
  settings,
  channelName,
}: {
  settings: ChannelChatSettings | null;
  channelName: string;
}): React.JSX.Element | null {
  const chips = activeModes(settings);
  if (chips.length === 0) return null;
  return (
    <ul
      data-testid="chat-mode-chips"
      aria-label={t("d4Chat.chip.label")}
      className="flex min-w-0 flex-wrap items-center gap-1 px-1"
    >
      {chips.map((chip) => (
        <li key={chip.kind} data-testid="chat-mode-chip" data-mode={chip.kind}>
          <StatusBadge tone="neutral">{modeChipLabel(chip)}</StatusBadge>
          <span className="sr-only">{modeChipHint(chip, channelName)}</span>
        </li>
      ))}
    </ul>
  );
}
