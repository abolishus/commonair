// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure parts of the E2 social scenario (docs/testing/e2-selectors.md). */
import { describe, expect, test } from "vite-plus/test";
import { VIA, parseVia } from "../scenarios/e2e-social.ts";
import {
  DISCOVERY_SECTIONS,
  TIMEOUT_SECONDS,
  isActiveTimeout,
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
