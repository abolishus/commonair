// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AccentButton, formatNumber, useLocale } from "@commonair/ui";
import { FavouriteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { followReducer, initialFollowState, toggleFollow, type FollowState } from "../lib/follow.ts";

/** Follow state for a channel page, kept in sync with the polled `channels.get` values. */
export function useFollow(
  channel: string,
  following: boolean | null,
  count: number,
  requestedAt: number,
): { state: FollowState; toggle: () => void } {
  const [state, dispatch] = React.useReducer(followReducer, initialFollowState(following, count));
  React.useEffect(() => dispatch({ type: "sync", following, count, requestedAt }), [following, count, requestedAt]);
  // `state.pending` only updates on the next render; a double click in one frame must not send twice.
  const inFlight = React.useRef(false);
  const toggle = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    void toggleFollow(
      state,
      (follow) => (follow ? api().channels.follow({ channel }) : api().channels.unfollow({ channel })),
      dispatch,
      (err) => toastActionError(err, t("follow.failed")),
    ).finally(() => {
      inFlight.current = false;
    });
  };
  return { state, toggle };
}

/** Follower count for `ChannelHeader`'s `followers` slot (which sets its type and color). */
export function FollowerCount({ count }: { count: number }): React.JSX.Element {
  const { locale } = useLocale();
  const n = formatNumber(count, locale);
  return (
    <span data-testid="follower-count" data-count={count}>
      {count === 1 ? t("follow.countOne", { count: n }) : t("follow.countOther", { count: n })}
    </span>
  );
}

export interface FollowButtonProps {
  signedIn: boolean;
  state: FollowState;
  onToggle: () => void;
}

/**
 * Follow is the channel's call to action, so it is an `AccentButton` in both states (one element,
 * so keyboard focus survives the toggle); `aria-pressed` and the label carry the state.
 */
export function FollowButton({ signedIn, state, onToggle }: FollowButtonProps): React.JSX.Element {
  if (!signedIn)
    return (
      <AccentButton data-testid="follow-button" size="sm" nativeButton={false} render={<Link to="/signin" />}>
        <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
        {t("follow.follow")}
      </AccentButton>
    );
  const following = state.following === true;
  return (
    <AccentButton
      data-testid="follow-button"
      data-following={following ? "true" : "false"}
      size="sm"
      aria-pressed={following}
      aria-busy={state.pending || undefined}
      disabled={state.pending}
      onClick={onToggle}
    >
      <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
      {following ? t("follow.following") : t("follow.follow")}
    </AccentButton>
  );
}
