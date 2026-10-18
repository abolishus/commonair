// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { ClientFrame } from "@commonair/contracts";
import { parseDuration, translatePrivmsg, truncateUtf16 } from "../src/commands.ts";

const cmd = (command: string, args: string[]) => ({ kind: "command", command, args });
const send = (body: string, isAction = false) => ({ kind: "send", body, isAction });

describe("PRIVMSG translation table", () => {
  test.each<[string, unknown]>([
    // plain chat, including bot commands
    ["hello world", send("hello world")],
    ["!uptime", send("!uptime")],
    ["...ok", send("...ok")],
    [".net is nice", send(".net is nice")],
    // actions
    ["\x01ACTION waves\x01", send("waves", true)],
    ["\x01ACTION waves", send("waves", true)],
    ["/me waves hello", send("waves hello", true)],
    [".me dances", send("dances", true)],
    // moderation
    ["/ban spammer", cmd("ban", ["spammer"])],
    ["/ban @Spammer being rude  again", cmd("ban", ["spammer", "being rude again"])],
    [".ban spammer", cmd("ban", ["spammer"])],
    ["/unban spammer", cmd("unban", ["spammer"])],
    ["/timeout troll", cmd("timeout", ["troll"])],
    ["/timeout troll 30", cmd("timeout", ["troll", "30"])],
    ["/timeout troll 10m cool it", cmd("timeout", ["troll", "600", "cool it"])],
    ["/timeout troll 1h", cmd("timeout", ["troll", "3600"])],
    ["/timeout troll calm down", cmd("timeout", ["troll", "600", "calm down"])],
    ["/untimeout troll", cmd("untimeout", ["troll"])],
    ["/delete 0190F1C2-0000-7000-8000-000000000001", cmd("delete", ["0190f1c2-0000-7000-8000-000000000001"])],
    ["/clear", cmd("clear", [])],
    ["/slow", cmd("slow", [])],
    ["/slow 30", cmd("slow", ["30"])],
    ["/slowoff", cmd("slowoff", [])],
    ["/followers", cmd("followers", [])],
    ["/followers 10", cmd("followers", ["10"])],
    ["/followers 1h", cmd("followers", ["60"])],
    ["/followers 30 minutes", cmd("followers", ["30"])],
    ["/followers 1 week", cmd("followers", ["10080"])],
    ["/followersoff", cmd("followersoff", [])],
    ["/subscribers", cmd("subscribers", [])],
    ["/subs", cmd("subscribers", [])],
    ["/subscribersoff", cmd("subscribersoff", [])],
    ["/emoteonly", cmd("emoteonly", [])],
    ["/emoteonlyoff", cmd("emoteonlyoff", [])],
    ["/mod helper", cmd("mod", ["helper"])],
    ["/unmod helper", cmd("unmod", ["helper"])],
    ["/vip friend", cmd("vip", ["friend"])],
    ["/unvip friend", cmd("unvip", ["friend"])],
    ["/BAN Spammer", cmd("ban", ["spammer"])],
  ])("%j", (text, expected) => {
    expect(translatePrivmsg(text)).toEqual(expected);
  });

  test.each<[string, string]>([
    ["/ban", "usage_ban"],
    ["/ban not-a-login!", "usage_ban"],
    ["/timeout", "usage_timeout"],
    ["/timeout troll 0", "usage_timeout"],
    ["/timeout troll 3w", "usage_timeout"],
    ["/delete abc", "usage_delete"],
    ["/slow 601", "usage_slow_on"],
    ["/slow fast", "usage_slow_on"],
    ["/followers forever", "usage_followers_on"],
    ["/mod", "usage_mod"],
    ["/me", "usage_me"],
    ["/me   ", "usage_me"],
  ])("usage error %j → %s", (text, msgId) => {
    expect(translatePrivmsg(text)).toMatchObject({ kind: "notice", msgId });
  });

  test.each(["/color red", "/w friend hi", "/r9kbeta", "/mods", "/commercial", "/raid other"])(
    "unsupported %j → unrecognized_cmd",
    (text) => {
      expect(translatePrivmsg(text)).toMatchObject({ kind: "notice", msgId: "unrecognized_cmd" });
    },
  );

  test("other CTCP and blank messages are ignored", () => {
    expect(translatePrivmsg("\x01VERSION\x01")).toEqual({ kind: "ignore" });
    expect(translatePrivmsg("   ")).toEqual({ kind: "ignore" });
    expect(translatePrivmsg("\x01ACTION \x01")).toEqual({ kind: "ignore" });
  });

  test("bodies are truncated to 500 UTF-16 units without splitting surrogate pairs", () => {
    const t = translatePrivmsg(`${"a".repeat(499)}🎉tail`);
    expect(t).toEqual(send("a".repeat(499)));
    expect(translatePrivmsg("x".repeat(800))).toEqual(send("x".repeat(500)));
  });

  test("every produced frame validates against the upstream ClientFrame schema", () => {
    const samples = [
      "/ban a reason",
      "/timeout bob 5m",
      "/followers 2h",
      "hello",
      "/me hi",
      "/delete 0190f1c2-0000-7000-8000-000000000001",
    ];
    for (const text of samples) {
      const t = translatePrivmsg(text);
      const frame =
        t.kind === "command"
          ? { op: "command", channel: "chan", command: t.command, args: t.args }
          : t.kind === "send"
            ? { op: "send", channel: "chan", body: t.body, isAction: t.isAction }
            : null;
      expect(frame && ClientFrame.safeParse(frame).success).toBe(true);
    }
  });
});

describe("parseDuration", () => {
  test.each<[string, "seconds" | "minutes", number | null]>([
    ["30", "seconds", 30],
    ["30", "minutes", 1800],
    ["30s", "minutes", 30],
    ["10m", "seconds", 600],
    ["2h", "seconds", 7200],
    ["1d", "seconds", 86_400],
    ["1w", "seconds", 604_800],
    ["3 months", "seconds", 7_776_000],
    ["5 parsecs", "seconds", null],
    ["-5", "seconds", null],
    ["", "seconds", null],
  ])("%j (%s) → %j", (raw, unit, expected) => {
    expect(parseDuration(raw, unit)).toBe(expected);
  });
});

test("truncateUtf16", () => {
  expect(truncateUtf16("abc", 5)).toBe("abc");
  expect(truncateUtf16("ab🎉", 3)).toBe("ab");
  expect(truncateUtf16("ab🎉", 4)).toBe("ab🎉");
});
