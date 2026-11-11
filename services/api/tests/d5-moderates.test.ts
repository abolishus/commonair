// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ModeratedChannel } from "@commonair/contracts/dto";
import { compareModerated, strongerRole } from "../src/studio/moderates.ts";

const row = (slug: string, displayName: string, live: boolean): ModeratedChannel => ({
  channel: { id: slug, slug, displayName, avatarUrl: null, accent: "violet" },
  role: "moderator",
  live,
});

describe("strongerRole", () => {
  test.each([
    ["moderator", "moderator", "moderator"],
    ["moderator", "editor", "editor"],
    ["editor", "moderator", "editor"],
    ["editor", "editor", "editor"],
  ] as const)("%s + %s = %s", (a, b, want) => {
    expect(strongerRole(a, b)).toBe(want);
  });
});

describe("compareModerated", () => {
  test("live first, then name case-insensitively, then slug", () => {
    const list = [
      row("d", "beta", false),
      row("c", "Alpha", false),
      row("b", "zed", true),
      row("a", "alpha", false),
      row("e", "Yak", true),
    ].sort(compareModerated);
    expect(list.map((r) => r.channel.slug)).toEqual(["e", "b", "a", "c", "d"]);
  });

  test("an empty list stays empty", () => {
    expect([].sort(compareModerated)).toEqual([]);
  });
});
