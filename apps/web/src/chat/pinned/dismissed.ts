// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pinned items the viewer dismissed, for this tab only (`sessionStorage`), by `kind:id:status`:
 * an item comes back when its state changes. Storage can be missing or throw (private windows,
 * blocked site data); the tab then remembers dismissals in memory until it reloads.
 */
import * as React from "react";

export interface DismissStore {
  read(): string[];
  write(keys: readonly string[]): void;
}

const STORAGE_KEY = "commonair.chat.pinnedDismissed";
/** Enough for a long session; the oldest go first. */
export const MAX_DISMISSED = 50;

export function sessionDismissStore(): DismissStore {
  return {
    read() {
      try {
        const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
      } catch {
        return [];
      }
    },
    write(keys) {
      try {
        globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(keys));
      } catch {
        // Memory only for this tab.
      }
    },
  };
}

/** Adds `key`, keeping the newest `MAX_DISMISSED`. Pure. */
export function withDismissed(keys: readonly string[], key: string): string[] {
  const next = [...keys.filter((k) => k !== key), key];
  return next.slice(Math.max(0, next.length - MAX_DISMISSED));
}

export function useDismissed(store?: DismissStore): {
  dismissed: ReadonlySet<string>;
  dismiss: (key: string) => void;
} {
  const [s] = React.useState(() => store ?? sessionDismissStore());
  const [keys, setKeys] = React.useState<string[]>(() => s.read());
  const dismiss = React.useCallback(
    (key: string) =>
      setKeys((cur) => {
        const next = withDismissed(cur, key);
        s.write(next);
        return next;
      }),
    [s],
  );
  const dismissed = React.useMemo(() => new Set(keys), [keys]);
  return { dismissed, dismiss };
}
