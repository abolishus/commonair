// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's remote followers (ADR 0030 decision 6): handle and server as plain text (never a
 * link, never a remote avatar: AGENTS.md rule 4 forbids third-party loads), when they followed,
 * paged, and a confirmed "Remove" that deletes the row and stops delivery to them.
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { FieldDescription } from "@commonair/ui/components/field";
import { toast } from "@commonair/ui/toast";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { FormError } from "../form-error.tsx";
import { followerLabel, type FederationClient, type FederationFollowerDto } from "./client.ts";

export interface FederationFollowersProps {
  channel: string;
  client: FederationClient;
  /** The channel's handle, for the empty state ("people can follow @slug@domain"). */
  handle: string | null;
  /** Called after a follower is removed (the section's count goes down). */
  onRemoved?: () => void;
}

export function FederationFollowers({
  channel,
  client,
  handle,
  onRemoved,
}: FederationFollowersProps): React.JSX.Element {
  const [items, setItems] = React.useState<FederationFollowerDto[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const headingId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    client
      .followers(channel, null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, [client, channel]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.followers(channel, cursor);
      // A follower removed meanwhile can shift the pages; never list one twice.
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((f) => f.id));
        return [...(prev ?? []), ...page.items.filter((f) => !seen.has(f.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      toastActionError(err, t("federation.followers.loadMoreFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (f: FederationFollowerDto) => {
    await client.removeFollower(channel, f.id);
    setItems((prev) => prev?.filter((x) => x.id !== f.id) ?? prev);
    onRemoved?.();
    toast.success(t("federation.followers.removed"));
  };

  return (
    <section data-testid="federation-followers" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id={headingId} className="text-sm font-medium">
          {t("federation.followers.title")}
        </h3>
        <FieldDescription data-testid="federation-followers-intro">{t("federation.followers.intro")}</FieldDescription>
      </div>
      {loadFailed ? (
        <FormError>{t("federation.followers.loadFailed")}</FormError>
      ) : items === null ? (
        <SkeletonGroup label={t("federation.followers.loading")}>
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : items.length === 0 ? (
        <EmptyState
          icon={UserGroupIcon}
          headingLevel={4}
          title={t("federation.followers.empty")}
          description={
            handle ? t("federation.followers.emptyHint", { handle }) : t("federation.followers.emptyHintOff")
          }
        />
      ) : (
        <ul className="flex min-w-0 flex-col divide-y" aria-labelledby={headingId}>
          {items.map((f) => (
            <FollowerRow key={f.id} follower={f} onRemove={() => remove(f)} />
          ))}
        </ul>
      )}
      {items !== null && cursor !== null && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="federation-followers-more"
          disabled={loadingMore}
          aria-busy={loadingMore || undefined}
          onClick={() => void loadMore()}
        >
          {t("federation.followers.more")}
        </Button>
      )}
    </section>
  );
}

function FollowerRow({
  follower,
  onRemove,
}: {
  follower: FederationFollowerDto;
  onRemove: () => Promise<void>;
}): React.JSX.Element {
  const label = followerLabel(follower);
  return (
    <li
      data-testid="federation-follower"
      data-follower-id={follower.id}
      data-actor={follower.actor}
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Remote text, shown as text: never a link that would load their server. */}
        <span className="min-w-0 break-all font-medium">{label}</span>
        <span className="min-w-0 break-all text-sm text-muted-foreground">
          {t("federation.followers.server", { domain: follower.domain })}
          {" · "}
          {t("federation.followers.since")} <RelativeTime date={follower.createdAt} />
        </span>
      </div>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="federation-follower-remove"
            aria-label={t("federation.followers.removeLabel", { handle: label })}
          >
            {t("federation.followers.remove")}
          </Button>
        }
        title={t("federation.followers.removeTitle")}
        description={t("federation.followers.removeBody", { handle: label })}
        confirmLabel={t("federation.followers.remove")}
        variant="destructive"
        onConfirm={onRemove}
        onError={(err) => toastActionError(err, t("federation.followers.removeFailed"))}
      />
    </li>
  );
}
