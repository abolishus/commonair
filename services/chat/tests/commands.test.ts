// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  MAX_TIMEOUT_SECONDS,
  normalizeUsername,
  parseCommand,
  parseDuration,
  splitChatCommand,
} from "../src/commands.ts";

const ok = (name: string, args: string[]) => {
  const r = parseCommand(name, args);
  if (!r.ok) throw new Error(r.text);
  return r.command;
};
const fails = (name: string, args: string[]) => parseCommand(name, args).ok === false;

describe("splitChatCommand", () => {
  test.each([
    ["/ban bob being rude", { name: "ban", args: ["bob", "being", "rude"] }],
    ["/TIMEOUT  @Bob   60", { name: "timeout", args: ["@Bob", "60"] }],
    ["/me waves", { name: "me", args: ["waves"] }],
    ["/clear", { name: "clear", args: [""] }],
  ])("%s", (text, expected) => {
    const r = splitChatCommand(text);
    expect(r?.name).toBe(expected.name);
    expect(r?.args.filter(Boolean)).toEqual(expected.args.filter(Boolean));
  });

  test.each(["hello", "//not a command", "/", "/   "])("%s is not a command", (text) => {
    expect(splitChatCommand(text)).toBeNull();
  });
});

describe("parseDuration", () => {
  test.each([
    ["600", 600],
    ["30s", 30],
    ["10m", 600],
    ["1h", 3600],
    ["2d", 172_800],
    ["1w", 604_800],
    ["1H", 3600],
  ])("%s → %d s", (raw, secs) => expect(parseDuration(raw)).toBe(secs));

  test("bare numbers can default to minutes", () => expect(parseDuration("10", "m")).toBe(600));
  test.each(["", "abc", "-5", "1.5", "10x", "5 m"])("%s is invalid", (raw) => expect(parseDuration(raw)).toBeNull());
});

describe("normalizeUsername", () => {
  test("strips @ and lowercases", () => expect(normalizeUsername("@Bob_99")).toBe("bob_99"));
  test.each(["ab", "a".repeat(26), "bad-name", "", undefined])("%s is rejected", (raw) =>
    expect(normalizeUsername(raw)).toBeNull(),
  );
});

describe("parseCommand", () => {
  test("ban with and without reason", () => {
    expect(ok("ban", ["@Bob"])).toEqual({ kind: "ban", target: "bob", reason: "" });
    expect(ok("ban", ["bob", "spamming", "links"])).toEqual({ kind: "ban", target: "bob", reason: "spamming links" });
    expect(fails("ban", [])).toBe(true);
  });

  test("timeout defaults to 600 s and accepts units", () => {
    expect(ok("timeout", ["bob"])).toEqual({ kind: "timeout", target: "bob", seconds: 600, reason: "" });
    expect(ok("timeout", ["bob", "10m", "calm", "down"])).toEqual({
      kind: "timeout",
      target: "bob",
      seconds: 600,
      reason: "calm down",
    });
    expect(ok("timeout", ["bob", "rude"])).toEqual({ kind: "timeout", target: "bob", seconds: 600, reason: "rude" });
    expect(ok("timeout", ["bob", String(MAX_TIMEOUT_SECONDS)])).toMatchObject({ seconds: MAX_TIMEOUT_SECONDS });
    expect(fails("timeout", ["bob", String(MAX_TIMEOUT_SECONDS + 1)])).toBe(true);
    expect(fails("timeout", ["bob", "0"])).toBe(true);
  });

  test("unban, untimeout, role commands need a valid username", () => {
    for (const name of ["unban", "untimeout", "mod", "unmod", "vip", "unvip"]) {
      expect(ok(name, ["Carol"])).toEqual({ kind: name, target: "carol" });
      expect(fails(name, [])).toBe(true);
      expect(fails(name, ["no!"])).toBe(true);
    }
  });

  test("delete requires a uuid", () => {
    const id = "0192F5A0-0000-7000-8000-000000000001";
    expect(ok("delete", [id])).toEqual({ kind: "delete", messageId: id.toLowerCase() });
    expect(fails("delete", ["123"])).toBe(true);
  });

  test("slow defaults to 30 s and is bounded", () => {
    expect(ok("slow", [])).toEqual({ kind: "slow", seconds: 30 });
    expect(ok("slow", ["2m"])).toEqual({ kind: "slow", seconds: 120 });
    expect(fails("slow", ["601"])).toBe(true);
    expect(fails("slow", ["0"])).toBe(true);
  });

  test("followers defaults to 0 minutes, bare numbers are minutes", () => {
    expect(ok("followers", [])).toEqual({ kind: "followers", minutes: 0 });
    expect(ok("followers", ["10"])).toEqual({ kind: "followers", minutes: 10 });
    expect(ok("followers", ["1h"])).toEqual({ kind: "followers", minutes: 60 });
    expect(fails("followers", ["100w"])).toBe(true);
  });

  test("mode toggles take no arguments", () => {
    for (const name of [
      "clear",
      "slowoff",
      "followersoff",
      "subscribers",
      "subscribersoff",
      "emoteonly",
      "emoteonlyoff",
    ])
      expect(ok(name, [])).toEqual({ kind: name });
  });

  test("me needs text", () => {
    expect(ok("me", ["waves", "hello"])).toEqual({ kind: "me", text: "waves hello" });
    expect(fails("me", [])).toBe(true);
  });

  test("unknown commands are unrecognized", () => {
    expect(parseCommand("nuke", [])).toMatchObject({ ok: false, code: "unrecognized_cmd" });
  });
});

describe("parse error codes", () => {
  test("bad arguments are usage errors", () => {
    expect(parseCommand("ban", [])).toMatchObject({ ok: false, code: "usage" });
    expect(parseCommand("timeout", ["bob", "0"])).toMatchObject({ ok: false, code: "usage" });
    expect(parseCommand("delete", ["x"])).toMatchObject({ ok: false, code: "usage" });
    expect(parseCommand("me", [])).toMatchObject({ ok: false, code: "usage" });
  });
});
