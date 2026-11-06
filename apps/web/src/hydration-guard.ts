// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The checks the client entry makes right before it hydrates (`client.tsx`).
 *
 * TanStack Start's `hydrate()` reads `window.$_TSR`, the bootstrap the server's HTML sets in an
 * inline script before the entry's `<script type="module" async>`, without checking it in
 * production builds. Missing, it throws `undefined is not an object (evaluating
 * 't.t=new Map(n.map(e=>[e.key,e.fromSerializable]))')` and the page stays inert server HTML
 * (CI, WebKit, watch-room edge-sync: runs 41922495854 attempt 3, 42134001057, 42215129857). The
 * global is only ever deleted by `$_TSR.h()` after a hydration has finished, so a missing one
 * means this document never got (or no longer has) the data hydration needs: reloading once is
 * the only way the viewer gets a working page. A reload that just happened is not repeated, so a
 * page that always lacks it cannot loop. A URL carrying a one-time parameter (an OAuth `code` or
 * `state`, a magic-link `token`, a `nonce`) is never reloaded: the second request would spend or
 * replay it.
 */

/** `sessionStorage` key: when this tab last reloaded for a missing bootstrap (epoch ms). */
export const BOOT_RELOAD_KEY = "commonair-boot-reload";
/** A second miss within this long of the reload hydrates anyway (and fails as before). */
export const BOOT_RELOAD_WINDOW_MS = 60_000;
/** `<html data-boot>`: what the guard found, for the harness's start-up diagnostics. */
export const BOOT_ATTRIBUTE = "boot";
/** Query parameters a reload could spend twice (compared case-insensitively). */
export const ONE_TIME_PARAMS: readonly string[] = ["token", "code", "state", "nonce"];

export type BootDecision =
  /** The bootstrap is there: hydrate. */
  | "hydrate"
  /** The entry's document is no longer the window's: it was navigated away from. Do nothing. */
  | "stale"
  /** No bootstrap, and no recent reload for it: reload once. */
  | "reload"
  /**
   * No bootstrap again right after a reload, nowhere to remember the reload, or a one-time
   * parameter in the URL: hydrate anyway.
   */
  | "missing";

type BootStorage = Pick<Storage, "getItem" | "setItem">;

export interface BootState {
  /** `document` when the entry module ran. */
  entryDocument: unknown;
  /** `window.document` now. */
  currentDocument: unknown;
  /** `window.$_TSR` now. */
  bootstrap: unknown;
  /** `sessionStorage`, or null where reading it throws. */
  storage: BootStorage | null;
  now: number;
  /** `location.search` now. */
  search: string;
}

/** Whether `search` carries a parameter a reload could spend twice (pure). */
export function hasOneTimeParam(search: string): boolean {
  for (const key of new URLSearchParams(search).keys()) if (ONE_TIME_PARAMS.includes(key.toLowerCase())) return true;
  return false;
}

function lastReload(storage: BootStorage): number | null {
  try {
    const value = Number(storage.getItem(BOOT_RELOAD_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Decide what the entry does; records the reload in `storage` when it decides one. */
export function bootDecision(state: BootState): BootDecision {
  if (state.currentDocument !== state.entryDocument) return "stale";
  if (typeof state.bootstrap === "object" && state.bootstrap !== null) return "hydrate";
  const { storage, now } = state;
  if (!storage || hasOneTimeParam(state.search)) return "missing";
  const last = lastReload(storage);
  if (last !== null && now - last >= 0 && now - last < BOOT_RELOAD_WINDOW_MS) return "missing";
  try {
    storage.setItem(BOOT_RELOAD_KEY, String(now));
  } catch {
    // Nowhere to remember it: a reload could repeat forever.
    return "missing";
  }
  return "reload";
}

/** `window.sessionStorage`, or null where touching it throws (blocked storage, sandboxed frames). */
export function sessionStore(): BootStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
