// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shell's view of the session (F1), as hooks over the root loader's data and a session check.
 * `bootstrap.ts` wires them to the root route and its server function; they live here so they can
 * be tested without the Start runtime.
 */
import { useRouter } from "@tanstack/react-router";
import * as React from "react";
import type { Bootstrap } from "./bootstrap-types.ts";
import {
  latestSession,
  recoverSession,
  recoveryState,
  serverRecoveryState,
  serverSession,
  subscribeSession,
  withLatestSession,
} from "./session.ts";

/** The root loader's data, plus whether the session is still unknown. */
export interface BootstrapView extends Bootstrap {
  /**
   * The document could not check the session and no later lookup has answered yet: `me` is null
   * for now, but the visitor may well be signed in. Show a neutral account placeholder with a
   * Retry (`useSessionRetry`), never Sign in / Sign up or a signed-out view.
   */
  sessionUnresolved: boolean;
}

/**
 * `boot` with the newest browser lookup applied. While the document's own check was unavailable it
 * starts the automatic recovery (one at a time), so a member is never shown as signed out because
 * the API was busy.
 */
export function useBootstrapView(boot: Bootstrap, check: () => Promise<unknown>): BootstrapView {
  const latest = React.useSyncExternalStore(subscribeSession, latestSession, serverSession);
  const unavailable = boot.sessionUnavailable === true;
  const checkRef = React.useRef(check);
  React.useEffect(() => {
    checkRef.current = check;
  });
  React.useEffect(() => {
    if (unavailable) void recoverSession(() => checkRef.current());
  }, [unavailable]);
  return React.useMemo(() => {
    const view = withLatestSession(boot, latest);
    return { ...view, sessionUnresolved: view.sessionUnavailable === true };
  }, [boot, latest]);
}

export interface SessionRetry {
  /** Same as `useBootstrap().sessionUnresolved`. */
  unresolved: boolean;
  /** A lookup is under way (automatic or a pressed Retry). */
  retrying: boolean;
  /** The automatic retries ran out: say so next to the Retry. */
  gaveUp: boolean;
  /**
   * Ask now (then back off again if the API is still busy); once a lookup answers, reload the
   * route's data so the page renders for whoever is signed in. Works after the automatic
   * recovery gave up.
   */
  retry: () => void;
}

/** For the shell's account placeholder while the session is unresolved. */
export function useSessionRetryWith(unresolved: boolean, check: () => Promise<unknown>): SessionRetry {
  const router = useRouter();
  const state = React.useSyncExternalStore(subscribeSession, recoveryState, serverRecoveryState);
  const checkRef = React.useRef(check);
  React.useEffect(() => {
    checkRef.current = check;
  });
  const retry = React.useCallback(() => {
    void recoverSession(() => checkRef.current(), { immediate: true }).then(() => {
      const lookup = latestSession();
      if (lookup !== null && lookup.status !== "unavailable") return router.invalidate();
      return undefined;
    });
  }, [router]);
  return { unresolved, retrying: state === "retrying", gaveUp: state === "gaveUp", retry };
}
