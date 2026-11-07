// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The session check's outcomes on both sides (F1). A guard that cannot learn who is signed in
 * throws `SessionUnavailableError`: the route renders its error page with Retry, never a redirect
 * to /signin. When the document's own check failed, the shell recovers here: the next lookup that
 * answers (a guard's, or the automatic retry `useBootstrap` starts) fills `me` in.
 */
import type { Bootstrap, SessionLookup, SessionUser } from "./bootstrap-types.ts";
import { autoRetryDelay, sleep } from "./retry.ts";

/** The message every `SessionUnavailableError` carries (it survives serialization). */
export const SESSION_UNAVAILABLE = "SESSION_UNAVAILABLE";

/** The API could not say whose session this is (429, 5xx, unreachable). Not "signed out". */
export class SessionUnavailableError extends Error {
  /** As oRPC errors carry it, so `autoRetryDelay` and `loadFailureKind` read it the same way. */
  readonly code = "SERVICE_UNAVAILABLE";
  readonly status = 503;
  readonly data: { retryAfterSeconds: number } | undefined;
  constructor(retryAfterSeconds: number | null = null) {
    super(SESSION_UNAVAILABLE);
    this.name = "SessionUnavailableError";
    this.data = retryAfterSeconds === null ? undefined : { retryAfterSeconds };
  }
}

export function isSessionUnavailable(err: unknown): boolean {
  return err instanceof SessionUnavailableError || (err instanceof Error && err.message === SESSION_UNAVAILABLE);
}

/** The user, null when signed out; throws `SessionUnavailableError` when nobody could say. */
export function sessionUserOf(lookup: SessionLookup): SessionUser | null {
  if (lookup.status === "signedIn") return lookup.user;
  if (lookup.status === "signedOut") return null;
  throw new SessionUnavailableError(lookup.retryAfterSeconds);
}

// ------------------------------------------------------------------ recovery (browser)

let latest: SessionLookup | null = null;
const listeners = new Set<() => void>();

/** Record a lookup made in the browser (a guard's or the recovery's); SSR never records. */
export function noteSession(lookup: SessionLookup): void {
  if (typeof window === "undefined") return;
  latest = lookup;
  for (const listener of listeners) listener();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The newest browser lookup, or null. */
export function latestSession(): SessionLookup | null {
  return latest;
}

/** The server snapshot: nothing was looked up in the browser yet. */
export function serverSession(): SessionLookup | null {
  return null;
}

/**
 * The bootstrap with a later lookup applied: only while the document's own check was unavailable,
 * and only a definitive answer (a still-unavailable lookup changes nothing).
 */
export function withLatestSession(boot: Bootstrap, lookup: SessionLookup | null): Bootstrap {
  if (!boot.sessionUnavailable || lookup === null || lookup.status === "unavailable") return boot;
  const { sessionUnavailable: _settled, ...rest } = boot;
  return { ...rest, me: lookup.status === "signedIn" ? lookup.user : null };
}

let recovering: Promise<void> | null = null;

/**
 * Where the shell's recovery stands: `retrying` while `recoverSession` runs, `gaveUp` once its
 * automatic retries ran out without an answer (only a Retry is left), else `idle`.
 */
export type RecoveryState = "idle" | "retrying" | "gaveUp";

let recovery: RecoveryState = "idle";

function setRecovery(next: RecoveryState): void {
  if (recovery === next) return;
  recovery = next;
  for (const listener of listeners) listener();
}

export function recoveryState(): RecoveryState {
  return recovery;
}

/** The server snapshot: no recovery runs during SSR. */
export function serverRecoveryState(): RecoveryState {
  return "idle";
}

export interface RecoverOptions {
  wait?: (ms: number) => Promise<void>;
  /**
   * Ask once straight away before backing off: a Retry the member pressed. The automatic
   * recovery waits first, since the document's own check has just failed.
   */
  immediate?: boolean;
}

/**
 * Ask again, a few times with backoff, until a lookup answers (`check` records it through
 * `noteSession`). One recovery at a time however many components ask for it; once one gave up, the
 * next call (a Retry) starts over.
 */
export function recoverSession(check: () => Promise<unknown>, opts: RecoverOptions = {}): Promise<void> {
  const wait = opts.wait ?? ((ms: number) => sleep(ms));
  recovering ??= (async () => {
    setRecovery("retrying");
    let failure: unknown = new SessionUnavailableError();
    let answered = false;
    const ask = async (): Promise<boolean> => {
      try {
        await check();
        return true;
      } catch (err) {
        failure = err;
        return false;
      }
    };
    try {
      if (opts.immediate) answered = await ask();
      for (let attempt = 0; !answered; attempt++) {
        const delay = autoRetryDelay(failure, attempt);
        if (delay === null) return;
        await wait(delay);
        answered = await ask();
      }
    } finally {
      recovering = null;
      setRecovery(answered ? "idle" : "gaveUp");
    }
  })();
  return recovering;
}

/** For tests: forget the recorded lookup. */
export function resetSessionForTests(): void {
  latest = null;
  recovering = null;
  recovery = "idle";
  listeners.clear();
}
