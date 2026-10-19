// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton } from "@commonair/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { Clock01Icon, MoreVerticalIcon, UserBlock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../i18n/index.ts";

export const TIMEOUT_SECONDS = 600;

export interface ModMenuProps {
  displayName: string;
  onTimeout: () => void;
  onBan: () => void;
}

/** Per-message moderation menu (moderators only, never on your own messages). */
export function ModMenu({ displayName, onTimeout, onBan }: ModMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton
            data-testid="chat-message-actions"
            label={t("chat.mod.actionsFor", { name: displayName })}
            icon={MoreVerticalIcon}
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
          />
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-testid="chat-mod-timeout" onClick={onTimeout}>
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden />
          {t("chat.mod.timeout")}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="chat-mod-ban" variant="destructive" onClick={onBan}>
          <HugeiconsIcon icon={UserBlock01Icon} strokeWidth={2} aria-hidden />
          {t("chat.mod.ban")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
