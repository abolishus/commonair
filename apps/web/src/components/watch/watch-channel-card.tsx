// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel card under a VOD or clip (F11, `watch-channel-card`): the avatar and name (a link to
 * the channel), the follower count, Follow, and, while the channel is live, `<LiveBadge>` with the
 * verified count ("Just started" below the threshold, as on the channel page) and "Watch live".
 * The live state is polled on the channel page's interval (`CHANNEL_POLL_MS`), never faster.
 */
import { ChannelAvatar, LiveBadge, ViewerCount } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import type { Accent } from "@commonair/ui";
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { CHANNEL_POLL_MS } from "../../lib/use-channel.ts";
import { showsJustStarted } from "../channel/channel-data.ts";
import { JustStartedBadge } from "../channel/channel-meta.tsx";
import { FollowButton, FollowerCount, useFollow } from "../channel-follow.tsx";

/** What the card shows of a channel (from `channels.get`); the counts are absent when unknown. */
export interface ChannelCard {
  displayName: string;
  avatarUrl: string | null;
  accent: Accent | null;
  followerCount?: number;
  /** The caller's follow state; null when anonymous. */
  following?: boolean | null;
  /** Verified viewers while live; null when offline. */
  live?: { viewerCount: number } | null;
  /** When the request that produced this started (ms), for the follow state's race guard. */
  requestedAt?: number;
}

export type ChannelCardState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ok"; card: ChannelCard };

/** `get(slug)` now and every `CHANNEL_POLL_MS` after; a failed poll keeps the last card. */
export function useWatchChannel(
  slug: string,
  get: (slug: string) => Promise<ChannelCard>,
  { poll = true }: { poll?: boolean } = {},
): ChannelCardState {
  const [state, setState] = React.useState<{ slug: string; value: ChannelCardState } | null>(null);
  const getRef = React.useRef(get);
  React.useEffect(() => {
    getRef.current = get;
  }, [get]);
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const card = await getRef.current(slug);
        if (!cancelled) setState({ slug, value: { status: "ok", card } });
      } catch (err) {
        if (cancelled) return;
        const missing = errorCode(err) === "NOT_FOUND";
        // Keep a card already shown; only a first failure changes what the page shows.
        setState((prev) =>
          prev?.slug === slug && prev.value.status === "ok" && !missing
            ? prev
            : { slug, value: { status: missing ? "missing" : "error" } },
        );
        if (missing) return;
      }
      if (!cancelled && poll) timer = setTimeout(() => void load(), CHANNEL_POLL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, poll]);
  return state?.slug === slug ? state.value : { status: "loading" };
}

export interface WatchChannelCardProps {
  slug: string;
  /** Null while the channel loads (or if it failed): the slug and the avatar's initial stand in. */
  card: ChannelCard | null;
  signedIn: boolean;
}

export function WatchChannelCard({ slug, card, signedIn }: WatchChannelCardProps): React.JSX.Element {
  return card ? (
    <LoadedCard key={slug} slug={slug} card={card} signedIn={signedIn} />
  ) : (
    <CardFrame slug={slug} card={null} />
  );
}

/** Follow starts from the loaded state, and the count under the name follows a toggle at once. */
function LoadedCard({ slug, card, signedIn }: { slug: string; card: ChannelCard; signedIn: boolean }) {
  const follow = useFollow(slug, card.following ?? null, card.followerCount ?? 0, card.requestedAt ?? 0);
  return (
    <CardFrame
      slug={slug}
      card={card}
      followers={card.followerCount !== undefined ? <FollowerCount count={follow.state.count} /> : null}
      follow={
        <FollowButton
          signedIn={signedIn}
          state={follow.state}
          onToggle={follow.toggle}
          channel={{ slug, name: card.displayName ?? slug }}
        />
      }
    />
  );
}

function CardFrame({
  slug,
  card,
  followers = null,
  follow = null,
}: {
  slug: string;
  card: ChannelCard | null;
  followers?: React.ReactNode;
  follow?: React.ReactNode;
}): React.JSX.Element {
  const name = card?.displayName ?? slug;
  const live = card?.live ?? null;
  return (
    <section
      data-testid="watch-channel-card"
      data-live={live ? "true" : "false"}
      aria-label={t("watch.card.label", { name })}
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border border-border bg-card p-3 text-card-foreground"
    >
      <Link
        data-testid="watch-channel-link"
        to="/$channel"
        params={{ channel: slug }}
        className="flex min-w-0 flex-1 basis-48 items-center gap-3 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ChannelAvatar
          name={name}
          src={card?.avatarUrl}
          accent={card?.accent}
          size="md"
          live={live !== null}
          decorative
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{name}</span>
          {followers ? <span className="text-xs text-muted-foreground">{followers}</span> : null}
        </span>
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          <span data-testid="watch-channel-live" className="flex items-center gap-2">
            <LiveBadge />
            {showsJustStarted(live.viewerCount) ? <JustStartedBadge /> : <ViewerCount count={live.viewerCount} />}
          </span>
        ) : null}
        {live ? (
          <Button
            data-testid="watch-live"
            size="sm"
            nativeButton={false}
            render={<Link to="/$channel" params={{ channel: slug }} />}
          >
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} aria-hidden />
            {t("watch.card.watchLive")}
          </Button>
        ) : null}
        {follow}
      </div>
    </section>
  );
}
