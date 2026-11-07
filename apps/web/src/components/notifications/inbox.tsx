// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Notification03Icon, Settings02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  type InboxClient,
  type NotificationDto,
  type NotificationPage,
  appendPage,
  markItemsRead,
} from "../../lib/notifications.ts";
import { objectKey, useRetryingLoad, type LoadState } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { NotificationItem } from "./item.tsx";

export interface NotificationInboxProps {
  client: InboxClient;
  /** One item was read (the badge counts one down). */
  onReadOne: () => void;
  /** Everything was read. */
  onReadAll: () => void;
  /** Ask the API for the count again (after a failure). */
  onRefreshCount: () => void;
  /** An item or the settings link was followed: the popover closes. */
  onNavigate: () => void;
}

/** The popover body: newest 20, load more, mark all read, settings link. Opening never marks read. */
export function NotificationInbox({
  client,
  onReadOne,
  onReadAll,
  onRefreshCount,
  onNavigate,
}: NotificationInboxProps): React.JSX.Element {
  // The first page retries by itself on a busy API and has its own Retry (F3).
  const first = useRetryingLoad(`inbox|${objectKey(client)}`, () => client.list(null));
  const [items, setItems] = React.useState<NotificationDto[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<NotificationPage | null>(null);
  const [more, setMore] = React.useState(false);
  const [marking, setMarking] = React.useState(false);
  // A new first page replaces the list during render, so it never flashes the empty state.
  if (first.data !== null && first.data !== shown) {
    setShown(first.data);
    setItems(first.data.items);
    setCursor(first.data.nextCursor);
  }
  const load: LoadState =
    first.data !== null && first.data === shown ? "loaded" : first.state === "failed" ? "failed" : "loading";

  const loadMore = async () => {
    if (cursor === null || more) return;
    setMore(true);
    try {
      const page = await client.list(cursor);
      setItems((list) => appendPage(list, page.items));
      setCursor(page.nextCursor);
    } catch {
      toast.error(t("notifications.loadFailed"));
    } finally {
      setMore(false);
    }
  };

  const readOne = (n: NotificationDto) => {
    if (n.readAt !== null) return;
    setItems((list) => markItemsRead(list, [n.id], new Date().toISOString()));
    onReadOne();
    // The navigation goes ahead either way; a failed mark leaves it unread on the next open.
    client.markRead([n.id]).catch(() => onRefreshCount());
  };

  const readAll = async () => {
    setMarking(true);
    try {
      await client.markRead();
      setItems((list) => markItemsRead(list, null, new Date().toISOString()));
      onReadAll();
    } catch {
      toast.error(t("notifications.markFailed"));
      onRefreshCount();
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col">
      {load === "loading" ? (
        <SkeletonGroup label={t("notifications.loading")} className="px-3 pb-3">
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : load === "failed" ? (
        <div className="px-3 pb-3">
          <SectionLoadError
            data-testid="notification-load-error"
            retryTestId="notification-retry"
            section={t("notifications.title")}
            load={first}
            alone
            headingLevel={3}
          />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          data-testid="notification-empty"
          icon={Notification03Icon}
          title={t("notifications.empty")}
          description={t("notifications.emptyBody")}
          headingLevel={3}
        />
      ) : (
        <ul
          data-testid="notification-list"
          aria-label={t("notifications.title")}
          className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto border-y border-border"
        >
          {items.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              onOpen={() => {
                readOne(n);
                onNavigate();
              }}
            />
          ))}
        </ul>
      )}
      {cursor !== null && load === "loaded" && (
        <Button
          data-testid="notification-load-more"
          variant="ghost"
          size="sm"
          className="mx-3 mt-2"
          disabled={more}
          onClick={() => void loadMore()}
        >
          {t("notifications.loadMore")}
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2">
        <Button
          data-testid="notification-mark-all-read"
          variant="ghost"
          size="sm"
          // Not tied to the loaded page: an unread row can sit beyond it.
          disabled={marking || load !== "loaded" || items.length === 0}
          onClick={() => void readAll()}
        >
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("notifications.markAllRead")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link data-testid="notification-settings-link" to="/settings/notifications" onClick={onNavigate} />}
        >
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("notifications.settings")}
        </Button>
      </div>
    </div>
  );
}
