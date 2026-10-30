// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 3's pure helpers (harness/src/n1/cooldown.ts). */
import { describe, expect, test } from "vite-plus/test";
import { COOLDOWN_WATCH_MS, linksChannel, newMessages, step } from "../../src/n1/cooldown.ts";

describe("newMessages", () => {
  test("only ids not seen before", () => {
    expect(newMessages([{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "c" }, { id: "b" }, { id: "d" }])).toEqual([
      { id: "c" },
      { id: "d" },
    ]);
    expect(newMessages([], [{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(newMessages([{ id: "a" }], [])).toEqual([]);
  });
});

describe("linksChannel", () => {
  const mail = (text: string, html = "") => ({ text, html });

  test("finds the channel page in text or html", () => {
    expect(linksChannel(mail("Watch: https://air.example.test/n1s1abc"), "n1s1abc")).toBe(true);
    expect(linksChannel(mail("", '<a href="https://air.example.test/n1s1abc">x</a>'), "n1s1abc")).toBe(true);
    expect(linksChannel(mail("https://air.example.test/n1s1abc?utm=no"), "n1s1abc")).toBe(true);
    expect(linksChannel(mail("(https://air.example.test/n1s1abc)"), "n1s1abc")).toBe(true);
    expect(linksChannel(mail("https://air.example.test/n1s1abc/vods"), "n1s1abc")).toBe(true);
  });

  test("not a longer slug, another channel or no link", () => {
    expect(linksChannel(mail("https://air.example.test/n1s1abcd"), "n1s1abc")).toBe(false);
    expect(linksChannel(mail("https://air.example.test/n1s2xyz"), "n1s1abc")).toBe(false);
    expect(linksChannel(mail("n1s1abc is live"), "n1s1abc")).toBe(false);
  });

  test("regex characters in a slug are literal", () => {
    expect(linksChannel(mail("https://h/a_b"), "a.b")).toBe(false);
    expect(linksChannel(mail("https://h/a.b"), "a.b")).toBe(true);
  });
});

describe("step 3", () => {
  test("module contract", () => {
    expect(step).toMatchObject({ name: "cooldown", owner: "N1-fanout", needs: [1] });
    expect(step.webOnly).toBeUndefined();
    expect(COOLDOWN_WATCH_MS).toBe(45_000);
  });
});
