// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ChannelAvatar,
  ConfirmDialog,
  EmptyState,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
} from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@commonair/ui/components/item";
import { CancelCircleIcon, GiftIcon, StarIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  SUBSCRIPTION_STATUS_VIEW,
  canCancel,
  periodEndKey,
  sortSubscriptions,
  supportText,
  type SubscriptionDto,
} from "../../lib/support.ts";

/** What a row shows of its channel; the subscription itself carries only the slug. */
export interface SubscriptionChannel {
  displayName: string;
  avatarUrl: string | null;
}

/**
 * F38: the channel as people know it, its display name, with `@slug` beside it; the slug alone
 * until (or unless) the channel's name has loaded.
 */
export function subscriptionChannelName(
  slug: string,
  channels: ReadonlyMap<string, SubscriptionChannel> | undefined,
): { name: string; handle: string | null } {
  const name = channels?.get(slug)?.displayName.trim();
  return name ? { name, handle: `@${slug}` } : { name: slug, handle: null };
}

export interface SubscriptionListProps {
  /** Null while loading. */
  subscriptions: readonly SubscriptionDto[] | null;
  /** Display names and avatars by channel slug (F38). */
  channels?: ReadonlyMap<string, SubscriptionChannel>;
  onCancel: (subscription: SubscriptionDto) => Promise<void>;
  onCancelError: (err: unknown) => void;
}

/** `/settings/subscriptions`: one `subscription-row` per subscription, or `subscriptions-empty`. */
export function SubscriptionList({
  subscriptions,
  channels,
  onCancel,
  onCancelError,
}: SubscriptionListProps): React.JSX.Element {
  if (subscriptions === null)
    return (
      <SkeletonGroup label={t("subscriptions.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (subscriptions.length === 0)
    return (
      <EmptyState
        data-testid="subscriptions-empty"
        icon={StarIcon}
        title={t("subscriptions.empty")}
        description={t("subscriptions.emptyHint")}
      />
    );
  return (
    <ItemGroup>
      {sortSubscriptions(subscriptions).map((s) => {
        const status = SUBSCRIPTION_STATUS_VIEW[s.status];
        const channel = subscriptionChannelName(s.channelSlug, channels);
        return (
          <Item
            key={s.id}
            variant="outline"
            data-testid="subscription-row"
            data-subscription-id={s.id}
            data-channel={s.channelSlug}
            data-tier={s.tier}
            data-status={s.status}
            data-gifted={s.gifted ? "true" : "false"}
            data-cancel-at-period-end={s.cancelAtPeriodEnd ? "true" : "false"}
            className="flex-wrap"
          >
            <ItemMedia>
              <ChannelAvatar
                name={channel.name}
                src={channels?.get(s.channelSlug)?.avatarUrl ?? null}
                size="md"
                decorative
              />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <Button
                  variant="link"
                  size="xs"
                  nativeButton={false}
                  data-testid="subscription-channel"
                  render={<Link to="/$channel" params={{ channel: s.channelSlug }} />}
                >
                  {channel.name}
                </Button>
                {channel.handle && (
                  <span className="truncate text-xs font-normal text-muted-foreground">{channel.handle}</span>
                )}
              </ItemTitle>
              <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{t("subscriptions.tier", { tier: s.tier })}</span>
                {s.gifted && (
                  <StatusBadge tone="accent" icon={GiftIcon}>
                    {t("subscriptions.gifted")}
                  </StatusBadge>
                )}
                {s.currentPeriodEnd && (
                  <span>
                    {supportText(periodEndKey(s))} <RelativeTime date={s.currentPeriodEnd} />
                  </span>
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="flex-wrap">
              <StatusBadge tone={status.tone}>{supportText(status.key)}</StatusBadge>
              {s.cancelAtPeriodEnd && s.status === "active" && (
                <StatusBadge tone="warning">{t("subscriptions.cancelling")}</StatusBadge>
              )}
              {canCancel(s) && (
                <ConfirmDialog
                  trigger={
                    <Button data-testid="subscription-cancel" variant="outline" size="sm">
                      {t("subscriptions.cancel")}
                    </Button>
                  }
                  variant="destructive"
                  icon={CancelCircleIcon}
                  title={t("subscriptions.cancelTitle", { channel: channel.name })}
                  description={t("subscriptions.cancelBody")}
                  confirmLabel={t("subscriptions.cancelConfirm")}
                  onConfirm={() => onCancel(s)}
                  onError={onCancelError}
                />
              )}
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
