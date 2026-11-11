// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton } from "@commonair/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import {
  Clock01Icon,
  Delete02Icon,
  Flag01Icon,
  MoreVerticalIcon,
  UnavailableIcon,
  UserBlock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import { DEFAULT_TIMEOUT_SECONDS, TIMEOUT_OPTIONS, durationLabel } from "./modes.ts";

/** The timeout the plain `chat-mod-timeout` item applies (Twitch's default; the harness's 600 s). */
export const TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS;

/**
 * Each timeout length's test id: the default keeps `chat-mod-timeout` (e2-selectors), the others
 * are `chat-mod-timeout-<seconds>`.
 */
export function timeoutTestId(seconds: number): string {
  return seconds === DEFAULT_TIMEOUT_SECONDS ? "chat-mod-timeout" : `chat-mod-timeout-${seconds}`;
}

export interface MessageModeration {
  /** Removes this one message (the server's `delete` command). */
  onDelete: () => void;
  onTimeout: (seconds: number) => void;
  onBan: () => void;
}

export interface MessageMenuProps {
  displayName: string;
  /** Opens the block confirmation (every signed-in viewer). */
  onBlock: () => void;
  /** Opens the report dialog for this message (every signed-in viewer). */
  onReport?: () => void;
  /** Delete, timeout and ban, for moderators only. */
  moderation?: MessageModeration | null;
}

/**
 * The per-message menu, for every signed-in viewer on someone else's message: Report and "Block
 * <name>" for everyone (ADR 0012 amendment 1 decision 8), and for moderators Delete message, a
 * timeout of 1 minute, 10 minutes, 1 hour or 24 hours, and Ban (ux-journeys J5-d).
 */
export function MessageMenu({
  displayName,
  onBlock,
  onReport,
  moderation = null,
}: MessageMenuProps): React.JSX.Element {
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
      <DropdownMenuContent align="end" className="w-48">
        {moderation && (
          <>
            <DropdownMenuItem data-testid="chat-mod-delete" onClick={moderation.onDelete}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
              {t("d4Chat.menu.delete")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("d4Chat.menu.timeoutFor", { name: displayName })}</DropdownMenuLabel>
              {TIMEOUT_OPTIONS.map((seconds) => (
                <DropdownMenuItem
                  key={seconds}
                  data-testid={timeoutTestId(seconds)}
                  data-seconds={seconds}
                  onClick={() => moderation.onTimeout(seconds)}
                >
                  <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden />
                  {durationLabel(seconds)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="chat-mod-ban" variant="destructive" onClick={moderation.onBan}>
              <HugeiconsIcon icon={UserBlock01Icon} strokeWidth={2} aria-hidden />
              {t("chat.mod.ban")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {onReport && (
          <DropdownMenuItem data-testid="chat-message-report" onClick={onReport}>
            <HugeiconsIcon icon={Flag01Icon} strokeWidth={2} aria-hidden />
            {t("d4Chat.menu.report")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem data-testid="chat-user-block" onClick={onBlock}>
          <HugeiconsIcon icon={UnavailableIcon} strokeWidth={2} aria-hidden />
          {t("blocks.block", { name: displayName })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
