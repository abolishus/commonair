// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, MoneyAmount, RelativeTime } from "@commonair/ui";
import {
  Agreement01Icon,
  Download04Icon,
  Flag02Icon,
  InformationCircleIcon,
  LiveStreaming02Icon,
  Money03Icon,
  Rocket01Icon,
  Shield01Icon,
  UserGroupIcon,
  UserStar01Icon,
  Video01Icon,
  VoteIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  type NotificationDto,
  type NotificationTarget,
  type NotificationType,
  describeNotification,
} from "../../lib/notifications.ts";

/** A distinct glyph per type (overhaul wave 4, D7.3; account-admin.md AA-13). */
const TYPE_ICON: Record<NotificationType, typeof VoteIcon> = {
  go_live: LiveStreaming02Icon,
  raid: Rocket01Icon,
  proposal: Agreement01Icon,
  vote_open: VoteIcon,
  export_ready: Download04Icon,
  payout: Money03Icon,
  moderation: Shield01Icon,
  system: InformationCircleIcon,
  membership: UserGroupIcon,
  vod_ready: Video01Icon,
  report_outcome: Flag02Icon,
  moderator_added: UserStar01Icon,
};

const ROW = "flex min-w-0 items-start gap-3 px-3 py-2.5 text-start";
const LINK = `${ROW} outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset`;

/** One item's link: a typed route per target, never a URL taken from the payload. */
function TargetLink({
  target,
  onOpen,
  children,
}: {
  target: NotificationTarget;
  onOpen: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  switch (target.kind) {
    case "channel":
      return (
        <Link
          data-testid="notification-item-link"
          to="/$channel"
          params={{ channel: target.slug }}
          className={LINK}
          onClick={onOpen}
        >
          {children}
        </Link>
      );
    case "mod":
      return (
        <Link
          data-testid="notification-item-link"
          to="/mod/$channel"
          params={{ channel: target.slug }}
          className={LINK}
          onClick={onOpen}
        >
          {children}
        </Link>
      );
    case "proposal":
      return (
        <Link
          data-testid="notification-item-link"
          to="/coop/proposals/$id"
          params={{ id: target.id }}
          className={LINK}
          onClick={onOpen}
        >
          {children}
        </Link>
      );
    case "appeals":
      return (
        <Link data-testid="notification-item-link" to="/settings/appeals" className={LINK} onClick={onOpen}>
          {children}
        </Link>
      );
    case "privacy":
      return (
        <Link data-testid="notification-item-link" to="/settings/privacy" className={LINK} onClick={onOpen}>
          {children}
        </Link>
      );
    case "membership":
      return (
        <Link data-testid="notification-item-link" to="/coop/membership" className={LINK} onClick={onOpen}>
          {children}
        </Link>
      );
    case "dashboard":
      return (
        <Link data-testid="notification-item-link" to="/dashboard" className={LINK} onClick={onOpen}>
          {children}
        </Link>
      );
    case "vod":
      return (
        <Link
          data-testid="notification-item-link"
          to="/$channel/vods/$vodId"
          params={{ channel: target.slug, vodId: target.id }}
          className={LINK}
          onClick={onOpen}
        >
          {children}
        </Link>
      );
  }
}

export interface NotificationItemProps {
  notification: NotificationDto;
  /** The item's link was followed: mark it read and close the popover. */
  onOpen: () => void;
}

/** One notification: what happened, when, and where it leads. Payload text is plain React text. */
export function NotificationItem({ notification: n, onOpen }: NotificationItemProps): React.JSX.Element {
  const view = describeNotification(n);
  const unread = n.readAt === null;
  const body = (
    <>
      {view.kind === "go_live" ? (
        <ChannelAvatar name={view.name} src={view.avatarUrl} size="sm" decorative className="shrink-0" />
      ) : (
        <span
          data-testid="notification-item-icon"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <HugeiconsIcon icon={TYPE_ICON[n.type]} strokeWidth={2} aria-hidden className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={unread ? "font-medium text-foreground" : "text-muted-foreground"}>
          {view.kind === "go_live" ? t("notifications.goLive", { channel: view.name }) : t(view.label)}
        </span>
        {view.kind === "go_live" && view.title !== "" && (
          <span className="truncate text-muted-foreground">{view.title}</span>
        )}
        {view.kind === "generic" && view.context?.kind === "text" && (
          <span data-testid="notification-item-context" className="truncate text-muted-foreground">
            {view.context.text}
          </span>
        )}
        {view.kind === "generic" && view.context?.kind === "money" && (
          <span data-testid="notification-item-context" className="text-muted-foreground">
            <MoneyAmount value={{ cents: view.context.cents, currency: view.context.currency }} />
          </span>
        )}
        <RelativeTime date={n.createdAt} tooltip={false} className="text-2xs text-muted-foreground" />
      </span>
      {unread && (
        <span className="mt-1.5 flex size-2 shrink-0 rounded-full bg-primary">
          <span className="sr-only">{t("notifications.unread")}</span>
        </span>
      )}
    </>
  );
  return (
    <li
      data-testid="notification-item"
      data-id={n.id}
      data-type={n.type}
      data-state={unread ? "unread" : "read"}
      className="min-w-0"
    >
      {view.target ? (
        <TargetLink target={view.target} onOpen={onOpen}>
          {body}
        </TargetLink>
      ) : (
        <div className={ROW}>{body}</div>
      )}
    </li>
  );
}
