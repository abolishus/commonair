// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The moderator's chat-mode controls (ux-journeys J5-b; mockup `mod-view.html`): slow mode with
 * its lengths, followers-only with a follow age, subscribers-only, emotes-only, and Clear chat
 * behind a `ConfirmDialog`. Each control sends the server's own `command` frame; what is on comes
 * back in the `settings` frame, so the controls show the room's state, never a guess.
 *
 * Two shapes: a menu for the chat header on the channel page (`chat-modes`), and a toolbar row for
 * the mod view (`chat-modes-toolbar`), where there is room for every mode at once.
 */
import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import { ConfirmDialog, IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { Toggle } from "@commonair/ui/components/toggle";
import { toast } from "@commonair/ui/toast";
import { ArrowDown01Icon, Delete02Icon, SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  CLEAR_COMMAND,
  FOLLOWER_AGE_OPTIONS,
  SLOW_OPTIONS,
  durationLabel,
  emoteOnlyCommand,
  followerAgeLabel,
  followersCommand,
  slowCommand,
  subscribersCommand,
  type ChatCommand,
} from "../modes.ts";

export interface ChatModesProps {
  /** The latest `settings` frame; null before the join (the controls stay disabled). */
  settings: ChannelChatSettings | null;
  /** Sends one command frame; false when chat is not connected. */
  onCommand: (command: ChatCommand) => boolean;
}

const OFF = "off";

/** Send, or say chat is not connected (the frame never left). */
function useSend(onCommand: ChatModesProps["onCommand"]): (command: ChatCommand) => void {
  return React.useCallback(
    (command: ChatCommand) => {
      if (!onCommand(command)) toast.error(t("chat.notConnected"));
    },
    [onCommand],
  );
}

/** The current length first if it is not one of the menu's own, so the radio shows it. */
function withCurrent(options: readonly number[], current: number | null): number[] {
  return current === null || options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

function SlowItems({ settings, send }: { settings: ChannelChatSettings | null; send: (c: ChatCommand) => void }) {
  const current = settings?.slowModeSeconds ?? 0;
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t("d4Chat.modes.slow")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={String(current)}>
        <DropdownMenuRadioItem
          closeOnClick
          value="0"
          data-testid="chat-mode-slow-0"
          onClick={() => send(slowCommand(0))}
        >
          {t("d4Chat.modes.off")}
        </DropdownMenuRadioItem>
        {withCurrent(SLOW_OPTIONS, current > 0 ? current : null).map((s) => (
          <DropdownMenuRadioItem
            closeOnClick
            key={s}
            value={String(s)}
            data-testid={`chat-mode-slow-${s}`}
            onClick={() => send(slowCommand(s))}
          >
            {durationLabel(s)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

function FollowerItems({ settings, send }: { settings: ChannelChatSettings | null; send: (c: ChatCommand) => void }) {
  const current = settings?.followersOnlyMinutes ?? null;
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t("d4Chat.modes.followers")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={current === null ? OFF : String(current)}>
        <DropdownMenuRadioItem
          closeOnClick
          value={OFF}
          data-testid="chat-mode-followers-off"
          onClick={() => send(followersCommand(null))}
        >
          {t("d4Chat.modes.off")}
        </DropdownMenuRadioItem>
        {withCurrent(FOLLOWER_AGE_OPTIONS, current).map((m) => (
          <DropdownMenuRadioItem
            closeOnClick
            key={m}
            value={String(m)}
            data-testid={`chat-mode-followers-${m}`}
            onClick={() => send(followersCommand(m))}
          >
            {followerAgeLabel(m)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

function ClearDialog({
  open,
  onOpenChange,
  send,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  send: (c: ChatCommand) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      variant="destructive"
      icon={Delete02Icon}
      title={t("d4Chat.modes.clearTitle")}
      description={t("d4Chat.modes.clearBody")}
      confirmLabel={t("d4Chat.modes.clearConfirm")}
      contentProps={{ "data-testid": "chat-mode-clear-dialog" }}
      onConfirm={() => send(CLEAR_COMMAND)}
    />
  );
}

/** The chat header's "Chat modes" menu for moderators and the broadcaster. */
export function ChatModesMenu({ settings, onCommand }: ChatModesProps): React.JSX.Element {
  const send = useSend(onCommand);
  const [clearing, setClearing] = React.useState(false);
  const disabled = settings === null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <IconButton
              data-testid="chat-modes"
              label={t("d4Chat.modes.label")}
              icon={SlidersHorizontalIcon}
              size="icon-sm"
              className="text-muted-foreground"
            />
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          <SlowItems settings={settings} send={send} />
          <DropdownMenuSeparator />
          <FollowerItems settings={settings} send={send} />
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem
              data-testid="chat-mode-subs"
              checked={settings?.subscribersOnly ?? false}
              closeOnClick
              onCheckedChange={(on) => send(subscribersCommand(on))}
            >
              {t("d4Chat.modes.subs")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              data-testid="chat-mode-emote"
              checked={settings?.emoteOnly ?? false}
              closeOnClick
              onCheckedChange={(on) => send(emoteOnlyCommand(on))}
            >
              {t("d4Chat.modes.emote")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="chat-mode-clear" variant="destructive" onClick={() => setClearing(true)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
            {t("d4Chat.modes.clear")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ClearDialog open={clearing} onOpenChange={setClearing} send={send} />
    </>
  );
}

/** A mode's dropdown in the toolbar: its button reads the state ("Slow · 30 seconds"). */
function ToolbarMenu({
  testId,
  label,
  on,
  disabled,
  children,
}: {
  testId: string;
  label: string;
  on: boolean;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            size="sm"
            variant={on ? "secondary" : "ghost"}
            data-testid={testId}
            data-on={on ? "true" : "false"}
          >
            {label}
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden data-icon="inline-end" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The mod view's row of chat modes, above the log. */
export function ChatModesToolbar({ settings, onCommand }: ChatModesProps): React.JSX.Element {
  const send = useSend(onCommand);
  const [clearing, setClearing] = React.useState(false);
  const disabled = settings === null;
  const slow = settings?.slowModeSeconds ?? 0;
  const followers = settings?.followersOnlyMinutes ?? null;
  const subs = settings?.subscribersOnly ?? false;
  const emote = settings?.emoteOnly ?? false;
  return (
    // A fieldset groups the controls under one name without a hand-rolled toolbar role.
    <fieldset data-testid="chat-modes-toolbar" className="flex min-w-0 flex-wrap items-center gap-1">
      <legend className="sr-only">{t("d4Chat.modes.label")}</legend>
      <ToolbarMenu
        testId="chat-mode-slow"
        on={slow > 0}
        disabled={disabled}
        label={slow > 0 ? t("d4Chat.chip.slow", { duration: durationLabel(slow) }) : t("d4Chat.modes.slow")}
      >
        <SlowItems settings={settings} send={send} />
      </ToolbarMenu>
      <ToolbarMenu
        testId="chat-mode-followers"
        on={followers !== null}
        disabled={disabled}
        label={
          followers === null || followers === 0
            ? t("d4Chat.modes.followers")
            : t("d4Chat.chip.followersAge", { duration: durationLabel(followers * 60) })
        }
      >
        <FollowerItems settings={settings} send={send} />
      </ToolbarMenu>
      <Toggle
        size="sm"
        data-testid="chat-mode-subs"
        pressed={subs}
        disabled={disabled}
        onPressedChange={() => send(subscribersCommand(!subs))}
      >
        {t("d4Chat.modes.subs")}
      </Toggle>
      <Toggle
        size="sm"
        data-testid="chat-mode-emote"
        pressed={emote}
        disabled={disabled}
        onPressedChange={() => send(emoteOnlyCommand(!emote))}
      >
        {t("d4Chat.modes.emote")}
      </Toggle>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="chat-mode-clear"
        disabled={disabled}
        className="ms-auto text-destructive"
        onClick={() => setClearing(true)}
      >
        {t("d4Chat.modes.clear")}
      </Button>
      <ClearDialog open={clearing} onOpenChange={setClearing} send={send} />
    </fieldset>
  );
}
