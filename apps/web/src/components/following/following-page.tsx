// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/following` (D3.5): the channels the viewer follows, Live now first, then the offline ones as
 * rows, each with its go-live alert bell (`channels.follow` with `notify`). Nobody followed yet:
 * an empty state that points to Browse. Signed out: sign in or create an account (the
 * AuthGatePrompt replaces this once it lands).
 */
import { ChannelAvatar, EmptyState, IconButton, RelativeTime, Skeleton } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { FavouriteIcon, Notification01Icon, NotificationOff01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { categoryLink } from "../../lib/category-route.ts";
import { collidingNames, displayLabel } from "../../lib/directory-sections.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { loadErrorTitle } from "../../lib/load-copy.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { feedViewer, useHomeFeed } from "../discovery/feed.ts";
import { DiscoveryStreamCard } from "../discovery/stream-cards.tsx";
import { CardGrid } from "@commonair/ui/blocks/media";
import { SIGNUP_FOLLOWING_HREF } from "./links.ts";
import { FOLLOWS_PAGE, followingView, withNotify, type FollowRow, type OfflineFollow } from "./model.ts";

export function FollowingPage({ me }: { me: SessionUser | null }): React.JSX.Element {
  React.useEffect(() => {
    trackUi("following", "view", me ? "none" : "follow");
  }, [me]);
  return (
    <PageContainer width="wide" className="flex flex-col gap-8 py-6">
      <h1 className="font-display text-2xl font-semibold">{t("d3Home.followingPage.title")}</h1>
      {me ? <FollowingList me={me} /> : <SignedOut />}
    </PageContainer>
  );
}

function SignedOut(): React.JSX.Element {
  return (
    <EmptyState
      data-testid="following-signed-out"
      icon={FavouriteIcon}
      headingLevel={2}
      title={t("d3Home.followingPage.signedOut.title")}
      description={t("d3Home.followingPage.signedOut.body")}
      action={
        <Button
          data-testid="following-signin"
          nativeButton={false}
          render={<Link to="/signin" search={{ redirect: "/following" }} />}
          onClick={() => trackUi("following", "signin", "follow")}
        >
          {t("d3Home.followingPage.signedOut.signIn")}
        </Button>
      }
      secondaryAction={
        <Button
          data-testid="following-signup"
          variant="outline"
          nativeButton={false}
          render={<a href={SIGNUP_FOLLOWING_HREF} aria-label={t("d3Home.followingPage.signedOut.create")} />}
          onClick={() => trackUi("following", "create", "follow")}
        >
          {t("d3Home.followingPage.signedOut.create")}
        </Button>
      }
    />
  );
}

interface FollowsPage {
  items: FollowRow[];
  nextCursor: string | null;
}

function FollowingList({ me }: { me: SessionUser }): React.JSX.Element {
  const load = useRetryingLoad<FollowsPage>(`following:${me.id}`, () => api().me.follows({ limit: FOLLOWS_PAGE }));
  const feed = useHomeFeed({ viewer: feedViewer(me) });
  // The loaded rows plus later pages and alert changes, started over whenever a first page
  // arrives (adjusted during render, React's pattern for state derived from a changing input).
  const [local, setLocal] = React.useState<{ base: FollowsPage | null; rows: FollowRow[]; cursor: string | null }>({
    base: null,
    rows: [],
    cursor: null,
  });
  if (load.data && load.data !== local.base)
    setLocal({ base: load.data, rows: load.data.items, cursor: load.data.nextCursor });
  const fresh = load.data !== null && load.data === local.base;
  const rows = fresh ? local.rows : (load.data?.items ?? null);
  const cursor = fresh ? local.cursor : (load.data?.nextCursor ?? null);
  const setRows = (next: (prev: FollowRow[]) => FollowRow[]) => setLocal((s) => ({ ...s, rows: next(s.rows) }));
  const setCursor = (next: string | null) => setLocal((s) => ({ ...s, cursor: next }));
  const [more, setMore] = React.useState<"idle" | "loading">("idle");
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());

  const view = React.useMemo(() => (rows ? followingView(rows, feed.home) : null), [rows, feed.home]);
  const collisions = React.useMemo(() => collidingNames((rows ?? []).map((r) => r.channel)), [rows]);

  const showMore = async () => {
    if (!cursor || more === "loading") return;
    setMore("loading");
    try {
      const page = await api().me.follows({ limit: FOLLOWS_PAGE, cursor });
      setRows((prev) => {
        const have = new Set(prev.map((r) => r.channel.id));
        return [...prev, ...page.items.filter((r) => !have.has(r.channel.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      toast.error(loadErrorTitle(t("d3Home.followingPage.list")));
    } finally {
      setMore("idle");
    }
  };

  const setAlert = async (row: { channel: FollowRow["channel"] }, notify: boolean) => {
    const id = row.channel.id;
    if (pending.has(id)) return;
    setPending((prev) => new Set([...prev, id]));
    setRows((prev) => withNotify(prev, id, notify));
    const name = row.channel.displayName;
    try {
      await api().channels.follow({ channel: row.channel.slug, notify });
      toast.success(
        notify
          ? t("d3Home.followingPage.alertOnToast", { channel: name })
          : t("d3Home.followingPage.alertOffToast", { channel: name }),
      );
    } catch {
      setRows((prev) => withNotify(prev, id, !notify));
      toast.error(t("d3Home.followingPage.alertFailed", { channel: name }));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (view === null) {
    if (load.failed)
      return (
        <SectionLoadError
          data-testid="following-load-error"
          section={t("d3Home.followingPage.list")}
          load={load}
          alone
          headingLevel={2}
        />
      );
    return <FollowingSkeleton />;
  }
  if (view.live.length === 0 && view.offline.length === 0)
    return (
      <EmptyState
        data-testid="following-empty"
        icon={FavouriteIcon}
        headingLevel={2}
        title={t("d3Home.followingPage.empty.title")}
        description={t("d3Home.followingPage.empty.body")}
        action={
          <Button nativeButton={false} variant="outline" render={<Link to="/directory" />}>
            {t("d3Home.followingPage.empty.action")}
          </Button>
        }
      />
    );
  return (
    <div data-testid="following" className="flex flex-col gap-10">
      {view.live.length > 0 && (
        <Section data-testid="following-live" heading={t("d3Home.followingPage.live")}>
          <CardGrid max={4}>
            {view.live.map(({ card }, index) => (
              <DiscoveryStreamCard
                key={card.channel.id}
                card={card}
                collisions={collisions}
                showReason={false}
                lazy={index >= 4}
              />
            ))}
          </CardGrid>
        </Section>
      )}
      {view.offline.length > 0 && (
        <Section data-testid="following-offline" heading={t("d3Home.followingPage.offline")}>
          <ul className="flex flex-col divide-y divide-border">
            {view.offline.map((row) => (
              <OfflineRow
                key={row.channel.id}
                row={row}
                label={displayLabel(collisions, row.channel)}
                busy={pending.has(row.channel.id)}
                onToggle={() => void setAlert(row, !row.notify)}
              />
            ))}
          </ul>
        </Section>
      )}
      {cursor && (
        <Button
          data-testid="following-more"
          variant="outline"
          className="self-start"
          disabled={more === "loading"}
          onClick={() => void showMore()}
        >
          {t("d3Home.followingPage.showMore")}
        </Button>
      )}
    </div>
  );
}

function OfflineRow({
  row,
  label,
  busy,
  onToggle,
}: {
  row: OfflineFollow;
  label: string;
  busy: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <li
      data-testid="following-row"
      data-channel={row.channel.slug}
      data-notify={row.notify ? "true" : "false"}
      className="flex min-h-16 min-w-0 items-center gap-3 py-2"
    >
      <Link
        to="/$channel"
        params={{ channel: row.channel.slug }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChannelAvatar
          name={row.channel.displayName}
          src={row.channel.avatarUrl}
          accent={row.channel.accent}
          decorative
          className="shrink-0"
        />
        <span className="flex min-w-0 flex-col">
          <span dir="auto" className="truncate text-sm font-medium">
            {label}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {row.lastLiveAt ? (
              <>
                {t("d3Home.followingPage.lastLive")} <RelativeTime date={row.lastLiveAt} tooltip={false} />
              </>
            ) : (
              t("d3Home.followingPage.offline")
            )}
          </span>
        </span>
      </Link>
      {row.category && (
        <Link
          {...categoryLink(row.category.slug)}
          className="hidden max-w-40 truncate text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:block"
        >
          <span dir="auto">{row.category.name}</span>
        </Link>
      )}
      <IconButton
        data-testid="following-bell"
        variant={row.notify ? "secondary" : "ghost"}
        icon={row.notify ? Notification01Icon : NotificationOff01Icon}
        aria-pressed={row.notify}
        disabled={busy}
        label={
          row.notify
            ? t("d3Home.followingPage.alertOn", { channel: row.channel.displayName })
            : t("d3Home.followingPage.alertOff", { channel: row.channel.displayName })
        }
        onClick={onToggle}
      />
    </li>
  );
}

function FollowingSkeleton(): React.JSX.Element {
  return (
    <div data-testid="following-loading" aria-busy className="flex flex-col gap-2">
      <span className="sr-only">{t("d3Home.followingPage.loading")}</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden className="flex min-h-16 items-center gap-3 py-2">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-40 max-w-full" />
            <Skeleton className="h-2.5 w-24" />
          </span>
          <Skeleton className="size-10" />
        </div>
      ))}
    </div>
  );
}
