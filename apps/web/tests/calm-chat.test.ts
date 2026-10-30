// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat's pure parts (feature-wins §4.2): the wave view over the log, the rate governor, the
 * digest text and cadence, the per-device settings (storage that throws included) and the live-chat
 * block set.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  blockSnapshot,
  loadBlocks,
  noteBlocked,
  noteUnblocked,
  resetBlocks,
  type BlocksClient,
} from "../src/chat/blocks.ts";
import { DIGEST_INTERVAL_MS, Digest, digestText, EMPTY_STATS } from "../src/chat/calm/digest.ts";
import { PRIORITY, RateGovernor, clampRate, priorityOf } from "../src/chat/calm/governor.ts";
import {
  WAVE_WINDOW_MS,
  calmRows,
  groupMessages,
  joinsShownWave,
  standsAlone,
  waveReport,
  withoutBlocked,
  type CalmRow,
} from "../src/chat/calm/reducer.ts";
import {
  CALM_SETTINGS_KEY,
  DEFAULT_CALM_SETTINGS,
  parseCalmSettings,
  readCalmSettings,
  setCalmStorage,
  subscribeCalmSettings,
  writeCalmSettings,
} from "../src/chat/calm/settings.ts";
import type { ChatMessageFrame } from "../src/chat/connection.ts";
import type { ChatRow } from "../src/chat/state.ts";

const UUID = (n: number) => `0193f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
type Badge = ChatMessageFrame["user"]["badges"][number]["type"];

function msg(
  n: number,
  body: string,
  o: { at?: number; user?: number; badges?: Badge[]; replyTo?: ChatMessageFrame["replyTo"] } = {},
): ChatMessageFrame {
  const user = o.user ?? 100 + n;
  return {
    id: UUID(n),
    channelId: UUID(9999),
    user: {
      id: UUID(user),
      username: `user${user}`,
      displayName: `User ${user}`,
      color: null,
      badges: (o.badges ?? []).map((type) => ({ type })),
      accountType: "human",
    },
    body,
    emotes: [],
    isAction: false,
    replyTo: o.replyTo ?? null,
    createdAt: new Date(T0 + (o.at ?? n * 100)).toISOString(),
  };
}
const row = (m: ChatMessageFrame, deleted = false): ChatRow => ({ kind: "message", id: m.id, message: m, deleted });
const SELF = "fan_one";

/** A compact picture of the view: `w:<id>x<count>` for a wave, the message id or row id otherwise. */
function shape(rows: CalmRow[]): string[] {
  return rows.map((r) => (r.kind === "wave" ? `w:${r.wave.id}x${r.wave.count}` : r.row.id));
}

describe("calmRows (the wave view)", () => {
  it("is empty for an empty log", () => {
    expect(calmRows([], { self: SELF })).toEqual([]);
    expect(groupMessages([], { self: SELF }).size).toBe(0);
  });

  it("collapses repeats within the window into one wave at the latest message", () => {
    const rows = [
      row(msg(1, "PogChamp", { at: 0 })),
      row(msg(2, "hello", { at: 100 })),
      row(msg(3, "pogchamp", { at: 200 })),
      row(msg(4, "POGCHAMP", { at: 300 })),
    ];
    expect(shape(calmRows(rows, { self: SELF }))).toEqual([UUID(2), `w:${UUID(1)}x3`]);
    const wave = calmRows(rows, { self: SELF }).find((r) => r.kind === "wave");
    if (wave?.kind !== "wave") throw new Error("no wave");
    expect(wave.wave.senders).toBe(3);
    expect(wave.wave.first.id).toBe(UUID(1));
    expect(wave.wave.latest.id).toBe(UUID(4));
    expect(wave.expanded).toBe(false);
  });

  it("a single message stays a plain row", () => {
    expect(shape(calmRows([row(msg(1, "hi"))], { self: SELF }))).toEqual([UUID(1)]);
  });

  it("the window boundary: exactly 5 s after the previous message joins, 1 ms later starts anew", () => {
    const joined = [row(msg(1, "gg", { at: 0 })), row(msg(2, "gg", { at: WAVE_WINDOW_MS }))];
    expect(shape(calmRows(joined, { self: SELF }))).toEqual([`w:${UUID(1)}x2`]);
    const apart = [row(msg(1, "gg", { at: 0 })), row(msg(2, "gg", { at: WAVE_WINDOW_MS + 1 }))];
    expect(shape(calmRows(apart, { self: SELF }))).toEqual([UUID(1), UUID(2)]);
  });

  it("the window slides with the wave: a steady stream stays one wave", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(msg(i + 1, "spam", { at: i * 4_000 })));
    expect(shape(calmRows(rows, { self: SELF }))).toEqual([`w:${UUID(1)}x6`]);
  });

  it("never collapses a mention of the viewer, a reply to them, their own line, the broadcaster or a moderator", () => {
    const rows = [
      row(msg(1, "gg", { at: 0 })),
      row(msg(2, "gg @Fan_One", { at: 10 })),
      row(msg(3, "gg", { at: 20, badges: ["broadcaster"] })),
      row(msg(4, "gg", { at: 30, badges: ["moderator"] })),
      row(msg(5, "gg", { at: 40, replyTo: { id: UUID(77), username: SELF, body: "x" } })),
      row({ ...msg(6, "gg", { at: 50 }), user: { ...msg(6, "gg").user, username: SELF } }),
      row(msg(7, "gg", { at: 60 })),
    ];
    expect(shape(calmRows(rows, { self: SELF }))).toEqual([
      UUID(2),
      UUID(3),
      UUID(4),
      UUID(5),
      UUID(6),
      `w:${UUID(1)}x2`,
    ]);
  });

  it("never takes in a held message", () => {
    const rows = [row(msg(1, "gg", { at: 0 })), row(msg(2, "gg", { at: 10 })), row(msg(3, "gg", { at: 20 }))];
    const view = calmRows(rows, { self: SELF, held: new Set([UUID(2)]) });
    expect(shape(view)).toEqual([UUID(2), `w:${UUID(1)}x2`]);
    expect(standsAlone(msg(2, "gg"), { self: SELF, held: new Set([UUID(2)]) })).toBe(true);
  });

  it("vip and subscriber badges do not stand alone", () => {
    expect(standsAlone(msg(1, "x", { badges: ["vip", "subscriber"] }), { self: SELF })).toBe(false);
  });

  it("deleted messages leave the wave and the count drops; a wave of one becomes a row", () => {
    const m = [msg(1, "go", { at: 0 }), msg(2, "go", { at: 10 }), msg(3, "go", { at: 20 })];
    expect(shape(calmRows([row(m[0]!), row(m[1]!, true), row(m[2]!)], { self: SELF }))).toEqual([`w:${UUID(1)}x2`]);
    expect(shape(calmRows([row(m[0]!, true), row(m[1]!, true), row(m[2]!)], { self: SELF }))).toEqual([UUID(3)]);
    expect(calmRows([row(m[0]!, true)], { self: SELF })).toEqual([]);
  });

  it("a wave the log's cap cut down to one copy keeps its wave row and id; a deletion does not", () => {
    const m = [msg(1, "go", { at: 0 }), msg(2, "go", { at: 10 }), msg(3, "go", { at: 20 })];
    const waveIds = new Map(m.map((x) => [x.id, UUID(1)]));
    // The cap dropped copies 1 and 2: copy 3 is still the wave first shown as UUID(1).
    expect(shape(calmRows([row(m[2]!)], { self: SELF, waveIds }))).toEqual([`w:${UUID(1)}x1`]);
    expect(shape(calmRows([row(m[2]!)], { self: SELF, waveIds, admitted: new Set([UUID(3)]) }))).toEqual([
      `w:${UUID(1)}x1`,
    ]);
    // Deleted copies are still in the log: the wave of one becomes a row.
    expect(shape(calmRows([row(m[0]!, true), row(m[1]!, true), row(m[2]!)], { self: SELF, waveIds }))).toEqual([
      UUID(3),
    ]);
    // Never remembered as a wave: a plain row.
    expect(shape(calmRows([row(m[2]!)], { self: SELF, waveIds: new Map() }))).toEqual([UUID(3)]);
  });

  it("a ban (every message of the user marked deleted) shrinks the wave and its sender count", () => {
    const rows = [
      row(msg(1, "spam", { at: 0, user: 1 })),
      row(msg(2, "spam", { at: 10, user: 1 }), true),
      row(msg(3, "spam", { at: 20, user: 2 })),
      row(msg(4, "spam", { at: 30, user: 3 })),
    ];
    const wave = calmRows(rows, { self: SELF })[0];
    if (wave?.kind !== "wave") throw new Error("no wave");
    expect(wave.wave.count).toBe(3);
    expect(wave.wave.senders).toBe(3);
  });

  it("a harassment wave counts its distinct senders", () => {
    const rows = [1, 2, 3, 4].map((n) => row(msg(n, "go away", { at: n, user: n % 2 })));
    const wave = calmRows(rows, { self: SELF })[0];
    if (wave?.kind !== "wave") throw new Error("no wave");
    expect(wave.wave.count).toBe(4);
    expect(wave.wave.senders).toBe(2);
  });

  it("expands a wave by its id", () => {
    const rows = [row(msg(1, "x", { at: 0 })), row(msg(2, "x", { at: 1 }))];
    const view = calmRows(rows, { self: SELF, expanded: new Set([UUID(1)]) });
    const first = view[0];
    if (first?.kind !== "wave") throw new Error("no wave");
    expect(first.expanded).toBe(true);
    expect(first.wave.messages.map((m) => m.id)).toEqual([UUID(1), UUID(2)]);
  });

  it("keeps notices and events in place", () => {
    const rows: ChatRow[] = [
      { kind: "notice", id: "n1", code: "msg_slowmode" },
      row(msg(1, "x", { at: 0 })),
      row(msg(2, "x", { at: 1 })),
    ];
    expect(shape(calmRows(rows, { self: SELF }))).toEqual(["n1", `w:${UUID(1)}x2`]);
  });

  it("with an admitted set: a lone row shows only when admitted, a wave when any member was", () => {
    const rows = [row(msg(1, "a", { at: 0 })), row(msg(2, "b", { at: 1 })), row(msg(3, "b", { at: 2 }))];
    expect(shape(calmRows(rows, { self: SELF, admitted: new Set() }))).toEqual([]);
    expect(shape(calmRows(rows, { self: SELF, admitted: new Set([UUID(3)]) }))).toEqual([`w:${UUID(2)}x2`]);
    expect(shape(calmRows(rows, { self: SELF, admitted: new Set([UUID(1)]) }))).toEqual([UUID(1)]);
  });

  it("joinsShownWave: true only when another message of the same wave is shown", () => {
    const rows = [row(msg(1, "b", { at: 0 })), row(msg(2, "b", { at: 1 })), row(msg(3, "c", { at: 2 }))];
    const groups = groupMessages(rows, { self: SELF });
    const shown = (ids: string[]) => (id: string) => ids.includes(id);
    expect(joinsShownWave(groups, UUID(2), shown([UUID(1)]))).toBe(true);
    expect(joinsShownWave(groups, UUID(2), shown([UUID(2)]))).toBe(false);
    expect(joinsShownWave(groups, UUID(2), shown([]))).toBe(false);
    expect(joinsShownWave(groups, UUID(3), shown([UUID(1)]))).toBe(false);
  });

  it("the raw log is never changed", () => {
    const rows = Object.freeze([row(msg(1, "x", { at: 0 })), row(msg(2, "x", { at: 1 }))]);
    expect(() => calmRows(rows, { self: SELF })).not.toThrow();
    expect(rows).toHaveLength(2);
  });
});

describe("withoutBlocked", () => {
  it("drops blocked users' messages and keeps everything else", () => {
    const rows: ChatRow[] = [
      row(msg(1, "x", { user: 1 })),
      row(msg(2, "y", { user: 2 })),
      { kind: "notice", id: "n", code: "msg_slowmode" },
    ];
    expect(withoutBlocked(rows, new Set([UUID(1)])).map((r) => r.id)).toEqual([UUID(2), "n"]);
    expect(withoutBlocked(rows, new Set())).toBe(rows);
  });

  it("blocked users never count in a wave", () => {
    const rows = [row(msg(1, "spam", { user: 1, at: 0 })), row(msg(2, "spam", { user: 2, at: 1 }))];
    expect(shape(calmRows(withoutBlocked(rows, new Set([UUID(1)])), { self: SELF }))).toEqual([UUID(2)]);
  });
});

describe("waveReport", () => {
  const wave = (n: number) => {
    const rows = Array.from({ length: n }, (_, i) => row(msg(i + 1, "spam", { at: i })));
    const v = calmRows(rows, { self: SELF })[0];
    if (v?.kind !== "wave") throw new Error("no wave");
    return v.wave;
  };

  it("the first message is the subject; the set is newest first", () => {
    expect(waveReport(wave(3), 50)).toEqual({ subjectId: UUID(1), messageIds: [UUID(3), UUID(2), UUID(1)] });
  });

  it("caps at 50 and keeps the subject in the set", () => {
    const r = waveReport(wave(60), 50);
    expect(r.messageIds).toHaveLength(50);
    expect(r.messageIds[0]).toBe(UUID(60));
    expect(r.messageIds).toContain(UUID(1));
    expect(r.messageIds.at(-1)).toBe(UUID(1));
    expect(new Set(r.messageIds).size).toBe(50);
  });
});

describe("RateGovernor", () => {
  function gov(rate = 3) {
    let now = T0;
    const g = new RateGovernor({ rowsPerSecond: rate, now: () => now });
    return { g, advance: (ms: number) => (now += ms) };
  }

  it("lets at most N rows through per second and drops the overflow", () => {
    const { g, advance } = gov(3);
    for (let i = 0; i < 10; i++) g.offer({ id: `r${i}`, priority: PRIORITY.rest });
    expect(g.flush()).toEqual({ admitted: ["r0", "r1", "r2"], dropped: ["r3", "r4", "r5", "r6", "r7", "r8", "r9"] });
    g.offer({ id: "late", priority: PRIORITY.rest });
    advance(999);
    expect(g.flush()).toEqual({ admitted: [], dropped: ["late"] });
    advance(1);
    g.offer({ id: "next", priority: PRIORITY.rest });
    expect(g.flush().admitted).toEqual(["next"]);
  });

  it("orders by priority, then by arrival", () => {
    const { g } = gov(4);
    g.offer({ id: "rest", priority: PRIORITY.rest });
    g.offer({ id: "first", priority: PRIORITY.firstTime });
    g.offer({ id: "sub", priority: PRIORITY.subscriber });
    g.offer({ id: "rest2", priority: PRIORITY.rest });
    g.offer({ id: "mod", priority: PRIORITY.moderator });
    g.offer({ id: "caster", priority: PRIORITY.broadcaster });
    expect(g.flush()).toEqual({ admitted: ["caster", "mod", "first", "sub"], dropped: ["rest", "rest2"] });
  });

  it("never drops the broadcaster or a moderator over the limit either", () => {
    const { g } = gov(1);
    g.offer({ id: "rest", priority: PRIORITY.rest });
    g.offer({ id: "mod", priority: PRIORITY.moderator });
    g.offer({ id: "caster", priority: PRIORITY.broadcaster });
    g.offer({ id: "first", priority: PRIORITY.firstTime });
    expect(g.flush()).toEqual({ admitted: ["caster", "mod"], dropped: ["first", "rest"] });
    g.offer({ id: "mod2", priority: PRIORITY.moderator });
    expect(g.flush().admitted).toEqual(["mod2"]);
  });

  it("never drops a mention, even over the limit (and it uses the budget up)", () => {
    const { g } = gov(1);
    g.offer({ id: "rest", priority: PRIORITY.rest });
    g.offer({ id: "m1", priority: PRIORITY.mention });
    g.offer({ id: "m2", priority: PRIORITY.mention });
    expect(g.flush()).toEqual({ admitted: ["m1", "m2"], dropped: ["rest"] });
    g.offer({ id: "m3", priority: PRIORITY.mention });
    expect(g.flush().admitted).toEqual(["m3"]);
    expect(g.budget()).toBe(0);
  });

  it("follows the rows-per-second setting, clamped to 1–10", () => {
    const { g } = gov(1);
    g.setRate(5);
    for (let i = 0; i < 8; i++) g.offer({ id: `r${i}`, priority: PRIORITY.rest });
    expect(g.flush().admitted).toHaveLength(5);
    expect(clampRate(0)).toBe(1);
    expect(clampRate(11)).toBe(10);
    expect(clampRate(2.6)).toBe(3);
    expect(clampRate(Number.NaN)).toBe(3);
  });

  it("knows what is queued until the flush", () => {
    const { g } = gov(1);
    g.offer({ id: "a", priority: PRIORITY.rest });
    expect(g.isQueued("a")).toBe(true);
    g.flush();
    expect(g.isQueued("a")).toBe(false);
  });

  it("an empty flush changes nothing; reset forgets the window", () => {
    const { g } = gov(1);
    expect(g.flush()).toEqual({ admitted: [], dropped: [] });
    g.offer({ id: "a", priority: PRIORITY.rest });
    g.flush();
    expect(g.budget()).toBe(0);
    g.reset();
    expect(g.budget()).toBe(1);
  });
});

describe("priorityOf", () => {
  const ctx = { self: SELF, firstTime: false, subscriberPriority: false };
  it("ranks mentions, broadcaster, moderators, replies, first-timers, then the rest", () => {
    expect(priorityOf(msg(1, "hey @fan_one", { badges: ["moderator"] }), ctx)).toBe(PRIORITY.mention);
    expect(priorityOf(msg(1, "x", { badges: ["broadcaster", "moderator"] }), ctx)).toBe(PRIORITY.broadcaster);
    expect(priorityOf(msg(1, "x", { badges: ["moderator"] }), ctx)).toBe(PRIORITY.moderator);
    // A reply to the viewer is a "mention of you" in the digest, so it is never dropped either.
    expect(priorityOf(msg(1, "x", { replyTo: { id: UUID(5), username: SELF, body: "y" } }), ctx)).toBe(
      PRIORITY.mention,
    );
    expect(priorityOf(msg(1, "x"), { ...ctx, firstTime: true })).toBe(PRIORITY.firstTime);
    expect(priorityOf(msg(1, "x"), ctx)).toBe(PRIORITY.rest);
  });

  it("the viewer's own line is never governed away", () => {
    const own = { ...msg(1, "x"), user: { ...msg(1, "x").user, username: SELF } };
    expect(priorityOf(own, ctx)).toBe(PRIORITY.mention);
  });

  it("subscriber priority is off by default and a setting", () => {
    const sub = msg(1, "x", { badges: ["subscriber"] });
    expect(priorityOf(sub, ctx)).toBe(PRIORITY.rest);
    expect(priorityOf(sub, { ...ctx, subscriberPriority: true })).toBe(PRIORITY.subscriber);
  });

  it("signed out nothing is a mention", () => {
    expect(priorityOf(msg(1, "@fan_one"), { ...ctx, self: null })).toBe(PRIORITY.rest);
  });
});

describe("digest", () => {
  it("says nothing when nothing arrived", () => {
    expect(digestText(EMPTY_STATS)).toBeNull();
  });

  it("counts messages, the biggest wave, mentions and hidden lines", () => {
    expect(digestText({ ...EMPTY_STATS, messages: 1 })).toBe("1 new message");
    expect(
      digestText({
        messages: 12,
        mentions: 1,
        hidden: 0,
        waves: new Map([
          ["a", { label: "PogChamp", count: 312 }],
          ["b", { label: "LUL", count: 4 }],
        ]),
      }),
    ).toBe("12 new messages, 2 waves (PogChamp ×312), 1 mention of you");
    expect(
      digestText({ messages: 3, mentions: 2, hidden: 5, waves: new Map([["a", { label: "gg", count: 1234 }]]) }),
    ).toBe("3 new messages, 1 wave (gg ×1,234), 2 mentions of you. 5 lines not shown");
  });

  it("shortens a long wave text", () => {
    const text = digestText({
      ...EMPTY_STATS,
      messages: 2,
      waves: new Map([["a", { label: "x".repeat(80), count: 2 }]]),
    });
    expect(text).toContain(`${"x".repeat(39)}…`);
  });

  it("updates at most once per interval and keeps counting between", () => {
    let now = T0;
    const d = new Digest({ now: () => now });
    expect(d.take()).toBeNull();
    d.message(false);
    d.message(true);
    expect(d.take()).toBe("2 new messages, 1 mention of you");
    d.message(false);
    now += DIGEST_INTERVAL_MS - 1;
    expect(d.take()).toBeNull();
    d.hidden(4);
    d.wave("w", "spam", 9);
    now += 1;
    expect(d.take()).toBe("1 new message, 1 wave (spam ×9). 4 lines not shown");
    now += DIGEST_INTERVAL_MS * 3;
    expect(d.take()).toBeNull();
    expect(d.peek()).toEqual(EMPTY_STATS);
  });

  it("the interval is 5 s", () => {
    expect(DIGEST_INTERVAL_MS).toBe(5_000);
  });
});

describe("Calm Chat settings", () => {
  afterEach(() => setCalmStorage(null));

  function memoryStorage(init: Record<string, string> = {}) {
    const data = new Map(Object.entries(init));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  }

  it("defaults: off, 3 rows a second, no subscriber priority", () => {
    setCalmStorage(() => memoryStorage());
    expect(readCalmSettings()).toEqual({ enabled: false, rowsPerSecond: 3, subscriberPriority: false });
    expect(DEFAULT_CALM_SETTINGS.enabled).toBe(false);
  });

  it("saves and reads back; the same object while nothing changed", () => {
    const s = memoryStorage();
    setCalmStorage(() => s);
    expect(writeCalmSettings({ enabled: true, rowsPerSecond: 12 })).toBe(true);
    expect(JSON.parse(s.data.get(CALM_SETTINGS_KEY) ?? "{}")).toEqual({
      enabled: true,
      rowsPerSecond: 10,
      subscriberPriority: false,
    });
    const a = readCalmSettings();
    expect(readCalmSettings()).toBe(a);
    expect(a.rowsPerSecond).toBe(10);
  });

  it("parses malformed values field by field", () => {
    expect(parseCalmSettings("not json")).toEqual(DEFAULT_CALM_SETTINGS);
    expect(parseCalmSettings("null")).toEqual(DEFAULT_CALM_SETTINGS);
    expect(parseCalmSettings('{"enabled":"yes","rowsPerSecond":0,"subscriberPriority":true}')).toEqual({
      enabled: false,
      rowsPerSecond: 1,
      subscriberPriority: true,
    });
  });

  it("works when storage throws: defaults to read, the choice holds on this page", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    setCalmStorage(() => throwing);
    expect(readCalmSettings()).toEqual(DEFAULT_CALM_SETTINGS);
    expect(writeCalmSettings({ enabled: true })).toBe(false);
    expect(readCalmSettings().enabled).toBe(true);
  });

  it("works when there is no storage, or the accessor itself throws", () => {
    setCalmStorage(() => null);
    expect(readCalmSettings()).toEqual(DEFAULT_CALM_SETTINGS);
    expect(writeCalmSettings({ subscriberPriority: true })).toBe(false);
    expect(readCalmSettings().subscriberPriority).toBe(true);
    setCalmStorage(() => {
      throw new Error("blocked");
    });
    expect(readCalmSettings()).toEqual(DEFAULT_CALM_SETTINGS);
  });

  it("notifies subscribers on a change", () => {
    setCalmStorage(() => memoryStorage());
    const fn = vi.fn<() => void>();
    const off = subscribeCalmSettings(fn);
    writeCalmSettings({ enabled: true });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    writeCalmSettings({ enabled: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("the live-chat block set", () => {
  afterEach(() => resetBlocks());

  const client = (ids: string[] | Error) => {
    const load = vi.fn<BlocksClient["ids"]>(async () => {
      if (ids instanceof Error) throw ids;
      return { userIds: ids };
    });
    const c: BlocksClient = { ids: load, add: vi.fn<BlocksClient["add"]>(), remove: vi.fn<BlocksClient["remove"]>() };
    return { c, load };
  };

  it("loads once per viewer and keeps blocks made meanwhile", async () => {
    const { c, load } = client([UUID(1)]);
    const p = loadBlocks("fan", c);
    noteBlocked({ id: UUID(2), username: "troll" });
    await p;
    await loadBlocks("fan", c);
    expect(load).toHaveBeenCalledTimes(1);
    expect([...blockSnapshot().ids].sort()).toEqual([UUID(1), UUID(2)]);
    expect(blockSnapshot().usernames.has("troll")).toBe(true);
  });

  it("an unblock shows the user at once", () => {
    noteBlocked({ id: UUID(2), username: "troll" });
    const before = blockSnapshot();
    noteBlocked({ id: UUID(2), username: "troll" });
    expect(blockSnapshot()).toBe(before);
    noteUnblocked({ id: UUID(2), username: "troll" });
    expect(blockSnapshot().ids.size).toBe(0);
    expect(blockSnapshot().usernames.size).toBe(0);
    const after = blockSnapshot();
    noteUnblocked({ id: UUID(2), username: "troll" });
    expect(blockSnapshot()).toBe(after);
  });

  it("a failed load leaves chat working and is tried again", async () => {
    const bad = client(new Error("offline"));
    await loadBlocks("fan", bad.c);
    expect(blockSnapshot().ids.size).toBe(0);
    const good = client([UUID(3)]);
    await loadBlocks("fan", good.c);
    expect(blockSnapshot().ids.has(UUID(3))).toBe(true);
  });
});
