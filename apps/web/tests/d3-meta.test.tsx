// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D3-watch (F11): the metadata under a VOD or clip (`watch-meta`). Each field shows when the data
 * has it and is left out when it does not; Share copies the canonical URL, and for a VOD it can
 * carry the playhead as `?t=`. Plus the pure URL and start-time helpers.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parseStartTime, parseWatchSearch, playheadSeconds, watchUrl } from "../src/components/watch/share.ts";
import { WatchMeta, WatchShare, type WatchMetaProps } from "../src/components/watch/watch-meta.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => {
    const path = to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "");
    return (
      <a href={path} {...rest}>
        {children}
      </a>
    );
  },
}));

afterEach(cleanup);

const PUBLIC = "https://air.example/";
const VOD_ID = "01900000-0000-7000-8000-0000000000d1";
const CLIP_ID = "01900000-0000-7000-8000-0000000000c1";

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

const base = (over: Partial<WatchMetaProps> = {}): WatchMetaProps => ({
  kind: "vod",
  id: VOD_ID,
  slug: "rivertide",
  title: "Tuesday build stream",
  createdAt: "2026-11-01T12:00:00.000Z",
  durationSeconds: 3723,
  publicUrl: PUBLIC,
  ...over,
});

function fakeClipboard() {
  const writes: string[] = [];
  return {
    writes,
    clipboard: { writeText: vi.fn<(s: string) => Promise<void>>(async (s: string) => void writes.push(s)) },
  };
}

describe("watchUrl", () => {
  it("is the canonical VOD or clip URL, trimming the public URL's slashes", () => {
    expect(watchUrl(PUBLIC, "vod", "rivertide", VOD_ID)).toBe(`https://air.example/rivertide/vods/${VOD_ID}`);
    expect(watchUrl("https://air.example///", "clip", "rivertide", CLIP_ID)).toBe(
      `https://air.example/rivertide/clips/${CLIP_ID}`,
    );
  });

  it("adds ?t= only for a positive whole start", () => {
    expect(watchUrl(PUBLIC, "vod", "r_t", "x", 83.9)).toBe("https://air.example/r_t/vods/x?t=83");
    expect(watchUrl(PUBLIC, "vod", "r_t", "x", 0)).toBe("https://air.example/r_t/vods/x");
    expect(watchUrl(PUBLIC, "vod", "r_t", "x", -5)).toBe("https://air.example/r_t/vods/x");
    expect(watchUrl(PUBLIC, "vod", "r_t", "x", Number.NaN)).toBe("https://air.example/r_t/vods/x");
    expect(watchUrl(PUBLIC, "vod", "r_t", "x", null)).toBe("https://air.example/r_t/vods/x");
  });
});

describe("parseStartTime", () => {
  it.each([
    ["90", 90],
    [" 90 ", 90],
    [90, 90],
    ["1h2m3s", 3723],
    ["2m", 120],
    ["45s", 45],
    ["1H", 3600],
    ["172800", 172800],
  ])("%j is %d seconds", (raw, seconds) => {
    expect(parseStartTime(raw)).toBe(seconds);
  });

  it.each([
    ["0"],
    [0],
    [""],
    ["abc"],
    ["-5"],
    ["1.5"],
    [1.5],
    ["172801"],
    ["49h"],
    ["1s2m"],
    [null],
    [undefined],
    [{}],
  ])("%j is no start time", (raw) => {
    expect(parseStartTime(raw)).toBeNull();
  });

  it("validateSearch keeps only a valid t", () => {
    expect(parseWatchSearch({ t: "90", other: "x" })).toEqual({ t: 90 });
    expect(parseWatchSearch({ t: "nope" })).toEqual({});
    expect(parseWatchSearch({})).toEqual({});
  });
});

describe("playheadSeconds", () => {
  it("is whole seconds from the origin, or null while unknown or before it", () => {
    expect(playheadSeconds(83_900_000, 0)).toBe(83);
    expect(playheadSeconds(5_000_000, 5_000_000)).toBe(0);
    expect(playheadSeconds(null, 0)).toBeNull();
    expect(playheadSeconds(0, null)).toBeNull();
    expect(playheadSeconds(0, 1_000_000)).toBeNull();
  });
});

describe("WatchMeta fields", () => {
  it("a VOD: title, time, length; no views, no clipper, no category without data", () => {
    wrap(<WatchMeta {...base()} />);
    expect(byId("watch-meta")?.getAttribute("data-kind")).toBe("vod");
    expect(byId("watch-title")?.textContent).toBe("Tuesday build stream");
    expect(byId("watch-meta-time")?.querySelector("time")).not.toBeNull();
    expect(byId("watch-meta-duration")?.textContent).toContain("1:02:03");
    expect(byId("watch-meta-views")).toBeNull();
    expect(byId("watch-meta-clipped-by")).toBeNull();
    expect(byId("channel-meta-category")).toBeNull();
    expect(byId("watch-share")).not.toBeNull();
  });

  it("an untitled VOD says so instead of an empty heading", () => {
    wrap(<WatchMeta {...base({ title: "  " })} />);
    expect(byId("watch-title")?.textContent).toBe(t("channel.tabs.untitledVideo"));
  });

  it("the category links into the directory when it is given", () => {
    wrap(<WatchMeta {...base({ category: { slug: "art", name: "Art" } })} />);
    const link = byId("channel-meta-category");
    expect(link?.textContent).toBe("Art");
    expect(link?.getAttribute("data-slug")).toBe("art");
  });

  it("a clip: views and who clipped it", () => {
    wrap(
      <WatchMeta
        {...base({ kind: "clip", id: CLIP_ID, title: "The jump", durationSeconds: 30 })}
        views={1}
        clippedBy={{ displayName: "Fan" }}
      />,
    );
    expect(byId("watch-meta-views")?.textContent).toBe(t("watch.meta.views", { count: 1 }));
    expect(byId("watch-meta-views")?.getAttribute("data-count")).toBe("1");
    const by = byId("watch-meta-clipped-by");
    expect(by?.textContent).toContain(t("replay.watch.clippedBy", { name: "Fan" }));
    expect(by?.querySelector('[data-slot="avatar"], [aria-hidden="true"]')).not.toBeNull();
  });

  it("a clip with zero views still shows the count; a clip with no clipper shows none", () => {
    wrap(<WatchMeta {...base({ kind: "clip", id: CLIP_ID })} views={0} clippedBy={null} />);
    expect(byId("watch-meta-views")?.textContent).toBe(t("watch.meta.views", { count: 0 }));
    expect(byId("watch-meta-clipped-by")).toBeNull();
  });
});

describe("Share", () => {
  it("a clip copies its canonical URL at once", async () => {
    const { writes, clipboard } = fakeClipboard();
    wrap(<WatchShare kind="clip" publicUrl={PUBLIC} slug="rivertide" id={CLIP_ID} clipboard={clipboard} />);
    const share = byId("watch-share") as HTMLElement;
    expect(share.getAttribute("aria-label")).toBe(t("watch.share.label"));
    await act(async () => {
      fireEvent.click(share);
    });
    await waitFor(() => expect(writes).toEqual([`https://air.example/rivertide/clips/${CLIP_ID}`]));
    expect(byId("watch-share-popover")).toBeNull();
  });

  it("a VOD without the timestamp copies the plain URL", async () => {
    const { writes, clipboard } = fakeClipboard();
    wrap(
      <WatchShare
        kind="vod"
        publicUrl={PUBLIC}
        slug="rivertide"
        id={VOD_ID}
        currentTime={() => 83}
        clipboard={clipboard}
      />,
    );
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-popover")).not.toBeNull());
    expect((byId("watch-share-url") as HTMLInputElement).value).toBe(`https://air.example/rivertide/vods/${VOD_ID}`);
    await act(async () => {
      fireEvent.click(byId("watch-share-copy") as HTMLElement);
    });
    await waitFor(() => expect(writes).toEqual([`https://air.example/rivertide/vods/${VOD_ID}`]));
  });

  it("a VOD with the timestamp checked copies ?t= at the playhead", async () => {
    const { writes, clipboard } = fakeClipboard();
    wrap(
      <WatchShare
        kind="vod"
        publicUrl={PUBLIC}
        slug="rivertide"
        id={VOD_ID}
        currentTime={() => 83}
        clipboard={clipboard}
      />,
    );
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-time")).not.toBeNull());
    expect(document.body.textContent).toContain(t("watch.share.startAt", { time: "1:23" }));
    fireEvent.click(byId("watch-share-time") as HTMLElement);
    await waitFor(() =>
      expect((byId("watch-share-url") as HTMLInputElement).value).toBe(
        `https://air.example/rivertide/vods/${VOD_ID}?t=83`,
      ),
    );
    await act(async () => {
      fireEvent.click(byId("watch-share-copy") as HTMLElement);
    });
    await waitFor(() => expect(writes).toEqual([`https://air.example/rivertide/vods/${VOD_ID}?t=83`]));
  });

  it("before the player knows the playhead, the timestamp cannot be chosen", async () => {
    wrap(<WatchShare kind="vod" publicUrl={PUBLIC} slug="rivertide" id={VOD_ID} currentTime={() => null} />);
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-time")).not.toBeNull());
    const box = byId("watch-share-time") as HTMLElement;
    expect(box.getAttribute("aria-disabled") === "true" || box.hasAttribute("data-disabled")).toBe(true);
    expect((byId("watch-share-url") as HTMLInputElement).value).not.toContain("?t=");
  });

  it("no clipboard: nothing is copied and the page does not throw", async () => {
    wrap(<WatchShare kind="clip" publicUrl={PUBLIC} slug="rivertide" id={CLIP_ID} clipboard={null} />);
    await act(async () => {
      fireEvent.click(byId("watch-share") as HTMLElement);
    });
    expect(byId("watch-share")).not.toBeNull();
  });
});
