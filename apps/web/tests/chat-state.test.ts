// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { ChatConnection, MAX_MESSAGES, type ChatMessageFrame, type SocketLike } from "../src/chat/connection.ts";
import { noticeMessage } from "../src/chat/messages.ts";
import { chatReducer, EMPTY_GATE, gateReducer, type ChatAction, type ChatRow } from "../src/chat/state.ts";
import { t } from "../src/i18n/index.ts";

const UUID = (n: number) => `0190f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const CHANNEL = "streamer_one";

const msg = (n: number, user: { id: number; username: string } = { id: 2, username: "viewer_two" }) =>
  ({
    id: UUID(100 + n),
    channelId: UUID(1),
    user: {
      id: UUID(user.id),
      username: user.username,
      displayName: user.username,
      color: null,
      badges: [],
      accountType: "human",
    },
    body: `hi ${n}`,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: "2026-10-18T12:00:00.000Z",
  }) as ChatMessageFrame;

const TROLL = { id: 3, username: "troll" };

function run(actions: ChatAction[], start: ChatRow[] = []): ChatRow[] {
  return actions.reduce(chatReducer, start);
}

const deletedIds = (rows: ChatRow[]) => rows.filter((r) => r.kind === "message" && r.deleted).map((r) => r.id);

describe("chatReducer", () => {
  it("appends messages once, in order", () => {
    const rows = run([
      { type: "message", message: msg(1) },
      { type: "message", message: msg(2) },
      { type: "message", message: msg(1) },
    ]);
    expect(rows.map((r) => r.id)).toEqual([UUID(101), UUID(102)]);
    expect(deletedIds(rows)).toEqual([]);
  });

  it("marks a deleted message instead of removing it", () => {
    const rows = run([
      { type: "message", message: msg(1) },
      { type: "message", message: msg(2) },
      { type: "delete", messageId: UUID(101) },
    ]);
    expect(rows).toHaveLength(2);
    expect(deletedIds(rows)).toEqual([UUID(101)]);
  });

  it("ignores a delete for an unknown message and keeps the same array", () => {
    const start = run([{ type: "message", message: msg(1) }]);
    expect(chatReducer(start, { type: "delete", messageId: UUID(999) })).toBe(start);
  });

  it("marks every message of a banned user, by id or username", () => {
    const rows = run([
      { type: "message", message: msg(1, TROLL) },
      { type: "message", message: msg(2) },
      { type: "message", message: msg(3, TROLL) },
      { type: "message", message: msg(4, { id: 9, username: "troll" }) },
      { type: "ban", userId: UUID(3), username: "troll" },
    ]);
    expect(deletedIds(rows)).toEqual([UUID(101), UUID(103), UUID(104)]);
  });

  it("does not mark messages sent after the ban", () => {
    const rows = run([
      { type: "message", message: msg(1, TROLL) },
      { type: "ban", userId: UUID(3), username: "troll" },
      { type: "message", message: msg(2, TROLL) },
    ]);
    expect(deletedIds(rows)).toEqual([UUID(101)]);
  });

  it("clear marks every message deleted and keeps notices", () => {
    const rows = run([
      { type: "message", message: msg(1) },
      { type: "notice", id: "n1", code: "cmd_success" },
      { type: "message", message: msg(2, TROLL) },
      { type: "clear" },
    ]);
    expect(rows).toHaveLength(3);
    expect(deletedIds(rows)).toEqual([UUID(101), UUID(102)]);
    expect(rows[1]).toEqual({ kind: "notice", id: "n1", code: "cmd_success" });
  });

  it("clear on an empty list is a no-op", () => {
    const empty: ChatRow[] = [];
    expect(chatReducer(empty, { type: "clear" })).toBe(empty);
  });

  it("renders notices inline between messages", () => {
    const rows = run([
      { type: "message", message: msg(1) },
      { type: "notice", id: "n1", code: "msg_timedout" },
      { type: "notice", id: "n2", code: "msg_timedout" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["message", "notice", "notice"]);
  });

  it("caps the list at MAX_MESSAGES rows, dropping the oldest", () => {
    const actions: ChatAction[] = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({
      type: "message",
      message: msg(i),
    }));
    actions.push({ type: "notice", id: "last", code: "cmd_success" });
    const rows = run(actions);
    expect(rows).toHaveLength(MAX_MESSAGES);
    expect(rows[0]?.id).toBe(UUID(106));
    expect(rows.at(-1)?.id).toBe("last");
  });
});

describe("notice text", () => {
  it("translates known codes and falls back for unknown ones", () => {
    expect(noticeMessage("msg_timedout")).toBe(t("chat.notice.timedOut"));
    expect(noticeMessage("something_new")).toBe(t("chat.notice.generic"));
  });
});

describe("ChatConnection ban frames", () => {
  it("forwards a ban for this channel only", () => {
    const bans: [string, string][] = [];
    const conn = new ChatConnection(
      CHANNEL,
      {
        getToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
        createSocket: () => ({}) as SocketLike,
      },
      {
        onStatus: () => undefined,
        onJoined: () => undefined,
        onMessage: () => undefined,
        onDelete: () => undefined,
        onClear: () => undefined,
        onBan: (userId, username) => bans.push([userId, username]),
        onNotice: () => undefined,
      },
    );
    const ban = { op: "ban", userId: UUID(3), username: "troll", expiresAt: null, reason: "" };
    conn.handleFrame(JSON.stringify({ ...ban, channel: CHANNEL }));
    conn.handleFrame(JSON.stringify({ ...ban, channel: "other_chan" }));
    conn.handleFrame(JSON.stringify({ ...ban, channel: CHANNEL, userId: "nope" }));
    expect(bans).toEqual([[UUID(3), "troll"]]);
  });
});

describe("ChatConnection settings and surge frames", () => {
  const SETTINGS = {
    slowModeSeconds: 0,
    followersOnlyMinutes: null,
    subscribersOnly: false,
    emoteOnly: false,
    minAccountAgeDays: 0,
    requireVerifiedEmail: true,
    linksAllowed: true,
    minVerifiedWatchSeconds: 120,
    verifiedWatchExemptSubscribers: true,
    surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 },
  };

  function connect() {
    const settings: unknown[] = [];
    const surges: unknown[] = [];
    const conn = new ChatConnection(
      CHANNEL,
      {
        getToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
        createSocket: () => ({}) as SocketLike,
      },
      {
        onStatus: () => undefined,
        onJoined: () => undefined,
        onMessage: () => undefined,
        onDelete: () => undefined,
        onClear: () => undefined,
        onNotice: () => undefined,
        onSettings: (s) => settings.push(s),
        onSurge: (f) => surges.push(f),
      },
    );
    return { conn, settings, surges };
  }

  it("reports the joined frame's settings and surge, so a mid-surge joiner knows at once", () => {
    const { conn, settings, surges } = connect();
    const until = "2026-10-30T12:10:00.000Z";
    conn.handleFrame(
      JSON.stringify({
        op: "joined",
        channel: CHANNEL,
        channelId: UUID(1),
        settings: SETTINGS,
        me: { badges: [], canModerate: false, canChat: true },
        surge: { state: "on", until },
      }),
    );
    expect(settings).toEqual([SETTINGS]);
    expect(surges).toEqual([{ state: "on", until }]);
  });

  it("forwards settings and surge frames for this channel only", () => {
    const { conn, settings, surges } = connect();
    const next = { ...SETTINGS, slowModeSeconds: 30 };
    conn.handleFrame(JSON.stringify({ op: "settings", channel: CHANNEL, settings: next }));
    conn.handleFrame(JSON.stringify({ op: "settings", channel: "other_chan", settings: next }));
    conn.handleFrame(JSON.stringify({ op: "surge", channel: CHANNEL, state: "suppressed", until: null }));
    conn.handleFrame(JSON.stringify({ op: "surge", channel: "other_chan", state: "on", until: null }));
    conn.handleFrame(JSON.stringify({ op: "surge", channel: CHANNEL, state: "bogus", until: null }));
    expect(settings).toEqual([next]);
    expect(surges).toEqual([{ state: "suppressed", until: null }]);
  });
});

describe("gateReducer (what the panel hands <SurgeBanner/>)", () => {
  it("a mid-surge joiner has the surge from the joined frame at once, and every rejoin starts over", () => {
    const until = "2026-10-30T12:10:00.000Z";
    // The order the panel dispatches for a joined frame: joined, settings, surge.
    let s = gateReducer(EMPTY_GATE, { type: "joined" });
    s = gateReducer(s, { type: "surge", surge: { state: "on", until } });
    expect(s.surge).toEqual({ state: "on", until });
    expect(s.gateDenied).toBe(false);
    s = gateReducer(s, { type: "denied" });
    expect(gateReducer(s, { type: "denied" })).toBe(s);
    // A reconnect: the join clears the denial; the new joined frame's surge replaces the old one.
    s = gateReducer(s, { type: "joined" });
    expect(s.gateDenied).toBe(false);
    s = gateReducer(s, { type: "surge", surge: { state: "off", until: null } });
    expect(s.surge).toEqual({ state: "off", until: null });
    expect(gateReducer(s, { type: "joined" })).toBe(s);
    expect(gateReducer(s, { type: "reset" })).toBe(EMPTY_GATE);
  });
});
