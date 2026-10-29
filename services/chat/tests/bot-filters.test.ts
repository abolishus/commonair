// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type BotFilters,
  checkFilters,
  hasRepeatRun,
  hostAllowed,
  hostOf,
  isShouting,
  linksAllowlisted,
  normalizeAllowlist,
} from "../src/plugins/bot/filters.ts";
import { standing } from "./fixtures.ts";

const filters = (over: Partial<BotFilters> = {}): BotFilters => ({
  spam: { enabled: true, maxRepeatedChars: 5 },
  links: { enabled: true, allowSubscribers: true, allowlist: [] },
  caps: { enabled: true, minLength: 10, maxRatio: 0.7 },
  timeoutSeconds: 10,
  ...over,
});

describe("spam: repeated characters", () => {
  test("a run of exactly maxRepeatedChars passes; one more fails", () => {
    expect(hasRepeatRun("aaaaa", 5)).toBe(false);
    expect(hasRepeatRun("aaaaaa", 5)).toBe(true);
    expect(hasRepeatRun("xx aaaaa yy", 5)).toBe(false);
    expect(hasRepeatRun("xx aaaaaa yy", 5)).toBe(true);
  });

  test("runs are per character, not per total count", () => {
    expect(hasRepeatRun("abababababab", 3)).toBe(false);
    expect(hasRepeatRun("aaabaaab", 3)).toBe(false);
  });

  test("counts code points, so an emoji run is one character each", () => {
    expect(hasRepeatRun("😀😀😀", 3)).toBe(false);
    expect(hasRepeatRun("😀😀😀😀", 3)).toBe(true);
  });

  test("empty body", () => {
    expect(hasRepeatRun("", 3)).toBe(false);
  });
});

describe("caps", () => {
  test("below minLength never counts", () => {
    expect(isShouting("HELLO", 10, 0.7)).toBe(false);
    expect(isShouting("HELLOWORLD", 10, 0.7)).toBe(true);
    expect(isShouting("HELLOWORL", 10, 0.7)).toBe(false);
  });

  test("the ratio must be above maxRatio, not equal", () => {
    // 7 upper of 10 letters = 0.7.
    expect(isShouting("ABCDEFGhij", 10, 0.7)).toBe(false);
    expect(isShouting("ABCDEFGHij", 10, 0.7)).toBe(true);
  });

  test("only cased letters count toward the ratio", () => {
    expect(isShouting("OK 1234567890 !!!", 10, 0.7)).toBe(true);
    expect(isShouting("1234567890 !!!", 10, 0.7)).toBe(false);
    expect(isShouting("Ok 1234567890 !!!", 10, 0.7)).toBe(false);
  });

  test("maxRatio 1 never fires; 0 fires on any capital", () => {
    expect(isShouting("ALLCAPSALLCAPS", 1, 1)).toBe(false);
    expect(isShouting("one Capital here", 1, 0)).toBe(true);
  });

  test("non-Latin cased scripts count", () => {
    expect(isShouting("ПРИВЕТ МИР ВСЕМ", 10, 0.7)).toBe(true);
  });
});

describe("hosts and the allowlist", () => {
  test.each([
    ["https://Example.org/path?q=1", "example.org"],
    ["http://user:pw@evil.example.com:8080/x", "evil.example.com"],
    ["www.example.org", "www.example.org"],
    ["example.org.", "example.org"],
    ["(example.org)", "example.org"],
    ["example.org/a,b", "example.org"],
    ["ftp://files.example.net", "files.example.net"],
  ])("%s → %s", (token, host) => {
    expect(hostOf(token)).toBe(host);
  });

  test("unreadable hosts are null", () => {
    expect(hostOf("https://")).toBeNull();
    expect(hostOf("https://_bad_.example")).toBeNull();
  });

  test("normalizes entries", () => {
    expect(normalizeAllowlist([" Example.org ", "*.clips.example", ".x.test", "y.test.", ""])).toEqual([
      "example.org",
      "clips.example",
      "x.test",
      "y.test",
    ]);
  });

  test("exact host and subdomains, never suffix look-alikes", () => {
    const list = ["example.org"];
    expect(hostAllowed("example.org", list)).toBe(true);
    expect(hostAllowed("www.example.org", list)).toBe(true);
    expect(hostAllowed("a.b.example.org", list)).toBe(true);
    expect(hostAllowed("badexample.org", list)).toBe(false);
    expect(hostAllowed("example.org.evil.test", list)).toBe(false);
    expect(hostAllowed("org", list)).toBe(false);
  });

  test("every link in the message must be allowlisted", () => {
    expect(linksAllowlisted("see https://example.org and www.example.org/x", ["example.org"])).toBe(true);
    expect(linksAllowlisted("see https://example.org and evil.test", ["example.org"])).toBe(false);
    expect(linksAllowlisted("https://example.org", [])).toBe(false);
  });

  test("credentials do not smuggle a host past the allowlist", () => {
    expect(linksAllowlisted("https://example.org@evil.test/", ["example.org"])).toBe(false);
    expect(linksAllowlisted("https://evil.test@example.org/", ["example.org"])).toBe(true);
  });
});

describe("checkFilters", () => {
  const viewer = standing();
  const subscriber = standing({ subscriberTier: 1 });

  test("a clean message passes", () => {
    expect(checkFilters("hello there friends", filters(), viewer)).toBeNull();
  });

  test("spam and caps drop with msg_rejected; links with msg_links_blocked", () => {
    expect(checkFilters("nooooooo", filters(), viewer)).toMatchObject({ kind: "spam", code: "msg_rejected" });
    expect(checkFilters("STOP SHOUTING NOW", filters(), viewer)).toMatchObject({ kind: "caps", code: "msg_rejected" });
    expect(checkFilters("go to evil.test now", filters(), viewer)).toMatchObject({
      kind: "links",
      code: "msg_links_blocked",
    });
  });

  test("disabled filters do nothing", () => {
    const off = filters({
      spam: { enabled: false, maxRepeatedChars: 5 },
      caps: { enabled: false, minLength: 10, maxRatio: 0.7 },
      links: { enabled: false, allowSubscribers: false, allowlist: [] },
    });
    expect(checkFilters("NOOOOOOOOOO evil.test", off, viewer)).toBeNull();
  });

  test("subscribers may post links when allowSubscribers is on", () => {
    expect(checkFilters("evil.test", filters(), subscriber)).toBeNull();
    const strict = filters({ links: { enabled: true, allowSubscribers: false, allowlist: [] } });
    expect(checkFilters("evil.test", strict, subscriber)).toMatchObject({ kind: "links" });
  });

  test("allowlisted links pass, including subdomains", () => {
    const f = filters({ links: { enabled: true, allowSubscribers: false, allowlist: ["Example.org"] } });
    expect(checkFilters("clip at https://clips.example.org/abc", f, viewer)).toBeNull();
    expect(checkFilters("clip at https://example.org.evil.test/abc", f, viewer)).toMatchObject({ kind: "links" });
  });

  test("spam is checked before caps and links", () => {
    expect(checkFilters("AAAAAAAAAAAA evil.test", filters(), viewer)?.kind).toBe("spam");
  });
});
