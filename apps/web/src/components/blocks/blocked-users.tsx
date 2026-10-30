// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, EmptyState, RelativeTime, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { toast } from "@commonair/ui/toast";
import { UnavailableIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { noteUnblocked } from "../../chat/blocks.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { fillNode } from "../../lib/fill.tsx";
import { usePaged, type Page } from "../money/use-load.ts";

export interface BlockedUserDto {
  user: { id: string; username: string; displayName: string };
  createdAt: string;
}

export interface BlockedUsersClient {
  list(cursor: string | undefined): Promise<Page<BlockedUserDto>>;
  remove(username: string): Promise<unknown>;
}

const PAGE = 25;

// Inside `then`, so a client that cannot reach the API rejects instead of throwing during render.
export const blockedUsersClient = (): BlockedUsersClient => ({
  list: (cursor) => Promise.resolve().then(() => api().me.blocks.list({ limit: PAGE, cursor })),
  remove: (username) => Promise.resolve().then(() => api().me.blocks.remove({ username })),
});

/**
 * The viewer's blocked users on `/settings/privacy` (ADR 0012 amendment 1 decision 8): newest
 * first, paged, each with Unblock. An unblock also shows the person again in this tab's chat at
 * once.
 */
export function BlockedUsers({ client: clientProp }: { client?: BlockedUsersClient } = {}): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? blockedUsersClient());
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = React.useState<string | null>(null);
  const paged = usePaged(
    "blocks",
    (cursor) => client.list(cursor),
    (err) => toastActionError(err, t("blocks.loadFailed")),
  );
  const items = paged.items?.filter((b) => !removed.has(b.user.id)) ?? null;

  const unblock = async (b: BlockedUserDto) => {
    setPending(b.user.id);
    try {
      await client.remove(b.user.username);
      setRemoved((prev) => new Set([...prev, b.user.id]));
      noteUnblocked(b.user);
      toast.success(t("blocks.unblocked", { name: b.user.displayName }));
    } catch (err) {
      toastActionError(err, t("blocks.unblockFailed"));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card data-testid="blocked-users" className="min-w-0">
      <CardHeader>
        <CardTitle>{t("blocks.title")}</CardTitle>
        <CardDescription>{t("blocks.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {paged.failed && items === null ? (
          <AlertCallout
            tone="danger"
            live
            description={t("blocks.loadFailed")}
            action={
              <Button type="button" variant="outline" size="sm" onClick={paged.reload}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : items === null ? (
          <SkeletonGroup>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : items.length === 0 ? (
          <EmptyState
            icon={UnavailableIcon}
            title={t("blocks.empty")}
            description={t("blocks.emptyHint")}
            headingLevel={3}
          />
        ) : (
          <ul aria-label={t("blocks.list")} className="flex flex-col divide-y divide-border">
            {items.map((b) => (
              <li
                key={b.user.id}
                data-testid="blocked-user"
                data-username={b.user.username}
                className="flex min-w-0 items-center gap-3 py-2"
              >
                <ChannelAvatar name={b.user.displayName} size="sm" decorative />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{b.user.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    @{b.user.username} ·{" "}
                    {fillNode(t("blocks.since"), "time", <RelativeTime date={b.createdAt} live={false} />)}
                  </span>
                </div>
                <Button
                  data-testid="blocked-user-remove"
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t("blocks.unblockLabel", { name: b.user.displayName })}
                  disabled={pending === b.user.id}
                  aria-busy={pending === b.user.id || undefined}
                  onClick={() => void unblock(b)}
                >
                  {t("blocks.unblock")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {items !== null && paged.hasMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={paged.loadingMore}
            onClick={paged.loadMore}
          >
            {t("blocks.more")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
