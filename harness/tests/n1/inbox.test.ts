// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 5 (N1-inbox): its contract shape and pure helpers. */
import { describe, expect, test } from "vite-plus/test";
import { BELL_TIMEOUT_MS, UI_TIMEOUT_MS, linksToChannel, step, switchOn, unreadOf } from "../../src/n1/inbox.ts";

const WEB = "http://localhost:3000";

describe("step 5 shape", () => {
  test("web only, needs step 1, owned by N1-inbox", () => {
    expect(step).toMatchObject({ name: "inbox", owner: "N1-inbox", needs: [1], webOnly: true });
    expect(step.requires).toBeUndefined();
  });

  test("timeouts leave room for a loaded runner and cover the bell's first fetch", () => {
    expect(UI_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(BELL_TIMEOUT_MS).toBeGreaterThan(UI_TIMEOUT_MS);
  });
});

describe("unreadOf", () => {
  test("integers only", () => {
    expect(unreadOf("0")).toBe(0);
    expect(unreadOf("7")).toBe(7);
    expect(unreadOf("99")).toBe(99);
    for (const bad of [null, "", "-1", "1.5", "99+", " 3"]) expect(unreadOf(bad), String(bad)).toBeNull();
  });
});

describe("switchOn", () => {
  test("on/off only", () => {
    expect(switchOn("on")).toBe(true);
    expect(switchOn("off")).toBe(false);
    expect(switchOn(null)).toBeNull();
    expect(switchOn("busy")).toBeNull();
    expect(switchOn("true")).toBeNull();
  });
});

describe("linksToChannel", () => {
  test("relative and same-origin absolute hrefs to /<slug>", () => {
    expect(linksToChannel("/rivertide", "rivertide", WEB)).toBe(true);
    expect(linksToChannel(`${WEB}/rivertide`, "rivertide", WEB)).toBe(true);
  });

  test("anything else is not the channel page", () => {
    expect(linksToChannel(null, "rivertide", WEB)).toBe(false);
    expect(linksToChannel("/rivertide2", "rivertide", WEB)).toBe(false);
    expect(linksToChannel("/rivertide/videos", "rivertide", WEB)).toBe(false);
    expect(linksToChannel("/rivertide?x=1", "rivertide", WEB)).toBe(false);
    expect(linksToChannel("https://evil.example/rivertide", "rivertide", WEB)).toBe(false);
    expect(linksToChannel("/dashboard", "rivertide", WEB)).toBe(false);
  });
});
