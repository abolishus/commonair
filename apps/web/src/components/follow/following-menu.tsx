// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Following split button (README D4.3, round 2: "split into a bell and a menu"; the mockups'
 * `?state=following` and `menu`). A bell `IconButton` turns the follow's go-live alerts on or
 * off (`channels.follow {notify}`); the "Following" menu holds the alert level, "Email me once if
 * {channel} moves" (the portability grant, ADR 0037) and Unfollow behind a `ConfirmDialog`.
 * Following is an outline: Support takes the screen's fill. Menu actions count as
 * `watch.followMenu` (accept = alerts on, decline = off, email = the move grant, confirm = unfollow).
 */
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
import {
  ArrowDown01Icon,
  Notification03Icon,
  NotificationOff01Icon,
  UserRemove01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { useFollowGrant, type SetGrant } from "../portability/grants.tsx";
import type { FollowNotify } from "./notify.ts";

export interface FollowingControlsProps {
  channel: { slug: string; name: string };
  notify: FollowNotify;
  /** `Channel.viewer.portabilityGrant`; absent: the page cannot say, so the item is left out. */
  portabilityGrant?: boolean | undefined;
  /** An unfollow or follow is in flight. */
  pending: boolean;
  onUnfollow: () => void;
  /** The "Following" menu trigger (focus target after the first-follow prompt). */
  triggerRef?: React.Ref<HTMLButtonElement>;
  setGrant?: SetGrant;
}

export function FollowingControls({
  channel,
  notify,
  portabilityGrant,
  pending,
  onUnfollow,
  triggerRef,
  setGrant,
}: FollowingControlsProps): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const on = notify.notify !== false;
  const setAlerts = (next: boolean) => {
    if (notify.notify === next) return;
    trackUi("watch.followMenu", "click", next ? "accept" : "decline");
    notify.set(next);
  };
  return (
    <span data-slot="following-split" className="inline-flex items-center">
      <IconButton
        data-testid="follow-bell"
        data-notify={notify.notify === null ? "unknown" : String(notify.notify)}
        variant="outline"
        size="icon-sm"
        icon={on ? Notification03Icon : NotificationOff01Icon}
        label={t("d4Follow.bell.label", { channel: channel.name })}
        tooltip={on ? t("d4Follow.bell.onTooltip") : t("d4Follow.bell.offTooltip")}
        tooltipSide="bottom"
        aria-pressed={notify.notify === null ? undefined : on}
        disabled={notify.notify === null || notify.pending}
        aria-busy={notify.pending || undefined}
        className="-me-px"
        onClick={() => setAlerts(!on)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={triggerRef}
              data-testid="follow-button"
              data-following="true"
              variant="outline"
              size="sm"
              aria-label={t("d4Follow.menu.label", { channel: channel.name })}
              aria-busy={pending || undefined}
              disabled={pending}
            />
          }
        >
          {t("follow.following")}
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent data-testid="follow-menu" align="end" className="w-auto min-w-64 max-w-viewport-4">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("d4Follow.menu.alertsHeading")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              data-testid="follow-menu-alerts"
              value={notify.notify === null ? "" : on ? "all" : "off"}
              onValueChange={(value: unknown) => setAlerts(value === "all")}
            >
              <DropdownMenuRadioItem
                data-testid="follow-menu-alerts-all"
                value="all"
                disabled={notify.notify === null || notify.pending}
              >
                {t("d4Follow.menu.alertsAll")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                data-testid="follow-menu-alerts-off"
                value="off"
                disabled={notify.notify === null || notify.pending}
              >
                <span className="flex flex-col">
                  <span>{t("d4Follow.menu.alertsOff")}</span>
                  <span className="text-muted-foreground">{t("d4Follow.menu.alertsOffHint")}</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {typeof portabilityGrant === "boolean" ? (
            <>
              <DropdownMenuSeparator />
              <MoveGrantItem
                // A new polled value is a new state.
                key={`${channel.slug}:${String(portabilityGrant)}`}
                channel={channel}
                initial={portabilityGrant}
                setGrant={setGrant}
              />
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="follow-menu-unfollow"
            variant="destructive"
            disabled={pending}
            onClick={() => setConfirmOpen(true)}
          >
            <HugeiconsIcon icon={UserRemove01Icon} strokeWidth={2} aria-hidden />
            {t("d4Follow.menu.unfollow")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("d4Follow.unfollow.title", { channel: channel.name })}
        description={t("d4Follow.unfollow.body")}
        confirmLabel={t("d4Follow.unfollow.confirm")}
        variant="destructive"
        contentProps={{ "data-testid": "follow-unfollow-dialog" }}
        onConfirm={() => {
          trackUi("watch.followMenu", "confirm", "none");
          onUnfollow();
        }}
      />
    </span>
  );
}

function MoveGrantItem({
  channel,
  initial,
  setGrant,
}: {
  channel: { slug: string; name: string };
  initial: boolean;
  setGrant?: SetGrant | undefined;
}): React.JSX.Element {
  const grant = useFollowGrant(channel.slug, initial, setGrant);
  return (
    <DropdownMenuCheckboxItem
      data-testid="follow-menu-move"
      checked={grant.on}
      disabled={grant.busy}
      aria-busy={grant.busy || undefined}
      onCheckedChange={(next: boolean) => {
        trackUi("watch.followMenu", "click", "email");
        grant.set(next);
      }}
    >
      {t("d4Follow.menu.move", { channel: channel.name })}
    </DropdownMenuCheckboxItem>
  );
}
