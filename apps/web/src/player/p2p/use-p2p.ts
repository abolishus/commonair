// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRouter } from "@tanstack/react-router";
import * as React from "react";
import { deviceSignals, p2pAllowed, type P2PDefault } from "./policy.ts";
import { ABSENT_PREFS, readP2PPrefs, subscribeP2PPrefs, type P2PPrefs } from "./preference.ts";

const noSubscribe = () => () => undefined;

/** False on the server and while hydrating, true on the client: device facts exist only there. */
export function useMounted(): boolean {
  return React.useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/** The viewer's P2P prefs on this device; follows changes from any player, settings or tab. */
export function useP2PPrefs(): P2PPrefs {
  return React.useSyncExternalStore(subscribeP2PPrefs, readP2PPrefs, () => ABSENT_PREFS);
}

/**
 * The operator's `P2P_DEFAULT` (`instance.info` `features.p2pDefault`) from the root loader's
 * data, `off` wherever it is missing (no router, or a bootstrap without it). `off` is the safe
 * reading: the viewer then has to opt in.
 */
export function useOperatorP2PDefault(): P2PDefault {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const root: unknown = router?.state.matches.find((m) => m.routeId === "__root__")?.loaderData;
  return p2pDefaultOf(root);
}

/** `p2pDefault` from a bootstrap-shaped value (`instance.p2pDefault` or `instance.features.p2pDefault`). */
export function p2pDefaultOf(bootstrap: unknown): P2PDefault {
  const instance = (bootstrap as { instance?: { p2pDefault?: unknown; features?: { p2pDefault?: unknown } } } | null)
    ?.instance;
  const value = instance?.p2pDefault ?? instance?.features?.p2pDefault;
  return value === "on" ? "on" : "off";
}

/**
 * Whether the switch shows P2P as on for this device: the viewer's choice, or the operator
 * default where the viewer has not chosen (on only where the device policy allows it).
 */
export function p2pSwitchOn(prefs: P2PPrefs, operatorDefault: P2PDefault): boolean {
  return p2pAllowed({ ...prefs, ...deviceSignals(), operatorDefault, dataMode: false, native: false });
}
