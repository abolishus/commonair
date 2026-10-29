// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { USER_LEVELS } from "@commonair/contracts/enums";
import { levelOf, meetsLevel, rankOfLevel } from "../src/plugins/bot/levels.ts";
import {
  acceptSongUrl,
  indexCommands,
  parseBang,
  resolveCommand,
  SONG_URL_MAX,
  toUser,
} from "../src/plugins/bot/parse.ts";
import { standing } from "./fixtures.ts";

describe("user levels", () => {
  test("ordering follows USER_LEVELS", () => {
    expect(USER_LEVELS.map(rankOfLevel)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a standing's level is its highest", () => {
    expect(levelOf(standing())).toBe("everyone");
    expect(levelOf(standing({ followedAt: new Date() }))).toBe("follower");
    expect(levelOf(standing({ followedAt: new Date(), subscriberTier: 1 }))).toBe("subscriber");
    expect(levelOf(standing({ subscriberTier: 3, isVip: true }))).toBe("vip");
    expect(levelOf(standing({ isVip: true, isModerator: true }))).toBe("moderator");
    expect(levelOf(standing({ isModerator: true, isBroadcaster: true }))).toBe("broadcaster");
  });

  test("each level includes the ones below it", () => {
    const vip = standing({ isVip: true });
    expect(meetsLevel(vip, "everyone")).toBe(true);
    expect(meetsLevel(vip, "follower")).toBe(true);
    expect(meetsLevel(vip, "subscriber")).toBe(true);
    expect(meetsLevel(vip, "vip")).toBe(true);
    expect(meetsLevel(vip, "moderator")).toBe(false);
    expect(meetsLevel(standing(), "follower")).toBe(false);
    expect(meetsLevel(standing({ isBroadcaster: true }), "broadcaster")).toBe(true);
    expect(meetsLevel(standing({ isModerator: true }), "broadcaster")).toBe(false);
  });
});

describe("parseBang", () => {
  test("name lowercased, arguments split on whitespace", () => {
    expect(parseBang("!Hello  @bob   there")).toEqual({ name: "hello", args: ["@bob", "there"] });
    expect(parseBang("!sr https://example.org/song")).toEqual({ name: "sr", args: ["https://example.org/song"] });
    expect(parseBang("!points")).toEqual({ name: "points", args: [] });
  });

  test("not a command", () => {
    expect(parseBang("hello !hi")).toBeNull();
    expect(parseBang("!")).toBeNull();
    expect(parseBang("! hi")).toBeNull();
    expect(parseBang("!!hi")).toBeNull();
    expect(parseBang("!hi-there")).toBeNull();
    expect(parseBang(`!${"a".repeat(26)}`)).toBeNull();
    expect(parseBang(`!${"a".repeat(25)}`)).toEqual({ name: "a".repeat(25), args: [] });
  });

  test("bounded argument count", () => {
    const parsed = parseBang(`!x ${"a ".repeat(100)}`);
    expect(parsed?.args.length).toBeLessThanOrEqual(10);
  });

  test("toUser strips @ and falls back to null", () => {
    expect(toUser(["@bob"])).toBe("bob");
    expect(toUser(["@@bob"])).toBe("bob");
    expect(toUser(["@"])).toBeNull();
    expect(toUser([])).toBeNull();
    expect(toUser(["x".repeat(40)])).toHaveLength(25);
  });
});

describe("resolveCommand", () => {
  const cmd = (name: string, aliases: string[] = []) => ({ name, aliases });
  const hello = cmd("hello", ["hi", "hey"]);
  const hi = cmd("hi");
  const hug = cmd("hug", ["hey", "points"]);
  const index = indexCommands([hello, hi, hug, cmd("sr")]);

  test("built-ins first", () => {
    expect(resolveCommand("points", index)).toEqual({ kind: "builtin", name: "points" });
    expect(resolveCommand("sr", index)).toEqual({ kind: "builtin", name: "sr" });
    expect(resolveCommand("commands", index)).toEqual({ kind: "builtin", name: "commands" });
  });

  test("a name, then an alias", () => {
    expect(resolveCommand("hello", index)).toEqual({ kind: "custom", command: hello });
    // "hi" is both a command and hello's alias: the name wins.
    expect(resolveCommand("hi", index)).toEqual({ kind: "custom", command: hi });
    // "hey" is an alias of two commands: the first keeps it.
    expect(resolveCommand("hey", index)).toEqual({ kind: "custom", command: hello });
  });

  test("unknown names resolve to nothing; built-in names are never indexed", () => {
    expect(resolveCommand("nope", index)).toBeNull();
    expect(index.has("sr")).toBe(false);
    expect(index.has("points")).toBe(false);
  });
});

describe("acceptSongUrl", () => {
  test.each([
    "https://example.org/song",
    "http://music.example.com/watch?v=abc#t=10",
    "https://example.org:8443/x",
    "HTTPS://Example.ORG/Song",
  ])("accepts %s", (url) => {
    expect(acceptSongUrl(url)).toBe(url);
  });

  test.each([
    undefined,
    "",
    "not-a-link",
    "example.org/song",
    "ftp://example.org/song",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pw@example.org/song",
    "https://user@example.org/song",
    "http://localhost/song",
    "http://localhost./song",
    "https://[::1]/song",
    "https://",
  ])("refuses %s", (url) => {
    expect(acceptSongUrl(url)).toBeNull();
  });

  test("length boundary", () => {
    const base = "https://example.org/";
    const at = base + "a".repeat(SONG_URL_MAX - base.length);
    expect(acceptSongUrl(at)).toBe(at);
    expect(acceptSongUrl(`${at}a`)).toBeNull();
  });
});
