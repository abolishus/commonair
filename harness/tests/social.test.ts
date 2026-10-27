// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure parts of the E2 social scenario (docs/testing/e2-selectors.md). */
import { describe, expect, test } from "vite-plus/test";
import { CHAT_LIMITS } from "@commonair/contracts/chat";
import {
  DUPLICATE_MARGIN_MS,
  HELD_SETTLE_MS,
  VIA,
  armAfterWait,
  duplicateWaitMs,
  holdWord,
  parseVia,
} from "../scenarios/e2e-social.ts";
import type { ApiClient } from "../src/api/client.ts";
import type { ChatClient } from "../src/chat-client.ts";
import {
  ApiActor,
  HELD_POLL_MS,
  heldListed,
  DISCOVERY_SECTIONS,
  TIMEOUT_SECONDS,
  isActiveTimeout,
  remainingMs,
  sectionsWith,
  timeoutDurationOk,
} from "../src/social.ts";

const card = (slug: string) => ({ channel: { slug } });

describe("sectionsWith", () => {
  test("maps API keys to web data-section names", () => {
    const home = {
      spotlight: [card("a")],
      newAndLive: [card("b"), card("a")],
      live: [card("a"), card("c")],
      following: [card("c")],
    };
    expect(sectionsWith(home, "a")).toEqual(["spotlight", "new", "live"]);
    expect(sectionsWith(home, "c")).toEqual(["live", "following"]);
    expect(sectionsWith(home, "zz")).toEqual([]);
    expect(sectionsWith({ spotlight: [], newAndLive: [], live: [], following: [] }, "a")).toEqual([]);
  });

  test("discovery never counts the following section", () => {
    expect(DISCOVERY_SECTIONS).not.toContain("following");
    expect([...DISCOVERY_SECTIONS].sort()).toEqual(["live", "new", "spotlight"]);
  });
});

describe("timeoutDurationOk", () => {
  test("accepts the requested length rounded down a little, never more", () => {
    expect(TIMEOUT_SECONDS).toBe(600);
    expect(timeoutDurationOk(600)).toBe(true);
    expect(timeoutDurationOk(599)).toBe(true);
    expect(timeoutDurationOk(585)).toBe(true);
    expect(timeoutDurationOk(584)).toBe(false);
    expect(timeoutDurationOk(601)).toBe(false);
    expect(timeoutDurationOk(null)).toBe(false);
    expect(timeoutDurationOk(30, 30, 0)).toBe(true);
  });
});

describe("isActiveTimeout", () => {
  test("only an expiry in the future", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(isActiveTimeout({ expiresAt: "2026-10-18T12:10:00Z" }, now)).toBe(true);
    expect(isActiveTimeout({ expiresAt: "2026-10-18T12:00:00Z" }, now)).toBe(false);
    expect(isActiveTimeout({ expiresAt: null }, now)).toBe(false);
  });
});

describe("--set via", () => {
  test("web (default) or api", () => {
    expect(VIA).toEqual(["web", "api"]);
    expect(parseVia("web")).toBe("web");
    expect(parseVia("api")).toBe("api");
    expect(() => parseVia("tui")).toThrow(/via=tui/);
  });
});

describe("remainingMs", () => {
  test("time to the deadline, capped, never below 1 ms", () => {
    expect(remainingMs(10_000, Infinity, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 2_500, 4_000)).toBe(2_500);
    expect(remainingMs(10_000, 2_500, 9_000)).toBe(1_000);
    expect(remainingMs(10_000, 2_500, 12_000)).toBe(1);
  });
});

type Frame = ChatClient["frames"][number];

/** Just enough of ChatClient for ApiActor: frames, listeners, join, close. */
function fakeChat() {
  const frames: Frame[] = [];
  const listeners = new Set<(f: Frame) => void>();
  let closed = false;
  const chat = {
    frames,
    get isOpen() {
      return !closed;
    },
    onFrame(l: (f: Frame) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    messages: () => frames.filter((f) => f.op === "message"),
    next(op: string, pred: (f: Frame) => boolean, timeoutMs: number) {
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout ${op}`)), timeoutMs);
        const l = (f: Frame) => {
          if (f.op !== op || !pred(f)) return;
          clearTimeout(timer);
          listeners.delete(l);
          resolve(f);
        };
        listeners.add(l);
      });
    },
    waitFor(op: string, pred: (f: Frame) => boolean, timeoutMs: number) {
      const seen = frames.find((f) => f.op === op && pred(f));
      return seen ? Promise.resolve(seen) : chat.next(op, pred, timeoutMs);
    },
    join: async () => undefined,
    close: () => {
      closed = true;
    },
  };
  return {
    chat: chat as unknown as ChatClient,
    emit(f: Frame) {
      frames.push(f);
      for (const l of listeners) l(f);
    },
    listeners,
    get closed() {
      return closed;
    },
  };
}

const OWNER = "0193a1b2-0000-7000-8000-000000000001";
const FAN = "0193a1b2-0000-7000-8000-000000000002";
const fakeApi = (viewer: { following: boolean } | null) =>
  ({
    channels: { get: async () => ({ owner: { id: OWNER }, viewer, followerCount: 0 }) },
  }) as unknown as ApiClient;

describe("ApiActor", () => {
  test("hasFollowControl: signed in and not the owner", async () => {
    const chat = fakeChat();
    const owner = new ApiActor("streamer", "st", OWNER, fakeApi({ following: false }), async () => chat.chat);
    const fan = new ApiActor("fan", "fan", FAN, fakeApi({ following: false }), async () => chat.chat);
    const anon = new ApiActor("anon", "anon", FAN, fakeApi(null), async () => chat.chat);
    for (const a of [owner, fan, anon]) await a.openChannel("st");
    expect(await owner.hasFollowControl()).toBe(false);
    expect(await fan.hasFollowControl()).toBe(true);
    expect(await anon.hasFollowControl()).toBe(false);
  });

  test("close() closes the chat socket", async () => {
    const chat = fakeChat();
    const a = new ApiActor("fan", "fan", FAN, fakeApi(null), async () => chat.chat);
    a.close();
    await a.openChannel("st");
    a.close();
    expect(chat.closed).toBe(true);
  });

  test("waitDeleted resolves on a ban frame and releases its listener; times out otherwise", async () => {
    const chat = fakeChat();
    const a = new ApiActor("fan", "fan", FAN, fakeApi(null), async () => chat.chat);
    await a.openChannel("st");
    const signal = new AbortController().signal;
    const waiting = a.waitDeleted("m1", "troll", "", { timeoutMs: 2_000, signal });
    expect(chat.listeners.size).toBe(1);
    chat.emit({ op: "ban", channel: "other", userId: OWNER, username: "troll", expiresAt: null, reason: "" });
    chat.emit({ op: "ban", channel: "st", userId: OWNER, username: "troll", expiresAt: null, reason: "" });
    await waiting;
    expect(chat.listeners.size).toBe(0);
    // Already seen: resolves at once.
    await a.waitDeleted("m1", "troll", "", { timeoutMs: 50, signal });
    await expect(a.waitDeleted("m2", "nobody", "", { timeoutMs: 30, signal })).rejects.toThrow(/nobody/);
    expect(chat.listeners.size).toBe(0);
  });
});

describe("duplicateWaitMs (the SDK-bot !ping must not hit chat's duplicate filter)", () => {
  test("waits out the full duplicate window plus margin after the tmi.js bot's first pong", () => {
    const at = 1_000_000;
    expect(duplicateWaitMs(at, at)).toBe(CHAT_LIMITS.duplicateWindowMs + DUPLICATE_MARGIN_MS);
    expect(duplicateWaitMs(at, at + 5_000)).toBe(CHAT_LIMITS.duplicateWindowMs + DUPLICATE_MARGIN_MS - 5_000);
  });
  test("no wait once the window has passed, or with no earlier reply", () => {
    expect(duplicateWaitMs(0, CHAT_LIMITS.duplicateWindowMs + DUPLICATE_MARGIN_MS)).toBe(0);
    expect(duplicateWaitMs(0, 10 * CHAT_LIMITS.duplicateWindowMs)).toBe(0);
    expect(duplicateWaitMs(undefined, 0)).toBe(0);
  });
  test("pins the dependency on chat's 30 s window (update the scenario if it changes)", () => {
    expect(CHAT_LIMITS.duplicateWindowMs).toBe(30_000);
  });
});

describe("armAfterWait (reply waiters start their timeout only after the duplicate-window wait)", () => {
  test("arms after the wait has finished", async () => {
    const order: string[] = [];
    const armed = await armAfterWait(
      30_000,
      async (ms) => {
        order.push(`wait ${ms}`);
        await Promise.resolve();
        order.push("waited");
      },
      () => {
        order.push("arm");
        return "waiters";
      },
    );
    expect(armed).toBe("waiters");
    expect(order).toEqual(["wait 30000", "waited", "arm"]);
  });

  test("skips the wait when nothing is left to wait out", async () => {
    const order: string[] = [];
    await armAfterWait(
      0,
      async () => {
        order.push("wait");
      },
      () => order.push("arm"),
    );
    expect(order).toEqual(["arm"]);
  });

  test("never arms when the wait is aborted", async () => {
    let armed = false;
    await expect(
      armAfterWait(
        5_000,
        () => Promise.reject(new Error("aborted")),
        () => {
          armed = true;
        },
      ),
    ).rejects.toThrow("aborted");
    expect(armed).toBe(false);
  });
});

describe("held messages (E7)", () => {
  const MSG = "0193a1b2-0000-7000-8000-0000000000aa";
  const signal = new AbortController().signal;
  const message = (id: string, held?: boolean): Frame => ({
    op: "message",
    channel: "st",
    message: {
      id,
      channelId: OWNER,
      user: { id: FAN, username: "troll", displayName: "troll", color: null, badges: [], accountType: "human" },
      body: "x",
      emotes: [],
      isAction: false,
      replyTo: null,
      createdAt: "2026-10-27T10:00:00.000Z",
    },
    ...(held === undefined ? {} : { held }),
  });

  test("holdWord is a lowercase alphanumeric word unique to the run", () => {
    expect(holdWord("Run-2026_10-27T09:00:AbC")).toMatch(/^heldword[a-z0-9]{1,12}$/);
    expect(holdWord("a")).not.toBe(holdWord("b"));
    expect(HELD_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
  });

  test("heldListed", () => {
    expect(heldListed([{ id: "a" }, { id: MSG }], MSG)).toBe(true);
    expect(heldListed([], MSG)).toBe(false);
  });

  test("hasMessageId / waitMessageId ignore held frames (moderator copies)", async () => {
    const chat = fakeChat();
    const a = new ApiActor("streamer", "st", OWNER, fakeApi(null), async () => chat.chat);
    await a.openChannel("st");
    chat.emit(message(MSG, true));
    expect(await a.hasMessageId(MSG)).toBe(false);
    await expect(a.waitMessageId(MSG, { timeoutMs: 30, signal })).rejects.toThrow(/timeout/);
    const waiting = a.waitMessageId(MSG, { timeoutMs: 2_000, signal });
    chat.emit(message(MSG));
    await waiting;
    expect(await a.hasMessageId(MSG)).toBe(true);
  });

  test("allowHeld polls chat.held.list until the row is stored, then resolves it", async () => {
    let calls = 0;
    const resolved: unknown[] = [];
    const api = {
      chat: {
        held: {
          list: async () => (++calls < 3 ? [] : [{ id: MSG }]),
          resolve: async (input: unknown) => {
            resolved.push(input);
            return { ok: true };
          },
        },
      },
    } as unknown as ApiClient;
    const chat = fakeChat();
    const a = new ApiActor("streamer", "st", OWNER, api, async () => chat.chat);
    await a.openChannel("st");
    await a.allowHeld(MSG, { timeoutMs: 10 * HELD_POLL_MS, signal });
    expect(calls).toBe(3);
    expect(resolved).toEqual([{ channel: "st", id: MSG, allow: true }]);
  });

  test("waitClear only counts a clear that arrives after the call", async () => {
    const chat = fakeChat();
    const a = new ApiActor("fan", "fan", FAN, fakeApi(null), async () => chat.chat);
    await a.openChannel("st");
    chat.emit({ op: "clear", channel: "st" });
    await expect(a.waitClear({ timeoutMs: 30, signal })).rejects.toThrow(/timeout/);
    const waiting = a.waitClear({ timeoutMs: 2_000, signal });
    chat.emit({ op: "clear", channel: "other" });
    chat.emit({ op: "clear", channel: "st" });
    await waiting;
  });
});
