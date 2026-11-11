// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 2, d3-watch: the pure rules behind the viewer Clip button (D3.7), Continue
 * watching's writer (D3.6), the panels' markdown (D3.8), the offline Follow hero and its calendar
 * event (D3.8), and the video and clip pages' next steps (D3.9).
 */
import { describe, expect, it } from "vite-plus/test";
import { offlineHeroState, nextStreamIcs } from "../src/components/channel/offline-hero.tsx";
import { parseInline, parsePanelMarkdown } from "../src/components/channel/panels-data.ts";
import type { VideoTile } from "../src/components/channel/video-grid.tsx";
import { RESUME_SAVE_MS, resumeOffer, resumePoint, saveDue } from "../src/components/vod-watch/resume-writer.ts";
import {
  clipErrorMessage,
  MIN_CLIP_SECONDS,
  VIEWER_CLIP_SECONDS,
  vodClipRange,
} from "../src/components/watch/clip-button.tsx";
import { browserShare, momentStart, shareCancelled, upNext } from "../src/components/watch/share.ts";
import { nextShelves } from "../src/components/watch/watch-more.tsx";
import { t } from "../src/i18n/index.ts";
import { RESUME_KEY, saveResumePoint } from "../src/lib/resume.ts";

describe("vodClipRange", () => {
  it("is the 30 seconds that end at the playhead, in whole seconds", () => {
    expect(VIEWER_CLIP_SECONDS).toBe(30);
    expect(vodClipRange(754.8, 1800)).toEqual({ startOffset: 724, durationSeconds: 30 });
  });

  it("near the start: from 0 to the playhead, or the first 30 s when that is too short", () => {
    expect(vodClipRange(12, 1800)).toEqual({ startOffset: 0, durationSeconds: 12 });
    expect(vodClipRange(MIN_CLIP_SECONDS, 1800)).toEqual({ startOffset: 0, durationSeconds: 5 });
    expect(vodClipRange(2, 1800)).toEqual({ startOffset: 0, durationSeconds: 30 });
    expect(vodClipRange(0, 1800)).toEqual({ startOffset: 0, durationSeconds: 30 });
  });

  it("never past the end: the playhead is clamped to the video's length", () => {
    expect(vodClipRange(5000, 600)).toEqual({ startOffset: 570, durationSeconds: 30 });
    expect(vodClipRange(5000, 600.9)).toEqual({ startOffset: 570, durationSeconds: 30 });
  });

  it("a video shorter than 30 s clips all of it; shorter than 5 s, nothing", () => {
    expect(vodClipRange(1, 20)).toEqual({ startOffset: 0, durationSeconds: 20 });
    expect(vodClipRange(1, 4.9)).toBeNull();
    expect(vodClipRange(1, 0)).toBeNull();
  });

  it("an unknown playhead or length is no range", () => {
    expect(vodClipRange(null, 600)).toBeNull();
    expect(vodClipRange(Number.NaN, 600)).toBeNull();
    expect(vodClipRange(10, Number.POSITIVE_INFINITY)).toBeNull();
    expect(vodClipRange(-10, 600)).toEqual({ startOffset: 0, durationSeconds: 30 });
  });
});

describe("clipErrorMessage", () => {
  const err = (code: string, data?: unknown) => Object.assign(new Error(code), { code, data });
  it("names what the viewer can do for each refusal", () => {
    expect(clipErrorMessage(err("FORBIDDEN", { reason: "mature_gate" }))).toBe(t("d3Watch.clip.error.mature"));
    expect(clipErrorMessage(err("UNAUTHORIZED"))).toBe(t("d3Watch.clip.error.signIn"));
    expect(clipErrorMessage(err("RATE_LIMITED", { retryAfterSeconds: 3 }))).toBe(t("d3Watch.clip.error.rateLimited"));
    expect(clipErrorMessage(err("PRECONDITION_FAILED", { requirement: "live" }))).toBe(
      t("d3Watch.clip.error.unavailable"),
    );
    expect(clipErrorMessage(err("NOT_FOUND"))).toBe(t("d3Watch.clip.error.notFound"));
    expect(clipErrorMessage(new Error("network"))).toBe(t("d3Watch.clip.error.generic"));
    expect(clipErrorMessage(err("FORBIDDEN"))).toBe(t("d3Watch.clip.error.generic"));
  });
});

const tile = (n: number): VideoTile => ({
  id: `v${n}`,
  kind: "vods",
  channelSlug: "rivertide",
  title: `Video ${n}`,
  thumbnailUrl: null,
  durationSeconds: 60,
  createdAt: "2026-11-01T12:00:00.000Z",
  views: null,
  clippedBy: null,
});

describe("upNext and nextShelves", () => {
  const tiles = [1, 2, 3, 4].map(tile);

  it("the item recorded right after the current one (the one before it, newest first)", () => {
    expect(upNext(tiles, "v3")?.id).toBe("v2");
    expect(upNext(tiles, "v4")?.id).toBe("v3");
  });

  it("the newest item, or the newest other one when the current is not listed or is the newest", () => {
    expect(upNext(tiles, "v1")?.id).toBe("v2");
    expect(upNext(tiles, "old")?.id).toBe("v1");
  });

  it("nothing else: none", () => {
    expect(upNext([tile(1)], "v1")).toBeNull();
    expect(upNext([], "v1")).toBeNull();
  });

  it("More from leaves out the current item and Up next", () => {
    const { next, more } = nextShelves(tiles, "v3");
    expect(next?.id).toBe("v2");
    expect(more.map((x) => x.id)).toEqual(["v1", "v4"]);
    expect(nextShelves([tile(1), tile(2)], "v1")).toMatchObject({ next: { id: "v2" }, more: [] });
    expect(nextShelves([tile(1)], "v1")).toEqual({ next: null, more: [] });
  });

  it("More from still caps at six", () => {
    const many = Array.from({ length: 12 }, (_, i) => tile(i + 1));
    expect(nextShelves(many, "v1").more).toHaveLength(6);
  });
});

describe("momentStart", () => {
  it("whole seconds into the video; the start itself needs no ?t=", () => {
    expect(momentStart(754.5)).toBe(754);
    expect(momentStart(0.9)).toBeNull();
    expect(momentStart(0)).toBeNull();
    expect(momentStart(null)).toBeNull();
    expect(momentStart(Number.NaN)).toBeNull();
  });
});

describe("the share sheet", () => {
  it("a closed sheet is not a failure", () => {
    expect(shareCancelled(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(shareCancelled(new Error("x"))).toBe(false);
    expect(shareCancelled("AbortError")).toBe(false);
  });

  it("is the browser's navigator.share, or none", async () => {
    const nav = globalThis.navigator as Navigator & { share?: unknown };
    const had = Object.getOwnPropertyDescriptor(nav, "share");
    try {
      Object.defineProperty(nav, "share", { value: undefined, configurable: true });
      expect(browserShare()).toBeNull();
      const calls: unknown[] = [];
      Object.defineProperty(nav, "share", {
        value: async (d: unknown) => {
          calls.push(d);
        },
        configurable: true,
      });
      await browserShare()?.({ title: "A", url: "https://x.example/a" });
      expect(calls).toEqual([{ title: "A", url: "https://x.example/a" }]);
    } finally {
      if (had) Object.defineProperty(nav, "share", had);
      else Reflect.deleteProperty(nav, "share");
    }
  });
});

/** An in-memory `Storage` for the resume helpers. */
function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

const video = { vodId: "v1", channelSlug: "rivertide", title: "Build", thumbnailUrl: null, durationSeconds: 1800 };

describe("Continue watching: the writer's rules", () => {
  it("builds a point in whole seconds, with the element's length once known", () => {
    const at = new Date("2026-11-10T10:00:00.000Z");
    expect(resumePoint(video, { positionSeconds: 754.9, durationSeconds: 1799.5, paused: false }, at)).toEqual({
      vodId: "v1",
      channelSlug: "rivertide",
      title: "Build",
      thumbnailUrl: null,
      positionSeconds: 754,
      durationSeconds: 1799,
      updatedAt: "2026-11-10T10:00:00.000Z",
    });
    expect(resumePoint(video, { positionSeconds: 10, durationSeconds: 0, paused: true }, at).durationSeconds).toBe(
      1800,
    );
  });

  it("saves on pause at once, and while playing once per interval", () => {
    expect(saveDue(null, 0, false)).toBe(true);
    expect(saveDue(1000, 1000 + RESUME_SAVE_MS - 1, false)).toBe(false);
    expect(saveDue(1000, 1000 + RESUME_SAVE_MS, false)).toBe(true);
    expect(saveDue(1000, 1001, true)).toBe(true);
  });

  it("offers the stored position, not with ?t=, and not near either end", () => {
    const store = memoryStore();
    const save = (pos: number) =>
      saveResumePoint(
        {
          vodId: "v1",
          channelSlug: "rivertide",
          title: "Build",
          thumbnailUrl: null,
          positionSeconds: pos,
          durationSeconds: 1800,
          updatedAt: "2026-11-10T10:00:00.000Z",
        },
        store,
      );
    expect(resumeOffer("v1", null, 1800, store)).toBeNull();
    save(724);
    expect(store.data.has(RESUME_KEY)).toBe(true);
    expect(resumeOffer("v1", null, 1800, store)).toBe(724);
    expect(resumeOffer("v1", 90, 1800, store)).toBeNull();
    expect(resumeOffer("v2", null, 1800, store)).toBeNull();
    // The video got shorter than the point (re-processed): no offer past the end.
    expect(resumeOffer("v1", null, 740, store)).toBeNull();
    // An unknown length still offers.
    expect(resumeOffer("v1", null, 0, store)).toBe(724);
  });
});

describe("panel markdown", () => {
  it("paragraphs keep their line breaks; blank lines split them", () => {
    expect(parsePanelMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "p", lines: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]] },
      { type: "p", lines: [[{ type: "text", text: "three" }]] },
    ]);
  });

  it("lists, ordered lists and headings", () => {
    expect(parsePanelMarkdown("# Rules\n1. Be kind.\n2) No spoilers.\n- a\n* b")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Rules" }] },
      {
        type: "ol",
        items: [[{ type: "text", text: "Be kind." }], [{ type: "text", text: "No spoilers." }]],
      },
      { type: "ul", items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]] },
    ]);
    expect(parsePanelMarkdown("### Small ###")[0]).toEqual({
      type: "heading",
      level: 3,
      children: [{ type: "text", text: "Small" }],
    });
    // Four hashes is not a heading in this subset.
    expect(parsePanelMarkdown("#### x")[0]?.type).toBe("p");
  });

  it("a paragraph line after a list ends the list", () => {
    expect(parsePanelMarkdown("- a\nafter").map((b) => b.type)).toEqual(["ul", "p"]);
    expect(parsePanelMarkdown("before\n- a").map((b) => b.type)).toEqual(["p", "ul"]);
  });

  it("strong, em and code inline, nested once", () => {
    expect(parseInline("a **bold** b *it* c `x*y*`")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " b " },
      { type: "em", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " c " },
      { type: "code", text: "x*y*" },
    ]);
    expect(parseInline("**a _b_**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", text: "a " },
          { type: "em", children: [{ type: "text", text: "b" }] },
        ],
      },
    ]);
  });

  it("underscores inside words stay text (snake_case_names)", () => {
    expect(parseInline("my_cool_name")).toEqual([{ type: "text", text: "my_cool_name" }]);
    expect(parseInline("_yes_")).toEqual([{ type: "em", children: [{ type: "text", text: "yes" }] }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
  });

  it("links: only absolute http(s) targets; anything else is its text", () => {
    expect(parseInline("[shop](https://shop.example.org/seeds)")).toEqual([
      { type: "link", href: "https://shop.example.org/seeds", text: "shop" },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "[x](javascript:alert(1))" }]);
    expect(parseInline("[x](javascript:void)")).toEqual([{ type: "text", text: "x" }]);
    expect(parseInline("[x](/relative)")).toEqual([{ type: "text", text: "x" }]);
    expect(parseInline("[x](data:text/html,hi)")).toEqual([{ type: "text", text: "x" }]);
  });

  it("bare URLs become links without trailing punctuation", () => {
    expect(parseInline("see https://a.example/x.")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://a.example/x", text: "https://a.example/x" },
      { type: "text", text: "." },
    ]);
  });

  it("raw HTML is plain text", () => {
    const html = '<b onclick="x()">hi</b><script>alert(1)</script>';
    expect(parsePanelMarkdown(html)).toEqual([{ type: "p", lines: [[{ type: "text", text: html }]] }]);
  });

  it("empty or blank: no blocks; Windows line ends count as line ends", () => {
    expect(parsePanelMarkdown("")).toEqual([]);
    expect(parsePanelMarkdown("  \n \n")).toEqual([]);
    expect(parsePanelMarkdown("a\r\nb")).toEqual([
      { type: "p", lines: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]] },
    ]);
  });
});

describe("the offline Follow hero", () => {
  it("next stream when known, else last live, else never streamed", () => {
    expect(offlineHeroState(null, { startsAt: "2026-11-12T19:00:00.000Z" })).toBe("next");
    expect(offlineHeroState("2026-11-09T10:00:00.000Z", null)).toBe("lastLive");
    expect(offlineHeroState(null, null)).toBe("never");
  });

  it("Add to calendar is an iCalendar event, escaped, an hour long without an end", () => {
    const ics = nextStreamIcs(
      { startsAt: "2026-11-12T19:00:00.000Z", title: "Campaign night; part 2, finale" },
      "Rivertide",
      "https://air.example/rivertide",
      "rivertide-1",
    );
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("DTSTART:20261112T190000Z");
    expect(lines).toContain("DTEND:20261112T200000Z");
    expect(lines).toContain("SUMMARY:Campaign night\\; part 2\\, finale");
    expect(lines).toContain("URL:https://air.example/rivertide");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const untitled = nextStreamIcs(
      { startsAt: "2026-11-12T19:00:00.000Z", endsAt: "2026-11-12T22:00:00.000Z" },
      "Rivertide",
      "https://air.example/rivertide",
      "u",
    );
    expect(untitled).toContain(`SUMMARY:${t("d3Watch.offline.calendarTitle", { name: "Rivertide" })}`);
    expect(untitled).toContain("DTEND:20261112T220000Z");
  });
});
