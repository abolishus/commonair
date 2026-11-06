// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stream manager's activity feed (F21): follows, subs, gifts, tips, raids and giveaway results
 * as they happen, from the channel's chat socket (`op:"event"` frames; `activity.ts` parses them).
 * It listens on its own connection, signed in as the streamer, so the follows (sent only to the
 * broadcaster and moderators) reach it, and it needs nothing from the chat panel beside it. The feed starts empty on
 * each visit: the socket has no history, and the page never invents activity to look busy.
 */
import { EmptyState, MoneyAmount, RelativeTime } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Activity01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { ChatConnection } from "../../chat/connection.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { activityFromEvent, pushActivity, type ActivityItem } from "./activity.ts";

/** Subscribes `onEvent` to the channel's platform events; returns the unsubscribe. */
export type ActivitySource = (channel: string, onEvent: (type: string, data: unknown) => void) => () => void;

const noop = () => undefined;

/** The chat socket as an event source (no messages are kept; only `op:"event"` frames are used). */
export const chatActivitySource: ActivitySource = (channel, onEvent) => {
  const conn = new ChatConnection(
    channel,
    { getToken: () => api().chat.connectToken(), createSocket: (url) => new WebSocket(url) },
    {
      onStatus: noop,
      onJoined: noop,
      onMessage: noop,
      onDelete: noop,
      onClear: noop,
      onNotice: noop,
      onEvent: (type, data) => onEvent(type, data),
    },
  );
  conn.start();
  return () => conn.stop();
};

export function ActivityText({ item }: { item: ActivityItem }): React.JSX.Element {
  const name = item.name ?? t("studio.activity.anonymous");
  switch (item.kind) {
    case "follow":
      return <>{t("studio.activity.follow", { name })}</>;
    case "subscribe":
      return <>{t("studio.activity.subscribe", { name, tier: item.tier ?? 1 })}</>;
    case "gift":
      return <>{t("studio.activity.gift", { name, count: item.count ?? 1, tier: item.tier ?? 1 })}</>;
    case "tip":
      return (
        <>
          {t("studio.activity.tip", { name })}{" "}
          {item.amount ? (
            <MoneyAmount value={{ cents: item.amount.cents, currency: item.amount.currency }} className="font-medium" />
          ) : null}
        </>
      );
    case "raid":
      return <>{t("studio.activity.raid", { name, count: item.viewers ?? 0 })}</>;
    case "giveaway":
      return (
        <>
          {item.drawn
            ? t("studio.activity.giveawayDrawn", { title: item.title ?? "", count: item.count ?? 0 })
            : t("studio.activity.giveawayCancelled", { title: item.title ?? "" })}
        </>
      );
  }
}

export function ActivityFeed({
  channel,
  source = chatActivitySource,
}: {
  channel: string;
  source?: ActivitySource;
}): React.JSX.Element {
  const [items, setItems] = React.useState<ActivityItem[]>([]);
  React.useEffect(() => {
    // Keyed by channel where it is rendered, so a new channel starts from an empty feed.
    let seq = 0;
    return source(channel, (type, data) => {
      const item = activityFromEvent(type, data, new Date().toISOString(), seq++);
      if (item) setItems((list) => pushActivity(list, item));
    });
  }, [channel, source]);
  return (
    <Card data-testid="stream-activity" data-count={items.length} className="min-w-0">
      <CardHeader>
        <CardTitle>{t("studio.activity.title")}</CardTitle>
        <CardDescription>{t("studio.activity.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState
            data-testid="stream-activity-empty"
            icon={Activity01Icon}
            title={t("studio.activity.empty")}
            description={t("studio.activity.emptyHint")}
            headingLevel={3}
          />
        ) : (
          <ul aria-live="polite" className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid="stream-activity-item"
                data-kind={item.kind}
                className="flex min-w-0 items-baseline justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0 break-words">
                  <ActivityText item={item} />
                </span>
                <RelativeTime date={item.at} className="shrink-0 text-xs text-muted-foreground" />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
