// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AccentButton } from "@commonair/ui";
import { FavouriteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { AuthGatePrompt, useGateChannel, type GateChannel } from "./auth-gate/auth-gate-prompt.tsx";
import { IntentConfirm, usePendingIntent } from "./auth-gate/intent-confirm.tsx";
import { armFirstFollow, fireFirstFollow } from "./follow/alert-options.ts";
import { FirstFollowPrompt } from "./follow/alert-prompt.tsx";
import { FollowingControls } from "./follow/following-menu.tsx";
import { useFollowNotify, type FollowsPageLoader, type SetNotify } from "./follow/notify.ts";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { followReducer, initialFollowState, toggleFollow, type FollowState } from "../lib/follow.ts";

export type FollowApi = (
  channel: string,
  follow: boolean,
) => Promise<{ following: boolean; followerCount: number; firstFollow?: boolean }>;

const apiFollow: FollowApi = (channel, follow) =>
  follow ? api().channels.follow({ channel }) : api().channels.unfollow({ channel });

/**
 * Follow state for a channel page, kept in sync with the polled `channels.get` values. A follow
 * the API reports as the caller's first (`firstFollow`) opens the alert prompt on the Follow
 * control that was pressed (`armFirstFollow`).
 */
export function useFollow(
  channel: string,
  following: boolean | null,
  count: number,
  requestedAt: number,
  call: FollowApi = apiFollow,
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
      async (follow) => {
        const res = await call(channel, follow);
        if (follow && res.firstFollow === true) fireFirstFollow();
        return res;
      },
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
  /**
   * The follow's go-live alerts when the page knows them (`Channel.viewer.notify`, a contract
   * request); otherwise the bell reads them from the follows list.
   */
  notify?: boolean | null;
  /** `Channel.viewer.portabilityGrant`: the menu's "Email me once if they move". Absent: no item. */
  portabilityGrant?: boolean | undefined;
  /** Injected in tests. */
  loadFollowsPage?: FollowsPageLoader;
  setNotify?: SetNotify;
}

/**
 * While a prompt or a confirm hangs off Follow, that popover holds the screen's one fill, so the
 * page's own Follow drops to an outline (the mockups' rule). These win over the accent classes.
 */
export const FOLLOW_OUTLINE_CLASSES =
  "border-border bg-background text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50";

/**
 * Not following: one Follow, the channel's call to action (an `AccentButton` and the page's filled
 * CTA, so the header's Sign up drops to an outline beside it). Following: the split button (a
 * bell for alerts and the "Following" menu, README D4.3), an outline. Signed out, Follow opens the
 * sign-up prompt (`intent=follow`); back from sign-up, a one-tap confirm. After the caller's first
 * follow ever, the one-time alert prompt. `follow-button` is the primary control in every state.
 */
export function FollowButton({
  signedIn,
  state,
  onToggle,
  channel,
  notify: knownNotify,
  portabilityGrant,
  loadFollowsPage,
  setNotify,
}: FollowButtonProps): React.JSX.Element {
  const gateChannel = useGateChannel(channel);
  const [gateOpen, setGateOpen] = React.useState(false);
  const following = state.following === true;
  const intent = usePendingIntent("follow", signedIn && state.following === false);
  const button = React.useRef<HTMLButtonElement>(null);
  const menuTrigger = React.useRef<HTMLButtonElement>(null);
  const [alertPrompt, setAlertPrompt] = React.useState(false);
  const slug = gateChannel?.slug ?? "";
  const name = gateChannel?.name.trim() || slug;
  const notify = useFollowNotify({
    channel: slug,
    channelName: name,
    following: signedIn && following && slug !== "",
    initial: knownNotify,
    ...(loadFollowsPage ? { loadPage: loadFollowsPage } : {}),
    ...(setNotify ? { setNotify } : {}),
  });

  // Follow pressed (or confirmed): the API's `firstFollow` answer comes back to this control only.
  const disarm = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => disarm.current?.(), []);
  // A toggle swaps the whole control (Follow <-> the split button), so the focused button
  // unmounts. Once the toggle settles, focus lands on whichever control is now the primary one.
  const restoreFocus = React.useRef(false);
  const toggle = () => {
    restoreFocus.current = true;
    onToggle();
  };
  const follow = () => {
    disarm.current?.();
    disarm.current = armFirstFollow(() => setAlertPrompt(true));
    toggle();
  };
  React.useEffect(() => {
    if (!restoreFocus.current || state.pending) return;
    restoreFocus.current = false;
    // The first-follow prompt takes focus and hands it to the menu trigger when it closes.
    if (alertPrompt) return;
    (state.following === true ? menuTrigger.current : button.current)?.focus();
  }, [state.following, state.pending, alertPrompt]);
  // Settled (followed, refused, or not the first): nothing stays armed for a later follow.
  React.useEffect(() => {
    if (state.pending) return;
    disarm.current?.();
    disarm.current = null;
  }, [state.pending]);

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

  if (following && gateChannel)
    return (
      <span data-slot="follow-control" className="relative inline-flex">
        <FollowingControls
          channel={{ slug: gateChannel.slug, name }}
          notify={notify}
          portabilityGrant={portabilityGrant}
          pending={state.pending}
          triggerRef={menuTrigger}
          onUnfollow={toggle}
        />
        <FirstFollowPrompt
          open={alertPrompt}
          onClose={() => setAlertPrompt(false)}
          channel={{ ...gateChannel, name }}
          finalFocus={menuTrigger}
        />
      </span>
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
      onClick={following ? toggle : follow}
    />
  );
  const label = (
    <>
      <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
      {following ? t("follow.following") : t("follow.follow")}
    </>
  );
  if (!confirming) return React.cloneElement(control, {}, label);
  const settle = (yes: boolean) => {
    if (yes) {
      intent.confirm();
      // Focus follows the toggle once it settles (the effect above).
      follow();
      return;
    }
    intent.dismiss();
    // The confirm unmounts; keep focus on Follow, not the page body.
    requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <IntentConfirm
      open
      message={
        gateChannel?.name.trim() ? t("d2Gate.confirm.follow", { channel: name }) : t("d2Gate.confirm.followNoChannel")
      }
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
