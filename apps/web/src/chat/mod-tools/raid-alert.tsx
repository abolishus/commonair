// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The incoming-raid alert for moderators and the broadcaster (ux-journeys J5-c; mockup
 * `mod-view.html?state=raid`): who is raiding, with how many verified viewers, and two quick
 * defences, followers-only (followed at least 10 minutes ago) and slow mode. Nothing is automatic:
 * a moderator chooses, and dismisses the alert when the room has settled.
 */
import { IconButton, ViewerCount } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Cancel01Icon, Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ChatEventView } from "../events.ts";
import {
  RAID_FOLLOWER_MINUTES,
  RAID_SLOW_SECONDS,
  durationLabel,
  followersCommand,
  slowCommand,
  type ChatCommand,
} from "../modes.ts";

/** An arrived raid, from the `channel.raid` event. */
export interface IncomingRaid {
  /** Distinguishes two raids by the same channel. */
  id: string;
  login: string;
  name: string;
  /** Integrity-verified viewers (the event's `viewers`). */
  viewers: number;
}

/** The alert's raid from a `channel.raid` chat event; null for any other event. */
export function incomingRaidOf(id: string, event: ChatEventView): IncomingRaid | null {
  if (event.type !== "channel.raid") return null;
  return { id, login: event.user, name: event.name ?? event.user, viewers: event.viewers ?? 0 };
}

export interface RaidAlertProps {
  raid: IncomingRaid;
  onCommand: (command: ChatCommand) => boolean;
  onDismiss: () => void;
  /** Followers-only or slow mode already on: that button says so and stays pressed. */
  followersOn: boolean;
  slowOn: boolean;
}

export function RaidAlert({ raid, onCommand, onDismiss, followersOn, slowOn }: RaidAlertProps): React.JSX.Element {
  const send = (command: ChatCommand) => {
    if (!onCommand(command)) toast.error(t("chat.notConnected"));
  };
  return (
    <section
      role="alert"
      data-testid="chat-raid-alert"
      data-from={raid.login}
      data-viewers={raid.viewers}
      className="flex min-w-0 flex-wrap items-center gap-2 border-s-2 border-channel-accent px-2 py-1.5 text-xs"
    >
      <HugeiconsIcon
        icon={Rocket01Icon}
        strokeWidth={2}
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="break-words font-semibold">{t("d4Chat.raid.title", { channel: raid.name })}</p>
        <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
          <ViewerCount
            count={raid.viewers}
            size="sm"
            label={(formatted, count) => t("d4Chat.raid.viewers", { count, formatted })}
          />
          <span aria-hidden>{t("d4Chat.raid.verified")}</span>
          <span>{t("d4Chat.raid.hint")}</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="chat-raid-followers"
          aria-pressed={followersOn}
          onClick={() => send(followersCommand(RAID_FOLLOWER_MINUTES))}
        >
          {t("d4Chat.raid.followers", { duration: durationLabel(RAID_FOLLOWER_MINUTES * 60) })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="chat-raid-slow"
          aria-pressed={slowOn}
          onClick={() => send(slowCommand(RAID_SLOW_SECONDS))}
        >
          {t("d4Chat.raid.slow", { duration: durationLabel(RAID_SLOW_SECONDS) })}
        </Button>
        <IconButton
          size="icon-xs"
          icon={Cancel01Icon}
          label={t("d4Chat.raid.dismiss")}
          data-testid="chat-raid-dismiss"
          onClick={onDismiss}
        />
      </div>
    </section>
  );
}
