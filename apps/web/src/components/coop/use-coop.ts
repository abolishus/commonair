// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { api, errorCode } from "../../lib/api.ts";
import type { MembershipViewDto } from "../../lib/coop.ts";
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
}

export interface CoopLoad<T> extends CoopRetryable {
  /** null until the first successful load for the current key (or when the answer is null). */
  data: T | null;
  /** The last failure, for pages that tell NOT_FOUND from a failed load. */
  error: unknown;
}

interface Answer<T> {
  key: string;
  loaded: boolean;
  data: T | null;
  failed: boolean;
  error: unknown;
}

/**
 * `useLoad` with an explicit state and the error: loads `load()` whenever `key` changes; an answer
 * for an older key or request is dropped, so a slow response cannot overwrite a newer one.
 */
export function useCoopLoad<T>(key: string, load: () => Promise<T>): CoopLoad<T> {
  const [answer, setAnswer] = React.useState<Answer<T>>({
    key,
    loaded: false,
    data: null,
    failed: false,
    error: null,
  });
  const seq = React.useRef(0);
  const loadRef = React.useRef(load);
  // Declared before the loading effect, so it runs first and the load sees the latest closure.
  React.useEffect(() => {
    loadRef.current = load;
  });

  const run = React.useCallback(() => {
    const id = ++seq.current;
    loadRef
      .current()
      .then((data) => {
        if (id === seq.current) setAnswer({ key, loaded: true, data, failed: false, error: null });
      })
      .catch((error: unknown) => {
        if (id === seq.current)
          setAnswer((prev) =>
            prev.key === key
              ? { ...prev, failed: true, error }
              : { key, loaded: false, data: null, failed: true, error },
          );
      });
  }, [key]);

  React.useEffect(() => {
    run();
    // The counter object itself, not a DOM ref: bumping it is how in-flight answers get dropped.
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [run]);

  const reload = React.useCallback(() => {
    // A retry after a failure shows the skeleton again rather than the stale error.
    setAnswer((prev) => (prev.key === key && !prev.loaded && prev.failed ? { ...prev, failed: false } : prev));
    run();
  }, [key, run]);

  const current: Answer<T> =
    answer.key === key ? answer : { key, loaded: false, data: null, failed: false, error: null };
  return {
    state: current.loaded ? "loaded" : current.failed ? "failed" : "loading",
    data: current.data,
    failed: current.failed,
    error: current.error,
    reload,
  };
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
