// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The service worker's push handling: payload validation, the notification, the click target, the language. */
import { PushPayload } from "@commonair/contracts/notify";
import { describe, expect, it } from "vite-plus/test";
import { workerLocale, workerMessage } from "../src/sw/messages.ts";
import { MAX_PUSH_TITLE, clickTarget, goLiveNotification, parsePushPayload } from "../src/sw/push.ts";

const ORIGIN = "https://air.example";
const valid = { v: 1, type: "go_live", slug: "some_body", title: "Speedrun night" } as const;

describe("parsePushPayload", () => {
  it("accepts a go-live payload", () => {
    expect(parsePushPayload(valid)).toEqual(valid);
    expect(parsePushPayload({ ...valid, title: "" })).toEqual({ ...valid, title: "" });
  });

  it("ignores extra fields", () => {
    expect(parsePushPayload({ ...valid, extra: "x", nested: { a: 1 } })).toEqual(valid);
  });

  it("agrees with the contract on what it accepts", () => {
    for (const p of [valid, { ...valid, title: "" }, { ...valid, title: "x".repeat(MAX_PUSH_TITLE) }])
      expect(PushPayload.safeParse(p).success && parsePushPayload(p) !== null).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "go_live"],
    ["an array", [1, "go_live"]],
    ["no v", { type: "go_live", slug: "a_b", title: "" }],
    ["v 2", { ...valid, v: 2 }],
    ["v as a string", { ...valid, v: "1" }],
    ["another type", { ...valid, type: "raid" }],
    ["no slug", { v: 1, type: "go_live", title: "" }],
    ["an empty slug", { ...valid, slug: "" }],
    ["a slug with a slash", { ...valid, slug: "a/b" }],
    ["a slug with dots", { ...valid, slug: ".." }],
    ["a numeric slug", { ...valid, slug: 7 }],
    ["no title", { v: 1, type: "go_live", slug: "a_b" }],
    ["a null title", { ...valid, title: null }],
    ["a long title", { ...valid, title: "x".repeat(MAX_PUSH_TITLE + 1) }],
  ])("refuses %s", (_label, data) => {
    expect(parsePushPayload(data)).toBeNull();
  });
});

describe("goLiveNotification", () => {
  it("titles it from the bundled catalog, with the stream title as the body", () => {
    const n = goLiveNotification(valid, ["en-US"]);
    expect(n.title).toBe("some_body is live");
    expect(n.options).toEqual({
      body: "Speedrun night",
      tag: "go-live-some_body",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      lang: "en",
      data: { url: "/some_body" },
    });
  });

  it("has an empty body when the title is withheld (mature, not confirmed 18+)", () => {
    const n = goLiveNotification({ ...valid, title: "" }, ["en"]);
    expect(n.options.body).toBe("");
    expect(n.title).toContain("some_body");
  });

  it("tags by channel, so a repeat replaces the earlier notification", () => {
    expect(goLiveNotification({ ...valid, title: "a" }, []).options.tag).toBe(
      goLiveNotification({ ...valid, title: "b" }, []).options.tag,
    );
    expect(goLiveNotification({ ...valid, slug: "other" }, []).options.tag).toBe("go-live-other");
  });
});

describe("worker language", () => {
  it("picks a bundled catalog by the browser's languages, English otherwise", () => {
    expect(workerLocale(["en-GB", "de"])).toBe("en");
    expect(workerLocale(["de-DE", "fr"])).toBe("en");
    expect(workerLocale([])).toBe("en");
    expect(workerLocale(["en-XA"])).toBe("en");
  });

  it("formats the message with its argument", () => {
    expect(workerMessage("pwa.push.live", { channel: "abc" }, "en")).toBe("abc is live");
    expect(workerMessage("pwa.push.live", { channel: "abc" }, "zz")).toBe("abc is live");
  });
});

describe("clickTarget", () => {
  it("opens the channel path on this origin", () => {
    expect(clickTarget({ url: "/some_body" }, ORIGIN)).toBe(`${ORIGIN}/some_body`);
    expect(clickTarget({ url: "/a/b?x=1" }, ORIGIN)).toBe(`${ORIGIN}/a/b?x=1`);
  });

  it.each([
    ["no data", undefined],
    ["null", null],
    ["no url", {}],
    ["a number", { url: 7 }],
    ["an absolute URL elsewhere", { url: "https://evil.example/x" }],
    ["a protocol-relative URL", { url: "//evil.example/x" }],
    ["a backslash trick", { url: "/\\evil.example" }],
    ["a javascript: URL", { url: "javascript:alert(1)" }],
    ["a relative path", { url: "some_body" }],
    ["the same origin spelled absolutely", { url: `${ORIGIN}/x` }],
  ])("opens the home page for %s", (_label, data) => {
    expect(clickTarget(data, ORIGIN)).toBe(`${ORIGIN}/`);
  });
});
