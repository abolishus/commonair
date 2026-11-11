// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Continue watching's data (D3.6): the browser's resume points (`lib/resume.ts`), read after
 * hydration (the server has none, so the first render matches it) and again when another tab
 * changes them. Remove drops one point here and in storage.
 */
import * as React from "react";
import { RESUME_KEY, clearResumePoint, readResumePoints, type ResumePoint } from "../../lib/resume.ts";

const EMPTY: ResumePoint[] = [];

let cache: { raw: string | null; points: ResumePoint[] } | null = null;
const listeners = new Set<() => void>();

function rawValue(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

/** A stable snapshot: the same array until the stored value changes. */
function snapshot(): ResumePoint[] {
  const raw = rawValue();
  if (cache && cache.raw === raw) return cache.points;
  cache = { raw, points: readResumePoints() };
  return cache.points;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === RESUME_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useResumePoints(): { points: ResumePoint[]; remove: (vodId: string) => void } {
  const points = React.useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const remove = React.useCallback((vodId: string) => {
    clearResumePoint(vodId);
    for (const listener of listeners) listener();
  }, []);
  return { points, remove };
}

/** Tests: forget the cached snapshot. */
export function resetResumeCache(): void {
  cache = null;
}
