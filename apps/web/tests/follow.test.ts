// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
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
    expect(s).toEqual({ following: true, count: 11, pending: true, previous: { following: false, count: 10 } });
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
    expect(followReducer(s, { type: "success", following: true, count: 7 })).toEqual(initialFollowState(true, 7));
  });

  it("failure rolls back exactly", () => {
    const start = initialFollowState(true, 42);
    const s = followReducer(followReducer(start, { type: "start" }), { type: "failure" });
    expect(s).toEqual(start);
  });

  it("sync updates idle state but never an in-flight optimistic one", () => {
    const idle = followReducer(initialFollowState(false, 1), { type: "sync", following: true, count: 5 });
    expect(idle).toEqual(initialFollowState(true, 5));
    const pending = followReducer(initialFollowState(false, 1), { type: "start" });
    expect(followReducer(pending, { type: "sync", following: false, count: 1 })).toBe(pending);
  });

  it("sync with unknown following keeps the local value", () => {
    const s = followReducer(initialFollowState(true, 1), { type: "sync", following: null, count: 2 });
    expect(s.following).toBe(true);
    expect(s.count).toBe(2);
  });
});

describe("toggleFollow", () => {
  it("follows, staying pending until the API answers", async () => {
    const st = store(initialFollowState(false, 3));
    const d = deferred<{ following: boolean; followerCount: number }>();
    const calls: boolean[] = [];
    const call: FollowCall = (follow) => {
      calls.push(follow);
      return d.promise;
    };
    const done = toggleFollow(st.get(), call, st.dispatch, () => undefined);
    expect(st.get()).toMatchObject({ following: true, count: 4, pending: true });
    d.resolve({ following: true, followerCount: 4 });
    await done;
    expect(calls).toEqual([true]);
    expect(st.get()).toEqual(initialFollowState(true, 4));
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
    );
    expect(calls).toEqual([false]);
    expect(st.get()).toEqual(initialFollowState(false, 2));
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
    );
    expect(st.log).toEqual(["start", "failure"]);
    expect(st.get()).toEqual(initialFollowState(false, 3));
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
    );
    expect(called).toBe(false);
    expect(st.log).toEqual([]);
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
  };
  it("maps viewer.following and treats null/absent viewer as unknown", () => {
    const s = (viewer: unknown) => summarize({ ...base, viewer } as unknown as Parameters<typeof summarize>[0]);
    expect(s({ following: true })).toMatchObject({ following: true, followerCount: 12 });
    expect(s({ following: false }).following).toBe(false);
    expect(s(null).following).toBeNull();
    expect(s(undefined).following).toBeNull();
  });
});
