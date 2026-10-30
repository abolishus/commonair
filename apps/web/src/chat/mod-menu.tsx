// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton } from "@commonair/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { Clock01Icon, MoreVerticalIcon, UnavailableIcon, UserBlock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../i18n/index.ts";

export const TIMEOUT_SECONDS = 600;

export interface MessageMenuProps {
  displayName: string;
  /** Opens the block confirmation (every signed-in viewer). */
  onBlock: () => void;
  /** Timeout and ban, for moderators only. */
  moderation?: { onTimeout: () => void; onBan: () => void } | null;
}

/**
 * The per-message menu, for every signed-in viewer on someone else's message: "Block <name>" for
 * everyone (ADR 0012 amendment 1 decision 8), timeout and ban for moderators.
 */
export function MessageMenu({ displayName, onBlock, moderation = null }: MessageMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton
            data-testid="chat-message-actions"
            data-moderation={moderation ? "true" : "false"}
            label={
              moderation
                ? t("chat.mod.actionsFor", { name: displayName })
                : t("calmChat.actionsFor", { name: displayName })
            }
            icon={MoreVerticalIcon}
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
          />
        }
      />
      <DropdownMenuContent align="end">
        {moderation && (
          <>
            <DropdownMenuItem data-testid="chat-mod-timeout" onClick={moderation.onTimeout}>
              <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden />
              {t("chat.mod.timeout")}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="chat-mod-ban" variant="destructive" onClick={moderation.onBan}>
              <HugeiconsIcon icon={UserBlock01Icon} strokeWidth={2} aria-hidden />
              {t("chat.mod.ban")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem data-testid="chat-user-block" onClick={onBlock}>
          <HugeiconsIcon icon={UnavailableIcon} strokeWidth={2} aria-hidden />
          {t("blocks.block", { name: displayName })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
