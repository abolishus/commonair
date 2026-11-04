// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Below Tailwind's `sm` (640 px): where a table whose key columns are money or actions becomes
 * stacked rows (F31). One rendering at a time, not both with CSS: a hidden copy would double every
 * row's test id and its buttons. The server and the first client render say "wide", so the
 * hydrated markup matches; a phone switches right after.
 */
import * as React from "react";

export const NARROW_QUERY = "(max-width: 639.98px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const snapshot = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;

export function useNarrow(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}
