// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether this device may ask for P2P (ADR 0005 amendment 1, decision 3). Pure: the browser
 * signals come in as arguments (`deviceSignals` reads them). The server adds the rest (18+,
 * mature, restricted, `P2P_ENABLED`) through `PlaybackStart.p2p.available` / `enabled`.
 */

/** The viewer's stored choice; null means none (the operator default applies). */
export type P2PPreference = "on" | "off" | null;
/** `instance.info` `features.p2pDefault`, the operator's `P2P_DEFAULT`. */
export type P2PDefault = "off" | "on";

export interface DeviceSignals {
  /** `matchMedia("(pointer: fine)")` matches: not a touch-primary device. */
  finePointer: boolean;
  /** `navigator.connection.saveData === true`. */
  saveData: boolean;
  /** `navigator.connection.type === "cellular"`. */
  cellular: boolean;
}

export interface P2PPolicyInput extends DeviceSignals {
  preference: P2PPreference;
  operatorDefault: P2PDefault;
  /** W1b data mode; it does not exist yet, so callers pass false. */
  dataMode: boolean;
  /** Native HLS (WebKit) has no loader to plug into. */
  native: boolean;
}

export function p2pAllowed(i: P2PPolicyInput): boolean {
  if (i.native || i.dataMode) return false;
  if (i.preference === "off") return false;
  // An explicit opt-in counts on any device; only the operator default looks at the device.
  if (i.preference === "on") return true;
  if (i.operatorDefault !== "on") return false;
  return i.finePointer && !i.saveData && !i.cellular;
}

/**
 * The first-run notice is due: the operator default would start P2P for a viewer who has not
 * chosen and has not yet seen the disclosure (decision 4). Never with the shipped default `off`.
 */
export function noticeDue(i: P2PPolicyInput & { noticeSeen: boolean }): boolean {
  return i.preference === null && !i.noticeSeen && p2pAllowed(i);
}

interface NetworkInformationLike {
  saveData?: unknown;
  type?: unknown;
}

/**
 * Read the device signals. A missing `navigator.connection` (Firefox, Safari) leaves the pointer
 * test to decide; a missing `matchMedia` counts as a coarse pointer (P2P stays off by default).
 */
export function deviceSignals(
  env: { matchMedia?: (q: string) => { matches: boolean }; navigator?: unknown } = globalThis,
): DeviceSignals {
  let finePointer = false;
  try {
    finePointer = env.matchMedia?.("(pointer: fine)").matches === true;
  } catch {
    finePointer = false;
  }
  const nav = env.navigator as { connection?: NetworkInformationLike } | undefined;
  const connection = nav?.connection;
  return {
    finePointer,
    saveData: connection?.saveData === true,
    cellular: connection?.type === "cellular",
  };
}
