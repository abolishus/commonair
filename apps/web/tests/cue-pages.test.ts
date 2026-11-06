// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** F36: the `/captions` editor's pages of time. */
import { describe, expect, it } from "vite-plus/test";
import { CUE_PAGE_MAX, CUE_WINDOW_MS, clampPage, cuePages } from "../src/player/cue-pages.ts";

const cue = (startMs: number, endMs = startMs + 1000) => ({ startMs, endMs });

describe("cuePages", () => {
  it("no cues, no pages", () => {
    expect(cuePages([])).toEqual([]);
  });

  it("groups by the start's five-minute window, boundaries included in the next", () => {
    const pages = cuePages([cue(0), cue(CUE_WINDOW_MS - 1, CUE_WINDOW_MS + 500), cue(CUE_WINDOW_MS)]);
    expect(pages.map((p) => p.cues.map((c) => c.startMs))).toEqual([[0, CUE_WINDOW_MS - 1], [CUE_WINDOW_MS]]);
    // A cue that runs over the boundary stays with its start, and the label ends where it ends.
    expect(pages[0]).toMatchObject({ startMs: 0, endMs: CUE_WINDOW_MS + 500 });
  });

  it("leaves silent windows out", () => {
    const pages = cuePages([cue(0), cue(7 * CUE_WINDOW_MS)]);
    expect(pages).toHaveLength(2);
    expect(pages[1]?.startMs).toBe(7 * CUE_WINDOW_MS);
  });

  it("sorts cues that arrive out of order and clamps negative starts into the first window", () => {
    const pages = cuePages([cue(CUE_WINDOW_MS + 5), cue(-10, 50), cue(3)]);
    expect(pages.map((p) => p.cues.map((c) => c.startMs))).toEqual([[-10, 3], [CUE_WINDOW_MS + 5]]);
  });

  it("splits a dense window at the cap", () => {
    const dense = Array.from({ length: CUE_PAGE_MAX * 2 + 1 }, (_, i) => cue(i * 10, i * 10 + 5));
    const pages = cuePages(dense);
    expect(pages.map((p) => p.cues.length)).toEqual([CUE_PAGE_MAX, CUE_PAGE_MAX, 1]);
    expect(pages[1]?.startMs).toBe(CUE_PAGE_MAX * 10);
  });

  it("takes a custom window and cap", () => {
    expect(cuePages([cue(0), cue(10), cue(20), cue(100)], 50, 2).map((p) => p.cues.length)).toEqual([2, 1, 1]);
  });
});

describe("clampPage", () => {
  it("stays inside the pages", () => {
    expect(clampPage(0, 0)).toBe(0);
    expect(clampPage(5, 0)).toBe(0);
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(3, 3)).toBe(2);
  });
});
