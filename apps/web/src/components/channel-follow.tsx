// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AccentButton } from "@commonair/ui";
import { FavouriteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { AuthGatePrompt, useGateChannel, type GateChannel } from "./auth-gate/auth-gate-prompt.tsx";
import { IntentConfirm, usePendingIntent } from "./auth-gate/intent-confirm.tsx";
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
  return (
    <span data-testid="follower-count" data-count={count}>
      {t("follow.count", { count })}
    </span>
  );
}

export interface FollowButtonProps {
  signedIn: boolean;
  state: FollowState;
  onToggle: () => void;
  /** The channel, for the sign-up prompt and the confirm; the `$channel` route param otherwise. */
  channel?: GateChannel | null;
}

/**
 * While a prompt or a confirm hangs off Follow, that popover holds the screen's one fill, so the
 * page's own Follow drops to an outline (the mockups' rule). These win over the accent classes.
 */
export const FOLLOW_OUTLINE_CLASSES =
  "border-border bg-background text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50";

/**
 * Follow is the channel's call to action, so it is an `AccentButton` in both states (one element,
 * so keyboard focus survives the toggle); `aria-pressed` and the label carry the state. It is the
 * page's filled CTA (`data-filled-cta`), so the header's Sign up drops to an outline beside it.
 * Signed out it opens the sign-up prompt (`intent=follow`); back from sign-up, a one-tap confirm.
 */
export function FollowButton({ signedIn, state, onToggle, channel }: FollowButtonProps): React.JSX.Element {
  const gateChannel = useGateChannel(channel);
  const [gateOpen, setGateOpen] = React.useState(false);
  const following = state.following === true;
  const intent = usePendingIntent("follow", signedIn && state.following === false);
  const button = React.useRef<HTMLButtonElement>(null);
  if (!signedIn)
    return (
      <AuthGatePrompt
        intent="follow"
        channel={gateChannel}
        open={gateOpen}
        onOpenChange={setGateOpen}
        trigger={
          <AccentButton
            data-testid="follow-button"
            data-filled-cta={gateOpen ? undefined : ""}
            data-gate-open={gateOpen ? "true" : undefined}
            size="sm"
            className={gateOpen ? FOLLOW_OUTLINE_CLASSES : undefined}
          />
        }
      >
        <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
        {t("follow.follow")}
      </AuthGatePrompt>
    );
  const confirming = intent.pending !== null;
  const control = (
    <AccentButton
      ref={button}
      data-testid="follow-button"
      data-filled-cta={confirming ? undefined : ""}
      data-following={following ? "true" : "false"}
      size="sm"
      className={confirming ? FOLLOW_OUTLINE_CLASSES : undefined}
      aria-pressed={following}
      aria-busy={state.pending || undefined}
      disabled={state.pending}
      onClick={onToggle}
    />
  );
  const label = (
    <>
      <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
      {following ? t("follow.following") : t("follow.follow")}
    </>
  );
  if (!confirming) return React.cloneElement(control, {}, label);
  const name = gateChannel?.name.trim();
  const settle = (follow: boolean) => {
    if (follow) {
      intent.confirm();
      onToggle();
    } else intent.dismiss();
    // The confirm unmounts; keep focus on Follow, not the page body.
    requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <IntentConfirm
      open
      message={name ? t("d2Gate.confirm.follow", { channel: name }) : t("d2Gate.confirm.followNoChannel")}
      onDismiss={() => settle(false)}
      trigger={control}
      action={
        <AccentButton data-testid="intent-confirm-follow" data-filled-cta="" onClick={() => settle(true)}>
          <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
          {t("follow.follow")}
        </AccentButton>
      }
    >
      {label}
    </IntentConfirm>
  );
}
