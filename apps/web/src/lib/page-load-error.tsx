// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LoadError } from "@commonair/ui/blocks/feedback";
import { PageContainer } from "@commonair/ui/layouts";
import { useRouter } from "@tanstack/react-router";
import * as React from "react";
import { loadErrorNote, loadErrorPageTitle, loadRetryLabel } from "./load-copy.ts";
import { isTransientFailure } from "./load-failure.ts";
import { autoRetryDelay } from "./retry.ts";
import { isSessionUnavailable } from "./session.ts";

/**
 * Whether an error boundary should show `PageLoadError` instead of its generic "Something went
 * wrong": the API was busy or unreachable (a guard's `SessionUnavailableError`, a loader's 429 or
 * 503), so the page will most likely load on a retry.
 */
export function isBusyPageError(error: unknown): boolean {
  return isSessionUnavailable(error) || isTransientFailure(error);
}

/** A serialized `SessionUnavailableError` (only its message survives) still retries as a 503. */
const busyError = { code: "SERVICE_UNAVAILABLE", status: 503 };

/**
 * The automatic retries of one page, across the boundary remounting on each failed retry: keyed by
 * the location, and forgotten after a quiet minute so a later failure starts over.
 */
const pageAttempts = new Map<string, { attempt: number; at: number }>();
const ATTEMPTS_TTL_MS = 60_000;

function attemptsFor(key: string, now: number): number {
  const entry = pageAttempts.get(key);
  if (!entry || now - entry.at > ATTEMPTS_TTL_MS) return 0;
  return entry.attempt;
}

/** For tests. */
export function resetPageAttemptsForTests(): void {
  pageAttempts.clear();
}

export interface PageLoadErrorProps {
  /** The error the boundary caught (`isBusyPageError(error)` holds). */
  error: unknown;
  /** The boundary's `reset`, run once the route's data was reloaded. */
  reset?: () => void;
  /** For tests: the clock (default `Date.now`). */
  now?: () => number;
}

/**
 * An error boundary's page when the API was busy or unreachable (F1, F2): never "Something went
 * wrong", but that the page did not load, a retry by itself after the server's `retryAfterSeconds`
 * (else 2, 4, 8 s, three times), and Retry. Each retry reloads the route's data
 * (`router.invalidate()`), which also re-runs the session guard.
 */
export function PageLoadError({ error, reset, now = Date.now }: PageLoadErrorProps): React.JSX.Element {
  const router = useRouter();
  const key = router.state.location.href;
  const attempt = attemptsFor(key, now());
  const delay = autoRetryDelay(isSessionUnavailable(error) && !isTransientFailure(error) ? busyError : error, attempt);

  const reload = React.useCallback(() => {
    void router.invalidate().finally(() => reset?.());
  }, [router, reset]);

  React.useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => {
      pageAttempts.set(key, { attempt: attempt + 1, at: now() });
      reload();
    }, delay);
    return () => clearTimeout(timer);
  }, [delay, key, attempt, now, reload]);

  const retryNow = () => {
    // A Retry by hand starts the automatic retries over.
    pageAttempts.delete(key);
    reload();
  };

  return (
    <PageContainer width="narrow" className="py-16">
      <LoadError
        data-testid="page-load-error"
        retryTestId="page-load-error-retry"
        headingLevel={1}
        busy={delay !== null}
        title={loadErrorPageTitle()}
        description={
          delay === null ? loadErrorNote("stillFailing") : loadErrorNote("busy", Math.max(1, Math.ceil(delay / 1000)))
        }
        retryLabel={loadRetryLabel(delay !== null)}
        onRetry={retryNow}
      />
    </PageContainer>
  );
}
