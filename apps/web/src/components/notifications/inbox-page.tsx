// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/inbox` (overhaul wave 4, D7.3; account-admin.md P5): every notification, grouped Today / This
 * week / Earlier, with filter chips (All, Live, Co-op, Account), mark all read and paging. The
 * popover behind the bell links here ("See all"). Opening the page never marks anything read.
 */
import { EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";
import { toast } from "@commonair/ui/toast";
import { InboxIcon, Search01Icon, Settings02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import {
  INBOX_FILTER_TYPES,
  type InboxClient,
  type InboxFilter,
  type InboxGroup,
  type NotificationDto,
  type NotificationPage,
  appendPage,
  groupInbox,
  inboxClient,
  isInboxFilter,
  markItemsRead,
} from "../../lib/notifications.ts";
import { objectKey, useRetryingLoad, type LoadState } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { NotificationItem } from "./item.tsx";

const GROUP_LABEL: Record<InboxGroup, MessageKey> = {
  today: "d7Notify.inbox.group.today",
  week: "d7Notify.inbox.group.week",
  earlier: "d7Notify.inbox.group.earlier",
};

export interface InboxPageProps {
  /** Tests pass a fixture client; the app uses the API. */
  client?: InboxClient;
  /** The clock the groups use (tests pin it). */
  now?: () => Date;
}

export function InboxPage({ client: given, now = () => new Date() }: InboxPageProps): React.JSX.Element {
  const client = React.useMemo(() => given ?? inboxClient(), [given]);
  const [filter, setFilter] = React.useState<InboxFilter>("all");
  React.useEffect(() => {
    trackUi("inbox", "view");
  }, []);
  const types = INBOX_FILTER_TYPES[filter];
  const first = useRetryingLoad(`inbox-page|${filter}|${objectKey(client)}`, () =>
    client.list(null, types ?? undefined),
  );
  const [items, setItems] = React.useState<NotificationDto[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<NotificationPage | null>(null);
  const [more, setMore] = React.useState(false);
  const [marking, setMarking] = React.useState(false);
  if (first.data !== null && first.data !== shown) {
    setShown(first.data);
    setItems(first.data.items);
    setCursor(first.data.nextCursor);
  }
  const load: LoadState =
    first.data !== null && first.data === shown ? "loaded" : first.state === "failed" ? "failed" : "loading";

  const choose = (next: InboxFilter) => {
    if (next === filter) return;
    setFilter(next);
    trackUi("inbox", "click");
  };

  const loadMore = async () => {
    if (cursor === null || more) return;
    setMore(true);
    try {
      const page = await client.list(cursor, types ?? undefined);
      setItems((list) => appendPage(list, page.items));
      setCursor(page.nextCursor);
    } catch {
      toast.error(t("d7Notify.inbox.loadMoreFailed"));
    } finally {
      setMore(false);
    }
  };

  const readOne = (n: NotificationDto) => {
    if (n.readAt !== null) return;
    setItems((list) => markItemsRead(list, [n.id], new Date().toISOString()));
    // The navigation goes ahead either way; a failed mark leaves it unread for next time.
    client.markRead([n.id]).catch(() => undefined);
  };

  const readAll = async () => {
    setMarking(true);
    try {
      await client.markRead();
      setItems((list) => markItemsRead(list, null, new Date().toISOString()));
    } catch {
      toast.error(t("notifications.markFailed"));
    } finally {
      setMarking(false);
    }
  };

  const groups = groupInbox(items, now());

  return (
    <div data-testid="inbox-page" className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={t("d7Notify.inbox.title")}
        description={t("d7Notify.inbox.intro")}
        actions={
          <>
            <Button
              data-testid="inbox-mark-all-read"
              variant="outline"
              disabled={marking || load !== "loaded" || items.every((n) => n.readAt !== null)}
              onClick={() => void readAll()}
            >
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
              {t("notifications.markAllRead")}
            </Button>
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link data-testid="inbox-settings-link" to="/settings/notifications" />}
            >
              <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
              {t("d7Notify.inbox.settings")}
            </Button>
          </>
        }
      />
      <ToggleGroup
        data-testid="inbox-filters"
        aria-label={t("d7Notify.inbox.filters")}
        variant="outline"
        size="sm"
        spacing={0}
        multiple={false}
        value={[filter]}
        className="flex-wrap"
        onValueChange={(values) => {
          const next = values.at(-1);
          if (isInboxFilter(next)) choose(next);
        }}
      >
        <ToggleGroupItem data-testid="inbox-filter-all" value="all">
          {t("d7Notify.inbox.filter.all")}
        </ToggleGroupItem>
        <ToggleGroupItem data-testid="inbox-filter-live" value="live">
          {t("d7Notify.inbox.filter.live")}
        </ToggleGroupItem>
        <ToggleGroupItem data-testid="inbox-filter-coop" value="coop">
          {t("d7Notify.inbox.filter.coop")}
        </ToggleGroupItem>
        <ToggleGroupItem data-testid="inbox-filter-account" value="account">
          {t("d7Notify.inbox.filter.account")}
        </ToggleGroupItem>
      </ToggleGroup>
      {load === "loading" ? (
        <SkeletonGroup label={t("notifications.loading")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      ) : load === "failed" ? (
        <SectionLoadError
          data-testid="inbox-load-error"
          retryTestId="inbox-retry"
          section={t("d7Notify.inbox.title")}
          load={first}
          alone
          headingLevel={2}
        />
      ) : items.length === 0 ? (
        filter === "all" ? (
          <EmptyState
            data-testid="inbox-empty"
            icon={InboxIcon}
            title={t("d7Notify.inbox.empty")}
            description={t("d7Notify.inbox.emptyBody")}
            headingLevel={2}
            action={
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link data-testid="inbox-empty-directory" to="/directory" />}
              >
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                {t("d7Notify.inbox.emptyAction")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            data-testid="inbox-empty-filtered"
            icon={InboxIcon}
            title={t("d7Notify.inbox.emptyFiltered")}
            description={t("d7Notify.inbox.emptyFilteredBody")}
            headingLevel={2}
            action={
              <Button data-testid="inbox-show-all" variant="outline" onClick={() => choose("all")}>
                {t("d7Notify.inbox.showAll")}
              </Button>
            }
          />
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map((g) => (
            <section
              key={`${g.group}-${g.items[0]?.id ?? ""}`}
              data-testid="inbox-group"
              data-group={g.group}
              aria-labelledby={`inbox-group-${g.group}`}
              className="flex min-w-0 flex-col gap-2"
            >
              <h2 id={`inbox-group-${g.group}`} className="text-sm font-medium text-muted-foreground">
                {t(GROUP_LABEL[g.group])}
              </h2>
              <ul className="flex min-w-0 flex-col divide-y divide-border border-y border-border">
                {g.items.map((n) => (
                  <NotificationItem key={n.id} notification={n} onOpen={() => readOne(n)} />
                ))}
              </ul>
            </section>
          ))}
          {cursor !== null && (
            <Button
              data-testid="inbox-load-more"
              variant="outline"
              className="self-center"
              disabled={more}
              onClick={() => void loadMore()}
            >
              {t("notifications.loadMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
