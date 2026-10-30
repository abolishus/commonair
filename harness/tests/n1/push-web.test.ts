// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 7's pieces: the PushManager stub, the decrypted payload check and the step's shape. */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { STUB_STORAGE_KEY, goLivePushProblems, installPushStub, step } from "../../src/n1/push-web.ts";

interface StubSub {
  endpoint: string;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}
interface StubManager {
  subscribe(): Promise<StubSub>;
  getSubscription(): Promise<StubSub | null>;
}

const g = globalThis as Record<string, unknown>;
const saved = { PushManager: g.PushManager, sessionStorage: g.sessionStorage };

afterEach(() => {
  g.PushManager = saved.PushManager;
  g.sessionStorage = saved.sessionStorage;
});

function fakePage(): StubManager {
  const store = new Map<string, string>();
  g.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  class PushManager {}
  g.PushManager = PushManager;
  installPushStub({ endpoint: "http://h:1/push/x", keys: { p256dh: "P", auth: "A" }, storageKey: STUB_STORAGE_KEY });
  return new PushManager() as StubManager;
}

describe("step 7", () => {
  it("is N1-pwa's, web only, needs steps 4 and 6 and web push", () => {
    expect(step).toMatchObject({ owner: "N1-pwa", needs: [4, 6], webOnly: true, requires: ["webPush"] });
  });
});

describe("installPushStub", () => {
  it("has no subscription until subscribe, then the harness one, until unsubscribe", async () => {
    const manager = fakePage();
    expect(await manager.getSubscription()).toBeNull();
    const sub = await manager.subscribe();
    expect(sub.toJSON()).toEqual({
      endpoint: "http://h:1/push/x",
      expirationTime: null,
      keys: { p256dh: "P", auth: "A" },
    });
    expect((await manager.getSubscription())?.endpoint).toBe("http://h:1/push/x");
    expect(await sub.unsubscribe()).toBe(true);
    expect(await manager.getSubscription()).toBeNull();
  });

  it("does nothing where there is no PushManager", () => {
    delete g.PushManager;
    expect(() =>
      installPushStub({ endpoint: "x", keys: { p256dh: "P", auth: "A" }, storageKey: STUB_STORAGE_KEY }),
    ).not.toThrow();
  });
});

describe("goLivePushProblems", () => {
  const ok = JSON.stringify({ v: 1, type: "go_live", slug: "abc_d", title: "t" });

  it("accepts the go-live payload, with an empty title too", () => {
    expect(goLivePushProblems(ok, "abc_d")).toEqual([]);
    expect(goLivePushProblems(JSON.stringify({ v: 1, type: "go_live", slug: "abc_d", title: "" }), "abc_d")).toEqual(
      [],
    );
  });

  it("refuses another channel, version, type, extra fields and non-JSON", () => {
    expect(goLivePushProblems(ok, "other")).toHaveLength(1);
    expect(
      goLivePushProblems(JSON.stringify({ v: 2, type: "go_live", slug: "abc_d", title: "" }), "abc_d"),
    ).toHaveLength(1);
    expect(goLivePushProblems(JSON.stringify({ v: 1, type: "raid", slug: "abc_d", title: "" }), "abc_d")).toHaveLength(
      1,
    );
    expect(
      goLivePushProblems(JSON.stringify({ v: 1, type: "go_live", slug: "abc_d", title: "", email: "x" }), "abc_d"),
    ).toEqual(["unexpected fields email"]);
    expect(goLivePushProblems("not json", "abc_d")).toHaveLength(1);
    expect(goLivePushProblems("null", "abc_d")).toHaveLength(1);
  });
});
