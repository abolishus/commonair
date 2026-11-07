// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { autoRetriesExhausted, autoRetryDelay } from "./retry.ts";

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;

/** A stable key for an object (a client passed as a prop), so a new one loads again. */
export function objectKey(value: object): string {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = ++nextObjectId;
    objectIds.set(value, id);
  }
  return String(id);
}

/**
 * Where a load stands: `loading` until the first answer for the current key, `loaded` once one
 * arrived (even if a later reload failed), `failed` when there is no answer to show.
 */
export type LoadState = "loading" | "loaded" | "failed";

/** How a failed load is retrying: what a section's `LoadError` says next to its Retry. */
export interface RetryStatus {
  /** The last attempt failed (with or without older data still shown). */
  failed: boolean;
  /** The last failure. */
  error: unknown;
  /** An automatic retry is scheduled in this many ms (busy or unreachable API), else null. */
  retryInMs: number | null;
  /** The automatic retries ran out: only Retry is left ("Still not loading"). */
  gaveUp: boolean;
  /** Load again now (resets the automatic retries), keeping what is shown until it answers. */
  reload: () => void;
}

export interface RetryingLoad<T> extends RetryStatus {
  state: LoadState;
  /** null until the first successful load for the current key (or when the answer is null). */
  data: T | null;
}

interface Answer<T> {
  key: string;
  loaded: boolean;
  data: T | null;
  failed: boolean;
  error: unknown;
  retryInMs: number | null;
  gaveUp: boolean;
}

const fresh = <T>(key: string): Answer<T> => ({
  key,
  loaded: false,
  data: null,
  failed: false,
  error: null,
  retryInMs: null,
  gaveUp: false,
});

/**
 * Loads `load()` whenever `key` changes. A busy (429) or unreachable answer retries by itself with
 * backoff (`autoRetryDelay`: the server's `retryAfterSeconds`, else 2, 4, 8 s, three times); any
 * other failure waits for Retry. An answer for an older key or request is dropped, so a slow
 * response cannot overwrite a newer one.
 */
export function useRetryingLoad<T>(key: string, load: () => Promise<T>): RetryingLoad<T> {
  const [answer, setAnswer] = React.useState<Answer<T>>(() => fresh<T>(key));
  const seq = React.useRef(0);
  const attempt = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = React.useRef(load);
  // Declared before the loading effect, so it runs first and the load sees the latest closure.
  React.useEffect(() => {
    loadRef.current = load;
  });

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const run = React.useCallback(() => {
    // Named so an automatic retry can run it again with the same key.
    const attemptLoad = (): void => {
      clearTimer();
      const id = ++seq.current;
      loadRef
        .current()
        .then((data) => {
          if (id !== seq.current) return;
          attempt.current = 0;
          setAnswer({ key, loaded: true, data, failed: false, error: null, retryInMs: null, gaveUp: false });
        })
        .catch((error: unknown) => {
          if (id !== seq.current) return;
          const retryInMs = autoRetryDelay(error, attempt.current);
          const gaveUp = autoRetriesExhausted(error, attempt.current);
          if (retryInMs !== null) {
            attempt.current++;
            timer.current = setTimeout(() => {
              if (id === seq.current) attemptLoad();
            }, retryInMs);
          }
          setAnswer((prev) =>
            prev.key === key
              ? { ...prev, failed: true, error, retryInMs, gaveUp }
              : { ...fresh<T>(key), failed: true, error, retryInMs, gaveUp },
          );
        });
    };
    attemptLoad();
  }, [key, clearTimer]);

  React.useEffect(() => {
    attempt.current = 0;
    run();
    // The counter object itself, not a DOM ref: bumping it is how in-flight answers get dropped.
    const counter = seq;
    return () => {
      counter.current++;
      clearTimer();
    };
  }, [run, clearTimer]);

  const reload = React.useCallback(() => {
    attempt.current = 0;
    // A retry after a failure shows the skeleton again rather than the stale error.
    setAnswer((prev) =>
      prev.key === key && !prev.loaded && prev.failed
        ? { ...prev, failed: false, retryInMs: null, gaveUp: false }
        : prev,
    );
    run();
  }, [key, run]);

  const current: Answer<T> = answer.key === key ? answer : fresh<T>(key);
  return {
    state: current.loaded ? "loaded" : current.failed ? "failed" : "loading",
    data: current.data,
    failed: current.failed,
    error: current.error,
    retryInMs: current.retryInMs,
    gaveUp: current.gaveUp,
    reload,
  };
}
