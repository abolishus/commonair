// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Tell me if they move" (ADR 0037 decision 3, batch 7 decision (l)) on `/settings/notifications`: per
 * followed channel, whether the viewer may be emailed **once** if that channel moves. The streamer
 * never sees who asked; the request is deleted after the one email. `FollowGrantToggle` is the
 * same switch for a channel's follow menu.
 */
import { ChannelAvatar, EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import { DeliveryTruck01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import { ListLoadMore, ListSearch, NoMatch, useListWindow } from "../settings/list-window.tsx";

export interface GrantRow {
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  on: boolean;
}

/** Followed channels and the channels with a grant, merged and sorted by name. */
export function grantRows(
  follows: readonly { slug: string; displayName: string; avatarUrl: string | null }[],
  grants: readonly { slug: string; displayName: string; avatarUrl: string | null }[],
): GrantRow[] {
  const rows = new Map<string, GrantRow>();
  for (const f of follows) rows.set(f.slug, { ...f, on: false });
  for (const g of grants) rows.set(g.slug, { ...g, on: true });
  return [...rows.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** `rows` plus the channels of a further follows page it does not have yet (sorted by name again). */
export function withMoreFollows(
  rows: readonly GrantRow[],
  page: readonly { slug: string; displayName: string; avatarUrl: string | null }[],
  grants: readonly { slug: string }[],
): GrantRow[] {
  const known = new Set(rows.map((r) => r.slug));
  const on = new Set(grants.map((g) => g.slug));
  const added = page.filter((c) => !known.has(c.slug)).map((c) => ({ ...c, on: on.has(c.slug) }));
  return [...rows, ...added].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface GrantsViewProps {
  rows: readonly GrantRow[] | null;
  loadFailed: boolean;
  busy: ReadonlySet<string>;
  onToggle: (slug: string, on: boolean) => void;
  /** More followed channels on the server than in `rows`. */
  serverHasMore?: boolean;
  /** Loads the next page of followed channels. */
  onServerMore?: () => void;
  loadingMore?: boolean;
  /**
   * "All on" / "All off" (F36): the channels the search matches, or every channel without a
   * search. Absent: no bulk controls.
   */
  onSetAll?: (on: boolean, scope: { slugs: readonly string[]; everything: boolean }) => void;
  /** A bulk change is running. */
  bulkBusy?: boolean;
}

export function GrantsView({
  rows,
  loadFailed,
  busy,
  onToggle,
  serverHasMore = false,
  onServerMore,
  loadingMore = false,
  onSetAll,
  bulkBusy = false,
}: GrantsViewProps): React.JSX.Element {
  const list = useListWindow(rows, (r) => [r.displayName, r.slug], { serverHasMore, onServerMore });
  const searching = list.query.trim() !== "";
  const bulkHintId = React.useId();
  const scope = { slugs: list.matched.map((r) => r.slug), everything: !searching };
  return (
    <Card data-testid="portability-grants">
      <CardHeader>
        <CardTitle>
          <h2>{t("portability.grants.title")}</h2>
        </CardTitle>
        <CardDescription>{t("portability.grants.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {loadFailed ? (
          <FormError>{t("portability.grants.loadFailed")}</FormError>
        ) : rows === null ? (
          <SkeletonGroup label={t("portability.grants.loading")}>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={DeliveryTruck01Icon}
            headingLevel={3}
            title={t("portability.grants.empty")}
            description={t("portability.grants.emptyHint")}
          />
        ) : (
          <>
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <ListSearch
                data-testid="portability-grants-search"
                label={t("settings.grants.search")}
                value={list.query}
                onValueChange={list.setQuery}
                loadedCount={rows.length}
                partial={serverHasMore}
              />
              {onSetAll && (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="portability-grants-all-on"
                      aria-describedby={bulkHintId}
                      disabled={bulkBusy || loadingMore || scope.slugs.length === 0}
                      aria-busy={bulkBusy || undefined}
                      onClick={() => onSetAll(true, scope)}
                    >
                      {t("settings.grants.allOn")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="portability-grants-all-off"
                      aria-describedby={bulkHintId}
                      disabled={bulkBusy || loadingMore || scope.slugs.length === 0}
                      aria-busy={bulkBusy || undefined}
                      onClick={() => onSetAll(false, scope)}
                    >
                      {t("settings.grants.allOff")}
                    </Button>
                  </div>
                  <p id={bulkHintId} className="text-xs text-muted-foreground">
                    {searching
                      ? t("settings.grants.allScopeSearch", { count: scope.slugs.length })
                      : t("settings.grants.allScopeEvery")}
                  </p>
                </div>
              )}
            </div>
            {list.matched.length === 0 ? (
              <NoMatch query={list.query} />
            ) : (
              <ul className="flex min-w-0 flex-col divide-y" aria-label={t("portability.grants.listLabel")}>
                {list.shown.map((r) => (
                  <li
                    key={r.slug}
                    data-testid="portability-grant"
                    data-channel={r.slug}
                    data-state={r.on ? "on" : "off"}
                    className="flex min-w-0 items-center gap-3 py-2"
                  >
                    <ChannelAvatar name={r.displayName} src={r.avatarUrl} size="sm" decorative />
                    <GrantSwitch row={r} busy={busy.has(r.slug) || bulkBusy} onToggle={onToggle} />
                  </li>
                ))}
              </ul>
            )}
            {list.hasMore && (
              <ListLoadMore data-testid="portability-grants-more" loading={loadingMore} onClick={list.loadMore} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GrantSwitch({
  row,
  busy,
  onToggle,
}: {
  row: GrantRow;
  busy: boolean;
  onToggle: (slug: string, on: boolean) => void;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <Field orientation="horizontal" className="min-w-0 flex-1 justify-between">
      <FieldLabel htmlFor={id} className="min-w-0 break-words font-normal">
        {t("portability.grants.row", { channel: row.displayName })}
      </FieldLabel>
      <Switch
        id={id}
        data-testid="portability-grant-toggle"
        data-state={row.on ? "on" : "off"}
        checked={row.on}
        disabled={busy}
        onCheckedChange={(on: boolean) => onToggle(row.slug, on)}
      />
    </Field>
  );
}

/** Requests a bulk change keeps in flight at once (one per channel; there is no bulk call). */
const BULK_CONCURRENCY = 4;

type FollowPage = Awaited<ReturnType<ReturnType<typeof api>["me"]["follows"]>>;
type FollowChannel = FollowPage["items"][number]["channel"];

/** Runs `task` over `items`, at most `limit` at a time; resolves with the items that failed. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<T[]> {
  const failed: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      try {
        await task(item);
      } catch {
        failed.push(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return failed;
}

/** The `/settings/notifications` section (moved from privacy, F37). */
export function PortabilityGrants(): React.JSX.Element {
  const [granted, setGranted] = React.useState<FollowChannel[]>([]);
  const [rows, setRows] = React.useState<GrantRow[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());

  React.useEffect(() => {
    let cancelled = false;
    // Async, so a client that cannot make the call at all fails like a failed load.
    const load = async () => Promise.all([api().me.follows({ limit: 100 }), api().portability.grants.mine()]);
    load()
      .then(([f, g]) => {
        if (cancelled) return;
        const channels = f.items.map((i) => i.channel);
        const grants = g.map((x) => x.channel);
        setGranted(grants);
        setCursor(f.nextCursor);
        setRows(grantRows(channels, grants));
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const appendFollows = (page: FollowChannel[]) => setRows((rs) => withMoreFollows(rs ?? [], page, granted));

  const loadMore = () => {
    // Not during a bulk run: it may page to the end itself, and a late page would revive the cursor.
    if (cursor === null || loadingMore || bulkBusy) return;
    setLoadingMore(true);
    api()
      .me.follows({ cursor, limit: 100 })
      .then((page) => {
        appendFollows(page.items.map((i) => i.channel));
        setCursor(page.nextCursor);
      })
      .catch((err: unknown) => toastActionError(err, t("portability.grants.loadFailed")))
      .finally(() => setLoadingMore(false));
  };

  const setOne = async (slug: string, on: boolean) => {
    const r = await api().portability.grants.set({ channel: slug, enabled: on });
    setRows((rs) => rs?.map((x) => (x.slug === slug ? { ...x, on: r.enabled } : x)) ?? rs);
  };

  const onToggle = (slug: string, on: boolean) => {
    setBusy((b) => new Set([...b, slug]));
    setOne(slug, on)
      .catch((err: unknown) => toastActionError(err, t("portability.grants.saveFailed")))
      .finally(() =>
        setBusy((b) => {
          const next = new Set(b);
          next.delete(slug);
          return next;
        }),
      );
  };

  const onSetAll = (on: boolean, scope: { slugs: readonly string[]; everything: boolean }) => {
    if (bulkBusy || loadingMore || rows === null) return;
    setBulkBusy(true);
    void (async () => {
      let all = [...rows];
      // "Every channel" means the unloaded ones too: fetch the rest of the follows first.
      if (scope.everything && cursor !== null) {
        let next: string | null = cursor;
        const more: FollowChannel[] = [];
        while (next !== null) {
          const page: FollowPage = await api().me.follows({ cursor: next, limit: 100 });
          more.push(...page.items.map((i) => i.channel));
          next = page.nextCursor;
        }
        all = withMoreFollows(all, more, granted);
        setRows(all);
        setCursor(null);
      }
      const wanted = new Set(scope.everything ? all.map((r) => r.slug) : scope.slugs);
      const changes = all.filter((r) => wanted.has(r.slug) && r.on !== on).map((r) => r.slug);
      const missed = await runLimited(changes, BULK_CONCURRENCY, (slug) => setOne(slug, on));
      if (missed.length > 0) toast.error(t("settings.grants.allFailed", { count: missed.length }));
      else toast.success(on ? t("settings.grants.allOnDone") : t("settings.grants.allOffDone"));
    })()
      .catch((err: unknown) => toastActionError(err, t("portability.grants.saveFailed")))
      .finally(() => setBulkBusy(false));
  };

  return (
    <GrantsView
      rows={rows}
      loadFailed={failed}
      busy={busy}
      onToggle={onToggle}
      serverHasMore={cursor !== null}
      onServerMore={loadMore}
      loadingMore={loadingMore}
      onSetAll={onSetAll}
      bulkBusy={bulkBusy}
    />
  );
}

/**
 * The same switch for one channel, for its follow menu (shown only to a follower). Mounted by the
 * channel page's follow control (a contract request: `components/channel-follow.tsx`).
 */
export function FollowGrantToggle({
  channel,
  displayName,
  initial,
}: {
  channel: string;
  displayName: string;
  /** `Channel.viewer.portabilityGrant`. */
  initial: boolean;
}): React.JSX.Element {
  // Mounted with `key` on the channel, so a new `initial` is a new component.
  const [on, setOn] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  return (
    <GrantSwitch
      row={{ slug: channel, displayName, avatarUrl: null, on }}
      busy={busy}
      onToggle={(_, next) => {
        setBusy(true);
        api()
          .portability.grants.set({ channel, enabled: next })
          .then((r) => setOn(r.enabled))
          .catch((err: unknown) => toastActionError(err, t("portability.grants.saveFailed")))
          .finally(() => setBusy(false));
      }}
    />
  );
}
