// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { isSessionExpired } from "../src/lib/action-error.ts";
import { summarize } from "../src/lib/channel-summary.ts";
import {
  followReducer,
  initialFollowState,
  toggleFollow,
  type FollowAction,
  type FollowCall,
  type FollowState,
} from "../src/lib/follow.ts";

/** A dispatch that applies actions to a local state, like useReducer. */
function store(initial: FollowState) {
  let state = initial;
  const log: FollowAction["type"][] = [];
  return {
    get: () => state,
    log,
    dispatch: (a: FollowAction) => {
      log.push(a.type);
      state = followReducer(state, a);
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("followReducer", () => {
  it("start flips optimistically and remembers the previous state", () => {
    const s = followReducer(initialFollowState(false, 10), { type: "start" });
    expect(s).toEqual({
      following: true,
      count: 11,
      pending: true,
      previous: { following: false, count: 10 },
      settledAt: 0,
    });
    const u = followReducer(initialFollowState(true, 10), { type: "start" });
    expect(u.following).toBe(false);
    expect(u.count).toBe(9);
  });

  it("treats unknown as not following and never goes below zero", () => {
    expect(followReducer(initialFollowState(null, 0), { type: "start" }).following).toBe(true);
    expect(followReducer(initialFollowState(true, 0), { type: "start" }).count).toBe(0);
  });

  it("ignores start while a request is in flight", () => {
    const s = followReducer(initialFollowState(false, 1), { type: "start" });
    expect(followReducer(s, { type: "start" })).toBe(s);
  });

  it("success adopts the server's count", () => {
    const s = followReducer(initialFollowState(false, 1), { type: "start" });
    expect(followReducer(s, { type: "success", following: true, count: 7, at: 50 })).toEqual({
      ...initialFollowState(true, 7),
      settledAt: 50,
    });
  });

  it("failure rolls back exactly", () => {
    const start = initialFollowState(true, 42);
    const s = followReducer(followReducer(start, { type: "start" }), { type: "failure", at: 9 });
    expect(s).toEqual({ ...start, settledAt: 9 });
  });

  it("sync updates idle state but never an in-flight optimistic one", () => {
    const idle = followReducer(initialFollowState(false, 1), {
      type: "sync",
      following: true,
      count: 5,
      requestedAt: 1,
    });
    expect(idle).toEqual(initialFollowState(true, 5));
    const pending = followReducer(initialFollowState(false, 1), { type: "start" });
    expect(followReducer(pending, { type: "sync", following: false, count: 1, requestedAt: 1 })).toBe(pending);
  });

  it("sync with unknown following keeps the local value", () => {
    const s = followReducer(initialFollowState(true, 1), { type: "sync", following: null, count: 2, requestedAt: 1 });
    expect(s.following).toBe(true);
    expect(s.count).toBe(2);
  });
});

describe("toggleFollow", () => {
  const clock = () => 100;

  it("follows, staying pending until the API answers", async () => {
    const st = store(initialFollowState(false, 3));
    const d = deferred<{ following: boolean; followerCount: number }>();
    const calls: boolean[] = [];
    const call: FollowCall = (follow) => {
      calls.push(follow);
      return d.promise;
    };
    const done = toggleFollow(st.get(), call, st.dispatch, () => undefined, clock);
    expect(st.get()).toMatchObject({ following: true, count: 4, pending: true });
    d.resolve({ following: true, followerCount: 4 });
    await done;
    expect(calls).toEqual([true]);
    expect(st.get()).toEqual({ ...initialFollowState(true, 4), settledAt: 100 });
  });

  it("unfollows when following", async () => {
    const st = store(initialFollowState(true, 3));
    const calls: boolean[] = [];
    await toggleFollow(
      st.get(),
      async (follow) => {
        calls.push(follow);
        return { following: false, followerCount: 2 };
      },
      st.dispatch,
      () => undefined,
      clock,
    );
    expect(calls).toEqual([false]);
    expect(st.get()).toEqual({ ...initialFollowState(false, 2), settledAt: 100 });
  });

  it("rolls back and reports the error when the API fails", async () => {
    const st = store(initialFollowState(false, 3));
    const errors: unknown[] = [];
    const boom = new Error("nope");
    await toggleFollow(
      st.get(),
      async () => {
        throw boom;
      },
      st.dispatch,
      (e) => errors.push(e),
      clock,
    );
    expect(st.log).toEqual(["start", "failure"]);
    expect(st.get()).toEqual({ ...initialFollowState(false, 3), settledAt: 100 });
    expect(errors).toEqual([boom]);
  });

  it("does nothing while a request is in flight", async () => {
    const st = store(followReducer(initialFollowState(false, 3), { type: "start" }));
    let called = false;
    await toggleFollow(
      st.get(),
      async () => {
        called = true;
        return { following: true, followerCount: 4 };
      },
      st.dispatch,
      () => undefined,
      clock,
    );
    expect(called).toBe(false);
    expect(st.log).toEqual([]);
  });
});

describe("poll racing a toggle", () => {
  it("drops a poll that started before the toggle settled, even if it resolves after", async () => {
    let clockMs = 1_000;
    const now = () => clockMs;
    const st = store(initialFollowState(false, 3));
    // Poll starts (reads the pre-follow state on the server)…
    const pollRequestedAt = now();
    clockMs = 1_100;
    // …then the user follows and the API answers.
    await toggleFollow(
      st.get(),
      async () => ({ following: true, followerCount: 4 }),
      st.dispatch,
      () => undefined,
      now,
    );
    expect(st.get()).toMatchObject({ following: true, count: 4, pending: false, settledAt: 1_100 });
    // The stale poll resolves afterwards with the old values: ignored.
    st.dispatch({ type: "sync", following: false, count: 3, requestedAt: pollRequestedAt });
    expect(st.get()).toMatchObject({ following: true, count: 4 });
    // A poll requested at the settle instant is ambiguous: also ignored.
    st.dispatch({ type: "sync", following: false, count: 3, requestedAt: 1_100 });
    expect(st.get().following).toBe(true);
    // The next poll (started after) is adopted, e.g. someone else followed too.
    st.dispatch({ type: "sync", following: true, count: 5, requestedAt: 1_200 });
    expect(st.get()).toMatchObject({ following: true, count: 5 });
  });

  it("drops a stale poll after a rollback too", async () => {
    const st = store(initialFollowState(true, 3));
    await toggleFollow(
      st.get(),
      async () => {
        throw new Error("down");
      },
      st.dispatch,
      () => undefined,
      () => 500,
    );
    st.dispatch({ type: "sync", following: false, count: 2, requestedAt: 400 });
    expect(st.get()).toMatchObject({ following: true, count: 3 });
  });

  it("adopts the SSR snapshot before any toggle", () => {
    const s = followReducer(initialFollowState(null, 0), { type: "sync", following: true, count: 9, requestedAt: 0 });
    // settledAt 0 and requestedAt 0: nothing to protect yet, but the rule is <=, so the reducer keeps the initial.
    expect(s).toEqual(initialFollowState(null, 0));
    const polled = followReducer(s, { type: "sync", following: true, count: 9, requestedAt: 1 });
    expect(polled).toMatchObject({ following: true, count: 9 });
  });
});

describe("isSessionExpired", () => {
  it("is true only for UNAUTHORIZED", () => {
    expect(isSessionExpired({ code: "UNAUTHORIZED" })).toBe(true);
    expect(isSessionExpired({ code: "FORBIDDEN" })).toBe(false);
    expect(isSessionExpired(new Error("network"))).toBe(false);
    expect(isSessionExpired(null)).toBe(false);
  });
});

describe("summarize follow fields", () => {
  const base = {
    slug: "streamer_one",
    displayName: "Streamer",
    title: "t",
    avatarUrl: null,
    live: null,
    followerCount: 12,
    theme: {},
  };
  it("maps viewer.following and treats null/absent viewer as unknown", () => {
    const s = (viewer: unknown) => summarize({ ...base, viewer } as unknown as Parameters<typeof summarize>[0]);
    expect(s({ following: true })).toMatchObject({ following: true, followerCount: 12 });
    expect(s({ following: false }).following).toBe(false);
    expect(s(null).following).toBeNull();
    expect(s(undefined).following).toBeNull();
  });
  it("carries the channel accent token, null when none was picked", () => {
    const s = (theme: unknown) => summarize({ ...base, theme } as unknown as Parameters<typeof summarize>[0]);
    expect(s({ accent: "teal" }).accent).toBe("teal");
    expect(s({}).accent).toBeNull();
  });
});
