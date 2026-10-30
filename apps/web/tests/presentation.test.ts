// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The presentation queue (ADR 0012 amendment 1 decision 3) with fake timers and a fake media clock. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_HOLD_MS,
  POLL_MS,
  SYNC_CHAT_KEY,
  presentationQueue,
  type PresentationItem,
  type PresentationKind,
} from "../src/chat/presentation.ts";
import { registerMediaClock, type PlaybackMode } from "../src/player/media-clock.ts";

const CHANNEL = "rivertide";
const T0 = Date.parse("2026-10-30T12:00:00.000Z");

/** A media clock under the test's control (playhead in epoch ms, null = unknown). */
const clock = { playhead: null as number | null, mode: "live" as PlaybackMode };
let unregister: () => void = () => undefined;

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
let storage = new MemoryStorage();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
  clock.playhead = T0 - 10_000;
  clock.mode = "live";
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  unregister = registerMediaClock(CHANNEL, {
    playheadWallclock: () => (clock.playhead === null ? null : new Date(clock.playhead)),
    playbackMode: () => clock.mode,
  });
});

afterEach(() => {
  unregister();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Item extends PresentationItem {
  id: string;
}
const iso = (ms: number) => new Date(ms).toISOString();
const item = (id: string, kind: PresentationKind, mediaTs: number | null, own = false): Item => ({
  id,
  kind,
  mediaTs: mediaTs === null ? null : iso(mediaTs),
  own,
});

function setup(creatorView = false) {
  const q = presentationQueue({ channel: CHANNEL, creatorView });
  const shown: string[] = [];
  const show = (i: Item) => shown.push(i.id);
  return { q, shown, present: (i: Item) => q.present(i, show) };
}

/** Advance the playhead (and the wall clock) by `ms`, running the poll timer. */
async function play(ms: number): Promise<void> {
  const step = POLL_MS;
  for (let done = 0; done < ms; done += step) {
    if (clock.playhead !== null) clock.playhead += step;
    await vi.advanceTimersByTimeAsync(step);
  }
}

describe("own items", () => {
  it("show at once, alerts and chat alike, even with sync on and alerts held", () => {
    const t = setup();
    t.q.syncChat = true;
    t.present(item("held", "alert", T0 - 2_000));
    t.present(item("mine-chat", "chat", T0, true));
    t.present(item("mine-alert", "alert", T0, true));
    expect(t.shown).toEqual(["mine-chat", "mine-alert"]);
  });
});

describe("alerts", () => {
  it("are held until the playhead reaches mediaTs", async () => {
    const t = setup();
    t.present(item("a", "alert", T0 - 5_000));
    expect(t.shown).toEqual([]);
    await play(4_500);
    expect(t.shown).toEqual([]);
    await play(1_000);
    expect(t.shown).toEqual(["a"]);
  });

  it("show at once when the playhead is already past mediaTs", () => {
    const t = setup();
    t.present(item("past", "alert", T0 - 20_000));
    expect(t.shown).toEqual(["past"]);
  });

  it("are released at 60 s at the latest, even if the playhead never gets there", async () => {
    const t = setup();
    clock.playhead = T0 - 120_000;
    t.present(item("far", "alert", T0));
    // The playhead does not move (a frozen player).
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - POLL_MS);
    expect(t.shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    expect(t.shown).toEqual(["far"]);
  });

  it("are not held in dvr mode", () => {
    clock.mode = "dvr";
    const t = setup();
    t.present(item("dvr", "alert", T0));
    expect(t.shown).toEqual(["dvr"]);
  });

  it("held ones go out when the player switches to dvr", async () => {
    const t = setup();
    t.present(item("a", "alert", T0));
    clock.mode = "dvr";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.shown).toEqual(["a"]);
  });

  it("are never held for the creator's own page", () => {
    const t = setup(true);
    t.q.syncChat = true;
    t.present(item("alert", "alert", T0));
    t.present(item("chat", "chat", T0));
    expect(t.shown).toEqual(["alert", "chat"]);
  });

  it("with a null or unparsable mediaTs show at once", () => {
    const t = setup();
    t.present(item("null", "alert", null));
    t.q.present({ id: "bad", kind: "alert", mediaTs: "not a date", own: false }, (i) => t.shown.push(i.id));
    expect(t.shown).toEqual(["null", "bad"]);
  });

  it("without a playhead (no player, or before its first frame) show at once", () => {
    clock.playhead = null;
    const t = setup();
    t.present(item("a", "alert", T0));
    expect(t.shown).toEqual(["a"]);
    unregister();
    const u = setup();
    u.present(item("b", "alert", T0));
    expect(u.shown).toEqual(["b"]);
  });

  it("keep order: a later item that is already due waits for the held one before it", async () => {
    const t = setup();
    t.present(item("first", "alert", T0 - 4_000));
    t.present(item("second", "alert", T0 - 30_000));
    t.present(item("third", "alert", null));
    expect(t.shown).toEqual([]);
    await play(6_500);
    expect(t.shown).toEqual(["first", "second", "third"]);
  });

  it("kinds are independent: a held alert does not hold chat", () => {
    const t = setup();
    t.present(item("alert", "alert", T0));
    t.present(item("chat", "chat", T0));
    expect(t.shown).toEqual(["chat"]);
  });
});

describe("chat", () => {
  it("shows at once by default (sync off)", () => {
    const t = setup();
    expect(t.q.syncChat).toBe(false);
    t.present(item("c", "chat", T0));
    expect(t.shown).toEqual(["c"]);
  });

  it("is held like alerts with syncChat on, in order, and the choice is stored per device", async () => {
    const t = setup();
    t.q.syncChat = true;
    expect(storage.getItem(SYNC_CHAT_KEY)).toBe("1");
    t.present(item("c1", "chat", T0 - 3_000));
    t.present(item("c2", "chat", T0 - 1_000));
    await play(7_250);
    expect(t.shown).toEqual(["c1"]);
    await play(2_000);
    expect(t.shown).toEqual(["c1", "c2"]);
    // A new queue (another page load) reads the stored choice.
    expect(setup().q.syncChat).toBe(true);
  });

  it("turning sync off releases held lines at once, in order, and clears the stored choice", () => {
    const t = setup();
    t.q.syncChat = true;
    t.present(item("c1", "chat", T0));
    t.present(item("c2", "chat", T0 + 1_000));
    expect(t.shown).toEqual([]);
    t.q.syncChat = false;
    expect(t.shown).toEqual(["c1", "c2"]);
    expect(storage.getItem(SYNC_CHAT_KEY)).toBeNull();
    t.present(item("c3", "chat", T0 + 5_000));
    expect(t.shown).toEqual(["c1", "c2", "c3"]);
  });
});

describe("localStorage", () => {
  it("throwing on read: sync defaults off; throwing on write: the choice holds for the page", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    const t = setup();
    expect(t.q.syncChat).toBe(false);
    t.q.syncChat = true;
    expect(t.q.syncChat).toBe(true);
    t.present(item("held", "chat", T0));
    expect(t.shown).toEqual([]);
    t.q.syncChat = false;
    expect(t.shown).toEqual(["held"]);
  });

  it("an accessor that throws (blocked site data) reads as off", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      const t = setup();
      expect(t.q.syncChat).toBe(false);
      expect(() => {
        t.q.syncChat = true;
      }).not.toThrow();
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("dispose", () => {
  it("flushes nothing and clears the timer", async () => {
    const t = setup();
    t.present(item("a", "alert", T0 - 1_000));
    t.q.dispose();
    await play(MAX_HOLD_MS + 1_000);
    expect(t.shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after dispose nothing is held (an unmounted or re-run panel never loses a line)", () => {
    const t = setup();
    t.q.dispose();
    t.present(item("late", "alert", T0));
    expect(t.shown).toEqual(["late"]);
  });

  it("no timer runs while nothing is held", () => {
    const t = setup();
    t.present(item("a", "chat", T0));
    t.present(item("b", "alert", T0 - 60_000));
    expect(vi.getTimerCount()).toBe(0);
  });
});
