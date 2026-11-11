// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.moderates` for the chrome (ux-journeys J5-a): the studio nav's "Channels you moderate" group
 * and the account menu's "Mod view" read the same list, so one request per member and page load
 * serves both. The list is a convenience: a failed read shows nothing extra and is asked again on
 * the next mount (the mod view itself checks the role).
 */
import type { ModeratedChannel } from "@commonair/contracts/dto";
import * as React from "react";
import { api } from "../../lib/api.ts";

export type ModeratesLoader = () => Promise<ModeratedChannel[]>;

// Async, so a client without the procedure (an old fake) rejects instead of throwing.
const apiLoad: ModeratesLoader = async () => api().me.moderates();

/** A role granted meanwhile shows up after this long without a reload. */
export const MODERATES_TTL_MS = 5 * 60_000;

const cache = new Map<string, { at: number; pending: Promise<ModeratedChannel[]> }>();

/** For tests: forget every cached list. */
export function forgetModerates(): void {
  cache.clear();
}

/** The member's list, shared across callers; a failure is dropped from the cache and reads as empty. */
export function loadModerates(
  userId: string,
  load: ModeratesLoader = apiLoad,
  now: number = Date.now(),
): Promise<ModeratedChannel[]> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < MODERATES_TTL_MS) return hit.pending;
  const pending = load().catch(() => {
    if (cache.get(userId)?.pending === pending) cache.delete(userId);
    return [];
  });
  cache.set(userId, { at: now, pending });
  return pending;
}

/** `userId` null (signed out): always empty, nothing is read. */
export function useModerates(userId: string | null, load?: ModeratesLoader): readonly ModeratedChannel[] {
  const [state, setState] = React.useState<{ userId: string | null; list: readonly ModeratedChannel[] }>({
    userId,
    list: [],
  });
  React.useEffect(() => {
    if (userId === null) return undefined;
    let cancelled = false;
    void loadModerates(userId, load).then((list) => {
      if (!cancelled) setState({ userId, list });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, load]);
  return state.userId === userId && userId !== null ? state.list : [];
}
