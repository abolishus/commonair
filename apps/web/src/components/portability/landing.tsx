// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A move link's landing page (`/m/$channel/$nonce`, ADR 0037 decision 2): the channel card and a
 * follow button that passes the link to `channels.follow` (`moveLink`), so a new follow counts as
 * a conversion. A revoked, expired or unknown link shows an empty state with a way to the channel
 * page. `MoveLandingView` is drawn from props; `MoveLanding` loads and follows.
 */
import { AccentButton, ChannelAvatar, EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent } from "@commonair/ui/components/card";
import { FavouriteIcon, LinkBackwardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import type { LandingState } from "./lib.ts";

export interface LandingChannel {
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  title: string;
  followerCount: number;
}

export interface MoveLandingViewProps {
  /** Null while loading. */
  state: LandingState | null;
  channel: LandingChannel | null;
  signedIn: boolean;
  following: boolean;
  pending: boolean;
  loadFailed: boolean;
  onFollow: () => void;
}

export function MoveLandingView(props: MoveLandingViewProps): React.JSX.Element {
  const { state, channel } = props;
  if (props.loadFailed) return <FormError>{t("portability.landing.loadFailed")}</FormError>;
  if (state === null)
    return (
      <SkeletonGroup label={t("portability.landing.loading")}>
        <SkeletonText lines={3} />
      </SkeletonGroup>
    );
  if (state !== "active" || !channel)
    return (
      <div data-testid="move-landing" data-state={state === "unknown" ? "revoked" : state}>
        <EmptyState
          data-testid="move-landing-gone"
          icon={LinkBackwardIcon}
          title={state === "expired" ? t("portability.landing.expired") : t("portability.landing.gone")}
          description={t("portability.landing.goneHint")}
          action={
            channel ? (
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/$channel" params={{ channel: channel.slug }} />}
              >
                {t("portability.landing.visit", { channel: channel.displayName })}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  return (
    <div data-testid="move-landing" data-state="active" className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardContent className="flex min-w-0 flex-col items-center gap-4 py-6 text-center">
          <ChannelAvatar name={channel.displayName} src={channel.avatarUrl} size="xl" decorative />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="break-words text-xl font-semibold">{channel.displayName}</h1>
            {channel.title && <p className="break-words text-sm text-muted-foreground">{channel.title}</p>}
            <p className="text-sm text-muted-foreground">
              {t("portability.landing.followers", { count: channel.followerCount })}
            </p>
          </div>
          <p className="max-w-prose text-sm">{t("portability.landing.intro", { channel: channel.displayName })}</p>
          {props.signedIn ? (
            <AccentButton
              data-testid="move-landing-follow"
              data-following={props.following ? "true" : "false"}
              aria-pressed={props.following}
              disabled={props.pending || props.following}
              aria-busy={props.pending || undefined}
              onClick={props.onFollow}
            >
              <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
              {props.following ? t("portability.landing.following") : t("portability.landing.follow")}
            </AccentButton>
          ) : (
            <AccentButton data-testid="move-landing-follow" nativeButton={false} render={<Link to="/signin" />}>
              <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
              {t("portability.landing.signInToFollow")}
            </AccentButton>
          )}
          <Button
            variant="link"
            nativeButton={false}
            render={<Link to="/$channel" params={{ channel: channel.slug }} />}
          >
            {t("portability.landing.visit", { channel: channel.displayName })}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function MoveLanding({
  channel,
  nonce,
  signedIn,
}: {
  channel: string;
  nonce: string;
  signedIn: boolean;
}): React.JSX.Element {
  const [state, setState] = React.useState<LandingState | null>(null);
  const [info, setInfo] = React.useState<LandingChannel | null>(null);
  const [following, setFollowing] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  // A malformed nonce is an unknown link without asking.
  const malformed = !/^[A-Za-z0-9_-]{16,64}$/.test(nonce);
  React.useEffect(() => {
    let cancelled = false;
    if (malformed) return;
    api()
      .portability.links.resolve({ channel, nonce })
      .then((r) => {
        if (cancelled) return;
        setState(r.state);
        setInfo(r.channel);
        if (signedIn && r.channel)
          return api()
            .channels.get({ channel })
            .then((c) => !cancelled && setFollowing(c.viewer?.following === true));
        return undefined;
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [channel, nonce, signedIn, malformed]);

  const onFollow = () => {
    if (pending || following) return;
    setPending(true);
    api()
      .channels.follow({ channel, notify: true, moveLink: { nonce } })
      .then((r) => {
        setFollowing(true);
        setInfo((i) => (i ? { ...i, followerCount: r.followerCount } : i));
      })
      .catch((err: unknown) => toastActionError(err, t("follow.failed")))
      .finally(() => setPending(false));
  };

  return (
    <MoveLandingView
      state={malformed ? "unknown" : state}
      channel={malformed ? null : info}
      signedIn={signedIn}
      following={following}
      pending={pending}
      loadFailed={failed}
      onFollow={onFollow}
    />
  );
}
