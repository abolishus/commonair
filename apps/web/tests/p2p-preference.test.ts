// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The per-device P2P choice and disclosure flag: storage present, absent, throwing; the change event. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ABSENT_PREFS,
  P2P_NOTICE_KEY,
  P2P_PREFERENCE_KEY,
  markP2PNoticeSeen,
  readP2PPrefs,
  setP2PPreference,
  setP2PStorage,
  subscribeP2PPrefs,
} from "../src/player/p2p/preference.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

afterEach(() => {
  setP2PStorage(null);
  localStorage.clear();
});

describe("keys", () => {
  it("match the harness contract", () => {
    expect([P2P_PREFERENCE_KEY, P2P_NOTICE_KEY]).toEqual(["commonair:p2p", "commonair:p2p-notice"]);
  });
});

describe("readP2PPrefs", () => {
  it("reads the browser's localStorage by default", () => {
    localStorage.setItem("commonair:p2p", "on");
    localStorage.setItem("commonair:p2p-notice", "seen");
    expect(readP2PPrefs()).toEqual({ preference: "on", noticeSeen: true });
  });

  it("absent keys and unknown values mean no choice and not seen", () => {
    expect(readP2PPrefs()).toEqual(ABSENT_PREFS);
    setP2PStorage(() => memoryStorage({ "commonair:p2p": "maybe", "commonair:p2p-notice": "yes" }));
    expect(readP2PPrefs()).toEqual({ preference: null, noticeSeen: false });
  });

  it("no storage at all reads as absent", () => {
    setP2PStorage(() => null);
    expect(readP2PPrefs()).toEqual(ABSENT_PREFS);
  });

  it("throwing storage (blocked, partitioned) reads as absent", () => {
    setP2PStorage(() => throwing);
    expect(readP2PPrefs()).toEqual(ABSENT_PREFS);
    setP2PStorage(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readP2PPrefs()).toEqual(ABSENT_PREFS);
  });

  it("returns the same object while nothing changed", () => {
    const store = memoryStorage({ "commonair:p2p": "off" });
    setP2PStorage(() => store);
    const a = readP2PPrefs();
    expect(readP2PPrefs()).toBe(a);
    store.setItem("commonair:p2p", "on");
    expect(readP2PPrefs()).not.toBe(a);
  });
});

describe("setP2PPreference / markP2PNoticeSeen", () => {
  it("a choice is stored and marks the disclosure seen", () => {
    const store = memoryStorage();
    setP2PStorage(() => store);
    setP2PPreference("on");
    expect(Object.fromEntries(store.data)).toEqual({ "commonair:p2p": "on", "commonair:p2p-notice": "seen" });
    setP2PPreference("off");
    expect(readP2PPrefs()).toEqual({ preference: "off", noticeSeen: true });
  });

  it("dismissing the notice sets only the notice flag", () => {
    const store = memoryStorage();
    setP2PStorage(() => store);
    markP2PNoticeSeen();
    expect(Object.fromEntries(store.data)).toEqual({ "commonair:p2p-notice": "seen" });
    expect(readP2PPrefs()).toEqual({ preference: null, noticeSeen: true });
  });

  it("with storage blocked, a choice still holds for this page", () => {
    setP2PStorage(() => throwing);
    setP2PPreference("off");
    expect(readP2PPrefs()).toEqual({ preference: "off", noticeSeen: true });
    setP2PStorage(() => throwing);
    markP2PNoticeSeen();
    expect(readP2PPrefs()).toEqual({ preference: null, noticeSeen: true });
  });
});

describe("change event", () => {
  it("notifies every subscriber on the page, and stops after unsubscribe", () => {
    setP2PStorage(() => memoryStorage());
    const a = vi.fn<() => void>();
    const b = vi.fn<() => void>();
    const offA = subscribeP2PPrefs(a);
    const offB = subscribeP2PPrefs(b);
    setP2PPreference("on");
    markP2PNoticeSeen();
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([2, 2]);
    offA();
    setP2PPreference("off");
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([2, 3]);
    offB();
  });

  it("notifies even when storage could not keep the choice", () => {
    setP2PStorage(() => throwing);
    const l = vi.fn<() => void>();
    const off = subscribeP2PPrefs(l);
    setP2PPreference("off");
    expect(l).toHaveBeenCalledTimes(1);
    off();
  });

  it("follows another tab's change of either key (the storage event), not other keys", () => {
    const l = vi.fn<() => void>();
    const off = subscribeP2PPrefs(l);
    window.dispatchEvent(new StorageEvent("storage", { key: "commonair:p2p", newValue: "off" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "commonair:p2p-notice", newValue: "seen" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else", newValue: "x" }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(l).toHaveBeenCalledTimes(3);
    off();
    window.dispatchEvent(new StorageEvent("storage", { key: "commonair:p2p", newValue: "on" }));
    expect(l).toHaveBeenCalledTimes(3);
  });
});
