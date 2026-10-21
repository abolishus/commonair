// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonGroup, SkeletonThumbnail } from "@commonair/ui";
import { SensitiveMedia } from "@commonair/ui/blocks/media";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Button } from "@commonair/ui/components/button";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { t } from "../../i18n/index.ts";
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
}

/** `mature-gate`: replaces the player of a mature stream until the viewer confirmed 18+. */
export function MatureGate({
  signedIn,
  checking = false,
  onConfirmed,
  client = maturityClient(),
}: MatureGateProps): React.JSX.Element {
  const { pending, notAdult, confirmMature } = useConfirmMature(client, onConfirmed);
  if (checking)
    return (
      <SkeletonGroup label={t("safety.mature.checking")}>
        <SkeletonThumbnail />
      </SkeletonGroup>
    );
  return (
    <AspectRatio ratio={16 / 9} className="grid place-items-center overflow-y-auto bg-muted">
      <EmptyState
        data-testid="mature-gate"
        icon={Alert02Icon}
        title={t("safety.mature.title")}
        description={signedIn ? t("safety.mature.confirmHint") : t("safety.mature.signinHint")}
        action={
          signedIn ? (
            <div className="flex flex-col items-center gap-2">
              {notAdult ? <FormError>{t("safety.mature.notAdult")}</FormError> : null}
              <Button
                data-testid="mature-gate-confirm"
                size="sm"
                disabled={pending || notAdult}
                aria-busy={pending || undefined}
                onClick={() => void confirmMature()}
              >
                {t("safety.mature.confirm")}
              </Button>
            </div>
          ) : (
            <Button data-testid="mature-gate-signin" size="sm" nativeButton={false} render={<Link to="/signin" />}>
              {t("safety.mature.signin")}
            </Button>
          )
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
}

/**
 * `stream-restricted`: a T1-restricted stream plays muted under a blur with an interstitial over
 * it. Only signed-in, 18+-confirmed viewers can reveal it (`stream-restricted-reveal`); revealing
 * never unmutes (the player starts muted and stays so until the viewer unmutes). The reveal is
 * per page view.
 */
export function RestrictedStream({
  signedIn,
  confirmed,
  onConfirmed,
  children,
  client = maturityClient(),
}: RestrictedStreamProps): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false);
  const { pending, notAdult, confirmMature } = useConfirmMature(client, onConfirmed);
  return (
    <SensitiveMedia
      data-testid="stream-restricted"
      data-reason="under_review"
      data-revealed={revealed ? "true" : "false"}
      obscured={!revealed}
      overlay={
        <>
          <p className="font-medium">{t("safety.restricted.title")}</p>
          <p className="text-muted-foreground">{t("safety.restricted.body")}</p>
          {!signedIn ? (
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/signin" />}>
              {t("safety.mature.signin")}
            </Button>
          ) : confirmed ? (
            <Button
              data-testid="stream-restricted-reveal"
              size="sm"
              variant="outline"
              onClick={() => setRevealed(true)}
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
