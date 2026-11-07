// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { api, errorCode } from "../../lib/api.ts";
import type { MembershipViewDto } from "../../lib/coop.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import type { Paged } from "../money/use-load.ts";

/**
 * Where a co-op load stands: `loading` until the first answer for the current key, `loaded` once
 * one arrived (even if a later reload failed), `failed` when there is no answer to show. A page
 * renders `failed` as `coop-load-error` with `coop-retry`, never a skeleton that waits forever.
 */
export type CoopLoadState = "loading" | "loaded" | "failed";

/** What a page needs to decide between skeleton, content and the retry block. */
export interface CoopRetryable {
  state: CoopLoadState;
  /** The last attempt failed (with or without older data still shown). */
  failed: boolean;
  /** Load again, keeping what is shown until the answer arrives. */
  reload: () => void;
  /** An automatic retry runs in this many ms (absent or null: none scheduled). */
  retryInMs?: number | null;
  /** The automatic retries ran out. */
  gaveUp?: boolean;
  /** A retry is under way without a known wait. */
  busy?: boolean;
}

export interface CoopLoad<T> extends CoopRetryable {
  /** null until the first successful load for the current key (or when the answer is null). */
  data: T | null;
  /** The last failure, for pages that tell NOT_FOUND from a failed load. */
  error: unknown;
  retryInMs: number | null;
  gaveUp: boolean;
}

/**
 * `useRetryingLoad` for co-op pages: loads `load()` whenever `key` changes, retries a busy (429) or
 * unreachable answer by itself with backoff, and drops an answer for an older key or request, so a
 * slow response cannot overwrite a newer one.
 */
export function useCoopLoad<T>(key: string, load: () => Promise<T>): CoopLoad<T> {
  return useRetryingLoad(key, load);
}

/** A paged list as a retryable load (its first page decides the state). */
export function pagedLoad<T>(p: Paged<T>): CoopRetryable {
  return {
    state: p.items !== null ? "loaded" : p.failed ? "failed" : "loading",
    failed: p.failed,
    reload: p.reload,
  };
}

export interface CoopLoadsStatus {
  /** Some load has nothing to show: render the retry block instead of the page. */
  failed: boolean;
  /** Some load has data but its last reload failed: render the retry block above the page. */
  stale: boolean;
  /** Re-run every load whose last attempt failed (no full page reload). */
  retry: () => void;
}

/** One status for a page's loads. Pure: `retry` reloads exactly the failed ones. */
export function coopLoads(loads: readonly CoopRetryable[]): CoopLoadsStatus {
  const failing = loads.filter((l) => l.failed || l.state === "failed");
  return {
    failed: loads.some((l) => l.state === "failed"),
    stale: loads.some((l) => l.state === "loaded" && l.failed),
    retry: () => {
      for (const l of failing) l.reload();
    },
  };
}

/** The caller's memberships, or null data while signed out (no call is made then). */
export function useMyMembership(me: SessionUser | null): CoopLoad<MembershipViewDto | null> {
  return useCoopLoad(me ? `membership|${me.id}` : "membership|-", () =>
    me ? api().coop.membership() : Promise.resolve(null),
  );
}

/** The page shows the not-found state only when the API said so; anything else can be retried. */
export const isNotFound = (load: CoopLoad<unknown>): boolean =>
  load.state === "failed" && errorCode(load.error) === "NOT_FOUND";

/** The generic toast for a refused co-op action ("sign in again" when the session is gone). */
export function toastCoopError(err: unknown): void {
  toastActionError(err, t("coop.actionFailed"));
}
