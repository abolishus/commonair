// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The browser half of F1 and F2: failure kinds, automatic backoff, and recovering the session. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Bootstrap, SessionLookup, SessionUser } from "../src/lib/bootstrap-types.ts";
import { errorStatus, isTransientFailure, loadFailureKind, retryAfterSeconds } from "../src/lib/load-failure.ts";
import {
  AUTO_RETRY_MAX_MS,
  AUTO_RETRY_MIN_MS,
  autoRetriesExhausted,
  autoRetryDelay,
  sleep,
  withBackoff,
} from "../src/lib/retry.ts";
import {
  SESSION_UNAVAILABLE,
  SessionUnavailableError,
  isSessionUnavailable,
  latestSession,
  noteSession,
  recoverSession,
  resetSessionForTests,
  sessionUserOf,
  subscribeSession,
  withLatestSession,
} from "../src/lib/session.ts";

const err = (fields: Record<string, unknown>) => Object.assign(new Error("x"), fields);
const busy = (seconds?: number) =>
  err({
    code: "RATE_LIMITED",
    status: 429,
    ...(seconds === undefined ? {} : { data: { retryAfterSeconds: seconds } }),
  });

afterEach(() => {
  resetSessionForTests();
  vi.useRealTimers();
});

describe("loadFailureKind", () => {
  it.each([
    [err({ code: "UNAUTHORIZED", status: 401 }), "unauthorized"],
    [err({ code: "FORBIDDEN", status: 403 }), "forbidden"],
    [err({ code: "NOT_FOUND", status: 404 }), "notFound"],
    [busy(3), "busy"],
    [err({ code: "TOO_MANY_REQUESTS", status: 429 }), "busy"],
    [err({ status: 429 }), "busy"],
    [err({ code: "BAD_GATEWAY", status: 502 }), "unavailable"],
    [err({ code: "SERVICE_UNAVAILABLE", status: 503 }), "unavailable"],
    [err({ code: "MALFORMED_ORPC_ERROR_RESPONSE", status: 504 }), "unavailable"],
    [new TypeError("Failed to fetch"), "unavailable"],
    [err({ code: "INTERNAL_SERVER_ERROR", status: 500 }), "failed"],
    [err({ code: "INTERNAL_SERVER_ERROR" }), "failed"],
    [err({ code: "CONFLICT", status: 409 }), "failed"],
    [new Error("bug"), "failed"],
    ["text", "failed"],
    [null, "failed"],
  ] as const)("%o → %s", (error, kind) => {
    expect(loadFailureKind(error)).toBe(kind);
  });

  it("transient means busy or unavailable", () => {
    expect(isTransientFailure(busy())).toBe(true);
    expect(isTransientFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientFailure(err({ status: 500 }))).toBe(false);
    expect(isTransientFailure(err({ status: 401 }))).toBe(false);
  });

  it("reads the status and the retry hint defensively", () => {
    expect(errorStatus(err({ status: 429 }))).toBe(429);
    expect(errorStatus(err({ status: "429" }))).toBeNull();
    expect(errorStatus(err({ status: 42 }))).toBeNull();
    expect(errorStatus(null)).toBeNull();
    expect(retryAfterSeconds(busy(5))).toBe(5);
    expect(retryAfterSeconds(err({ data: { retryAfterSeconds: -1 } }))).toBeNull();
    expect(retryAfterSeconds(err({ data: { retryAfterSeconds: "5" } }))).toBeNull();
    expect(retryAfterSeconds(err({ data: null }))).toBeNull();
    expect(retryAfterSeconds(err({}))).toBeNull();
  });
});

describe("autoRetryDelay", () => {
  const mid = () => 0.5;
  it("uses the server's hint, at least a second and at most the cap", () => {
    expect(autoRetryDelay(busy(4), 0)).toBe(4_000);
    expect(autoRetryDelay(busy(0), 0)).toBe(AUTO_RETRY_MIN_MS);
    expect(autoRetryDelay(busy(0.2), 0)).toBe(AUTO_RETRY_MIN_MS);
    expect(autoRetryDelay(busy(3600), 0)).toBe(AUTO_RETRY_MAX_MS);
  });

  it("doubles from 2 s without a hint, with ±25 % jitter", () => {
    expect([0, 1, 2].map((a) => autoRetryDelay(busy(), a, { random: mid }))).toEqual([2_000, 4_000, 8_000]);
    expect(autoRetryDelay(busy(), 0, { random: () => 0 })).toBe(1_500);
    expect(autoRetryDelay(busy(), 0, { random: () => 1 })).toBe(2_500);
    expect(autoRetryDelay(busy(), 0, { random: () => 7 })).toBe(2_500);
    expect(autoRetryDelay(busy(), 9, { random: mid, attempts: 20 })).toBe(AUTO_RETRY_MAX_MS);
  });

  it("stops after three retries, and never retries a non-transient failure", () => {
    expect(autoRetryDelay(busy(1), 2)).toBe(1_000);
    expect(autoRetryDelay(busy(1), 3)).toBeNull();
    expect(autoRetryDelay(busy(1), -1)).toBeNull();
    expect(autoRetryDelay(err({ status: 500 }), 0)).toBeNull();
    expect(autoRetryDelay(err({ status: 401 }), 0)).toBeNull();
    expect(autoRetriesExhausted(busy(1), 3)).toBe(true);
    expect(autoRetriesExhausted(busy(1), 2)).toBe(false);
    expect(autoRetriesExhausted(err({ status: 500 }), 3)).toBe(false);
  });
});

describe("withBackoff", () => {
  it("retries a busy load and resolves with its answer", async () => {
    const waits: number[] = [];
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busy(2))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn<(info: { attempt: number; delayMs: number; error: unknown }) => void>();
    const result = await withBackoff(load, {
      random: () => 0.5,
      onRetry,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result).toBe("ok");
    expect(waits).toEqual([2_000, 4_000]);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([0, 1]);
  });

  it("rethrows a non-transient failure at once, and the last one when retries run out", async () => {
    const wait = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fatal = err({ status: 500 });
    await expect(withBackoff(() => Promise.reject(fatal), { wait })).rejects.toBe(fatal);
    expect(wait).not.toHaveBeenCalled();
    const last = busy(1);
    await expect(withBackoff(() => Promise.reject(last), { wait })).rejects.toBe(last);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const load = vi.fn<() => Promise<string>>(async () => {
      controller.abort(new Error("left"));
      throw busy(1);
    });
    await expect(withBackoff(load, { signal: controller.signal })).rejects.toMatchObject({ status: 429 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("sleep resolves after the wait and rejects on abort", async () => {
    vi.useFakeTimers();
    const done = sleep(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    const controller = new AbortController();
    const aborted = sleep(1_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(aborted).rejects.toThrow("stop");
    const pre = new AbortController();
    pre.abort(new Error("already"));
    await expect(sleep(5, pre.signal)).rejects.toThrow("already");
  });
});

const user: SessionUser = { id: "u1", username: "wren", displayName: "Wren", channelSlug: null, role: "user" };

function boot(over: Partial<Bootstrap> = {}): Bootstrap {
  return {
    config: {} as Bootstrap["config"],
    instance: { name: "Air", sourceUrl: null, p2pDefault: "off", chatSafety: false },
    me: null,
    theme: "dark",
    now: 0,
    locale: "en",
    dir: "ltr",
    localeFromUser: false,
    consent: null,
    ...over,
  };
}

describe("the session outcomes", () => {
  it("sessionUserOf: the user, null, or a SessionUnavailableError", () => {
    expect(sessionUserOf({ status: "signedIn", user })).toBe(user);
    expect(sessionUserOf({ status: "signedOut" })).toBeNull();
    let thrown: unknown;
    try {
      sessionUserOf({ status: "unavailable", retryAfterSeconds: 4 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SessionUnavailableError);
    expect(thrown).toMatchObject({ status: 503, data: { retryAfterSeconds: 4 } });
    expect(isTransientFailure(thrown)).toBe(true);
    expect(autoRetryDelay(thrown, 0)).toBe(4_000);
  });

  it("isSessionUnavailable survives serialization (the message)", () => {
    expect(isSessionUnavailable(new SessionUnavailableError())).toBe(true);
    expect(isSessionUnavailable(new Error(SESSION_UNAVAILABLE))).toBe(true);
    expect(isSessionUnavailable(new Error("other"))).toBe(false);
    expect(isSessionUnavailable(null)).toBe(false);
  });

  it("withLatestSession fills me in only while the document's check was unavailable", () => {
    const unknown = boot({ sessionUnavailable: true });
    const signedIn: SessionLookup = { status: "signedIn", user };
    const recovered = withLatestSession(unknown, signedIn);
    expect(recovered.me).toBe(user);
    expect("sessionUnavailable" in recovered).toBe(false);
    expect(withLatestSession(unknown, { status: "signedOut" }).me).toBeNull();
    expect(withLatestSession(unknown, { status: "signedOut" }).sessionUnavailable).toBeUndefined();
    expect(withLatestSession(unknown, { status: "unavailable", retryAfterSeconds: null })).toBe(unknown);
    expect(withLatestSession(unknown, null)).toBe(unknown);
    const settled = boot();
    expect(withLatestSession(settled, signedIn)).toBe(settled);
  });

  it("noteSession records a browser lookup and tells subscribers", () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeSession(listener);
    noteSession({ status: "signedIn", user });
    expect(latestSession()).toEqual({ status: "signedIn", user });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    noteSession({ status: "signedOut" });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("recoverSession", () => {
  it("waits, then asks again with backoff until a lookup answers", async () => {
    const waits: number[] = [];
    const check = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new SessionUnavailableError(3))
      .mockResolvedValue(user);
    await recoverSession(check, {
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(1_500);
    expect(waits[1]).toBe(3_000);
  });

  it("gives up after the automatic retries, and on a failure that is not transient", async () => {
    const wait = async () => {};
    const always = vi.fn<() => Promise<unknown>>(async () => {
      throw new SessionUnavailableError();
    });
    await recoverSession(always, { wait });
    expect(always).toHaveBeenCalledTimes(3);
    const fatal = vi.fn<() => Promise<unknown>>(async () => {
      throw err({ status: 500 });
    });
    await recoverSession(fatal, { wait });
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("runs one recovery at a time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = vi.fn<() => Promise<unknown>>(async () => user);
    const wait = () => gate;
    const a = recoverSession(check, { wait });
    const b = recoverSession(check, { wait });
    expect(a).toBe(b);
    release();
    await a;
    expect(check).toHaveBeenCalledOnce();
  });
});
