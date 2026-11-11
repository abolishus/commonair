// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonGroup, SkeletonThumbnail, StatusBadge } from "@commonair/ui";
import { SensitiveMedia } from "@commonair/ui/blocks/media";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Button } from "@commonair/ui/components/button";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  AuthGateActions,
  AuthGatePanel,
  useGateChannel,
  useGateSearch,
  type GateChannel,
} from "../auth-gate/auth-gate-prompt.tsx";
import { usePendingIntent } from "../auth-gate/intent-confirm.tsx";
import { FormError } from "../form-error.tsx";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { maturityClient, type MaturityClient } from "./client.ts";

export interface ViewerMaturity {
  /** False until `me.get` answered (signed-in viewers only). */
  loaded: boolean;
  confirmed: boolean;
  /** Mark the viewer confirmed after `me.confirmMature` succeeded. */
  markConfirmed: () => void;
}

/**
 * Whether the signed-in viewer confirmed 18+ (`Me.matureConfirmed`), loaded only when a page
 * needs it. Signed out is never confirmed. A failed load counts as not confirmed.
 */
export function useViewerMaturity(signedIn: boolean, needed: boolean, client: MaturityClient): ViewerMaturity {
  const [state, setState] = React.useState<{ loaded: boolean; confirmed: boolean }>({
    loaded: !signedIn,
    confirmed: false,
  });
  const clientRef = React.useRef(client);
  React.useEffect(() => {
    if (!signedIn || !needed || state.loaded) return;
    let live = true;
    clientRef.current
      .me()
      .then((me) => {
        if (live) setState({ loaded: true, confirmed: me.matureConfirmed });
      })
      .catch(() => {
        if (live) setState({ loaded: true, confirmed: false });
      });
    return () => {
      live = false;
    };
  }, [signedIn, needed, state.loaded]);
  return {
    loaded: !signedIn || state.loaded,
    confirmed: signedIn && state.confirmed,
    markConfirmed: () => setState({ loaded: true, confirmed: true }),
  };
}

/** The 18+ confirmation (`me.confirmMature`); FORBIDDEN means the account is not an adult. */
function useConfirmMature(client: MaturityClient, onConfirmed: () => void) {
  const [pending, setPending] = React.useState(false);
  const [notAdult, setNotAdult] = React.useState(false);
  const confirmMature = async () => {
    if (pending) return;
    setPending(true);
    try {
      await client.confirmMature();
      onConfirmed();
    } catch (err) {
      if (errorCode(err) === "FORBIDDEN") setNotAdult(true);
      else toastActionError(err, t("safety.mature.failed"));
    } finally {
      setPending(false);
    }
  };
  return { pending, notAdult, confirmMature };
}

export interface MatureGateProps {
  signedIn: boolean;
  /** Signed in, still loading whether the viewer confirmed: a placeholder, no buttons. */
  checking?: boolean;
  onConfirmed: () => void;
  client?: MaturityClient;
  /** Signed out: the channel the sign-up prompt carries (the `$channel` param otherwise). */
  channel?: GateChannel | null;
}

/**
 * `mature-gate`: replaces the player of a mature stream until the viewer confirmed 18+. Signed
 * out it is the sign-up prompt inline (`intent=watch`): the account comes first, the 18+ confirm
 * after.
 */
export function MatureGate({
  signedIn,
  checking = false,
  onConfirmed,
  client = maturityClient(),
  channel,
}: MatureGateProps): React.JSX.Element {
  const { pending, notAdult, confirmMature } = useConfirmMature(client, onConfirmed);
  const gateChannel = useGateChannel(channel);
  const search = useGateSearch("watch", gateChannel);
  // Back from sign-up with `intent=watch`: the 18+ confirm is the one tap; it never confirms alone.
  const intent = usePendingIntent("watch", signedIn && !checking);
  const confirmButton = React.useRef<HTMLButtonElement>(null);
  const confirming = intent.pending !== null;
  React.useEffect(() => {
    if (confirming) confirmButton.current?.focus({ preventScroll: true });
  }, [confirming]);
  if (checking)
    return (
      <SkeletonGroup label={t("safety.mature.checking")}>
        <SkeletonThumbnail />
      </SkeletonGroup>
    );
  if (!signedIn)
    return (
      <AspectRatio ratio={16 / 9} className="grid place-items-center overflow-y-auto bg-muted p-4">
        <div className="flex flex-col items-center gap-3">
          <StatusBadge tone="neutral">{t("d2Gate.watch.badge")}</StatusBadge>
          <AuthGatePanel
            data-testid="mature-gate"
            intent="watch"
            channel={gateChannel}
            actions={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  data-testid="mature-gate-create"
                  data-filled-cta=""
                  variant="brand"
                  size="lg"
                  nativeButton={false}
                  render={<Link to="/signup" search={search} onClick={() => trackUi("authGate", "create", "watch")} />}
                >
                  {t("d2Gate.create")}
                </Button>
                <Button
                  data-testid="mature-gate-signin"
                  variant="ghost"
                  size="lg"
                  nativeButton={false}
                  render={<Link to="/signin" search={search} onClick={() => trackUi("authGate", "signin", "watch")} />}
                >
                  {t("safety.mature.signin")}
                </Button>
              </div>
            }
          />
        </div>
      </AspectRatio>
    );
  return (
    <AspectRatio ratio={16 / 9} className="grid place-items-center overflow-y-auto bg-muted">
      <EmptyState
        data-testid="mature-gate"
        icon={Alert02Icon}
        title={t("safety.mature.title")}
        description={t("safety.mature.confirmHint")}
        action={
          <div className="flex flex-col items-center gap-2">
            {confirming ? (
              <output data-testid="intent-confirm" data-intent="watch" className="text-sm text-foreground">
                {t("d4Follow.confirm.watch")}
              </output>
            ) : null}
            {notAdult ? <FormError>{t("safety.mature.notAdult")}</FormError> : null}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                ref={confirmButton}
                data-testid="mature-gate-confirm"
                size="sm"
                disabled={pending || notAdult}
                aria-busy={pending || undefined}
                onClick={() => {
                  if (confirming) intent.confirm();
                  void confirmMature();
                }}
              >
                {t("safety.mature.confirm")}
              </Button>
              {confirming ? (
                <Button data-testid="intent-confirm-dismiss" size="sm" variant="ghost" onClick={intent.dismiss}>
                  {t("d4Follow.confirm.dismiss")}
                </Button>
              ) : null}
            </div>
          </div>
        }
      />
    </AspectRatio>
  );
}

export interface RestrictedStreamProps {
  signedIn: boolean;
  /** Signed in and 18+ confirmed: may look through the blur. */
  confirmed: boolean;
  onConfirmed: () => void;
  children: React.ReactNode;
  client?: MaturityClient;
  /** Signed out: the channel the sign-up prompt carries (the `$channel` param otherwise). */
  channel?: GateChannel | null;
}

/**
 * `stream-restricted`: a T1-restricted stream plays muted under a blur with an interstitial over
 * it. Only signed-in, 18+-confirmed viewers can reveal it (`stream-restricted-reveal`); revealing
 * never unmutes (the player starts muted and stays so until the viewer unmutes). The reveal is
 * per page view. Signed out, the interstitial offers Create account and Sign in (`intent=watch`).
 */
export function RestrictedStream({
  signedIn,
  confirmed,
  onConfirmed,
  children,
  client = maturityClient(),
  channel,
}: RestrictedStreamProps): React.JSX.Element {
  const gateChannel = useGateChannel(channel);
  const canReveal = signedIn && confirmed;
  const [reveal, setReveal] = React.useState({ eligible: canReveal, revealed: false });
  if (reveal.eligible !== canReveal) setReveal({ eligible: canReveal, revealed: false });
  const visible = canReveal && reveal.revealed;
  const { pending, notAdult, confirmMature } = useConfirmMature(client, onConfirmed);
  return (
    <SensitiveMedia
      data-testid="stream-restricted"
      data-reason="under_review"
      data-revealed={visible ? "true" : "false"}
      obscured={!visible}
      overlay={
        <>
          <p className="font-medium">{t("safety.restricted.title")}</p>
          <p className="text-muted-foreground">{t("safety.restricted.body")}</p>
          {!signedIn ? (
            <>
              {/* Revealing needs an account that confirmed 18+, so say so before the buttons. */}
              <p className="text-muted-foreground">{t("safety.mature.signinHint")}</p>
              <AuthGateActions intent="watch" channel={gateChannel} className="flex flex-wrap justify-center gap-2" />
            </>
          ) : confirmed ? (
            <Button
              data-testid="stream-restricted-reveal"
              size="sm"
              variant="outline"
              onClick={() => setReveal({ eligible: canReveal, revealed: true })}
            >
              {t("safety.restricted.reveal")}
            </Button>
          ) : (
            <>
              {notAdult ? <FormError>{t("safety.mature.notAdult")}</FormError> : null}
              <Button
                size="sm"
                variant="outline"
                disabled={pending || notAdult}
                aria-busy={pending || undefined}
                onClick={() => void confirmMature()}
              >
                {t("safety.mature.confirm")}
              </Button>
            </>
          )}
        </>
      }
    >
      {children}
    </SensitiveMedia>
  );
}
