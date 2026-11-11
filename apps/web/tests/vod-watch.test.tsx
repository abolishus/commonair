// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The VOD and clip watch pages (W2-vod-watch; docs/testing/w2-selectors.md "VOD and clip watch
 * pages, replay panel") rendered with contract-shaped fixtures: every state (not found for a
 * missing, private, `subscribers`, failed or removed VOD and a channel mismatch; not ready;
 * the mature gate), the captions toggle only with tracks, the replay panel's rows following the
 * playhead, the catching-up label, the not-retained and empty notices, seeking from a row's time,
 * and the clip window mapping. Plus the pure page-state helpers.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReplayFetchInput, ReplayItem, ReplayPage } from "../src/chat/replay/model.ts";
import { resetBlocks } from "../src/chat/blocks.ts";
import { lineTime } from "../src/chat/replay/replay-panel.tsx";
import { clipState, vodState, type ClipDto, type VodDto } from "../src/components/vod-watch/state.ts";
import { ClipWatchPage, VodWatchPage, type WatchClient } from "../src/components/vod-watch/watch-page.tsx";
import type { MaturityClient } from "../src/components/safety/client.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    className,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
    params?: { category?: string };
  }) => (
    <a
      href={params?.category ? `/directory/${params.category}` : "/rivertide"}
      className={className}
      data-testid={(rest as { "data-testid"?: string })["data-testid"]}
      data-slug={(rest as { "data-slug"?: string })["data-slug"]}
    >
      {children}
    </a>
  ),
}));

/** A stand-in for hls.js: records the source, exposes `playingDate` for the test to move. */
const hlsState = vi.hoisted(() => ({
  instances: [] as { url: string | null; playingDate: Date | null; destroyed: boolean }[],
}));
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    url: string | null = null;
    playingDate: Date | null = null;
    destroyed = false;
    currentLevel = 0;
    levels: unknown[] = [];
    constructor() {
      hlsState.instances.push(this);
    }
    on() {}
    loadSource(url: string) {
      this.url = url;
    }
    attachMedia() {}
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakeHls };
});

vi.mock("../src/lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api.ts")>()),
  api: () => ({ me: { blocks: { ids: async () => ({ userIds: [] }) } } }),
}));

afterEach(() => {
  cleanup();
  resetBlocks();
  hlsState.instances.length = 0;
});

const VOD_ID = "01900000-0000-7000-8000-0000000000d1";
const CLIP_ID = "01900000-0000-7000-8000-0000000000c1";
const PDT = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (sec: number) => new Date(PDT + sec * 1000).toISOString();

const vod = (over: Partial<VodDto> = {}): VodDto => ({
  id: VOD_ID,
  channelSlug: "rivertide",
  title: "Tuesday build stream",
  status: "ready",
  visibility: "public",
  durationSeconds: 600,
  thumbnailUrl: null,
  playlistUrl: "/media/vods/v/index.m3u8",
  createdAt: iso(0),
  expiresAt: null,
  failedReason: null,
  captions: [],
  category: null,
  ...over,
});

const clip = (over: Partial<ClipDto> = {}): ClipDto => ({
  id: CLIP_ID,
  channelSlug: "rivertide",
  title: "The jump",
  creator: { id: "01900000-0000-7000-8000-0000000000e1", username: "fan", displayName: "Fan" },
  status: "ready",
  durationSeconds: 30,
  url: "/media/clips/c.mp4",
  thumbnailUrl: null,
  views: 3,
  createdAt: iso(0),
  windowStartedAt: iso(100),
  vodId: null,
  vodOffsetSeconds: null,
  category: null,
  ...over,
});

let seq = 0;
const line = (sec: number, over: Partial<ReplayItem> = {}): ReplayItem => {
  seq++;
  return {
    id: `01900000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "01900000-0000-7000-8000-00000000c001",
    user: {
      id: "01900000-0000-7000-8000-0000000000a1",
      username: "fan",
      displayName: "Fan",
      color: null,
      badges: [],
      accountType: "human",
    },
    body: `line at ${sec}`,
    emotes: [],
    isAction: false,
    replyTo: null,
    mediaTs: iso(sec),
    createdAt: iso(sec),
    at: iso(sec),
    catchingUp: false,
    ...over,
  } as ReplayItem;
};

const notFound = () => Object.assign(new Error("not found"), { code: "NOT_FOUND" });

function client(over: Partial<WatchClient> = {}, page: Partial<ReplayPage> = {}): WatchClient {
  const replay: ReplayPage = { items: [], nextCursor: null, retained: true, ...page };
  return {
    vod: vi.fn<WatchClient["vod"]>(async () => vod()),
    clip: vi.fn<WatchClient["clip"]>(async () => clip()),
    channel: vi.fn<WatchClient["channel"]>(async () => ({ displayName: "Rivertide", avatarUrl: null, accent: null })),
    vodChat: vi.fn<WatchClient["vodChat"]>(async (_id: string, _input: ReplayFetchInput) => replay),
    clipChat: vi.fn<WatchClient["clipChat"]>(async (_id: string, _input: ReplayFetchInput) => replay),
    // More from (D3.9 shows a failed list with its own Retry): empty here.
    channelVods: async () => ({ items: [], nextCursor: null }),
    channelClips: async () => ({ items: [], nextCursor: null }),
    ...over,
  };
}

const maturity = (): MaturityClient => ({
  me: async () => ({ isAdult: true, matureConfirmed: false }),
  confirmMature: vi.fn<MaturityClient["confirmMature"]>(async () => ({})),
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const byId = (root: HTMLElement | Document, id: string) => root.querySelector(`[data-testid="${id}"]`);
const allById = (root: HTMLElement | Document, id: string) => [...root.querySelectorAll(`[data-testid="${id}"]`)];

/** Move the fake hls.js playhead and tell the player (as hls.js's `timeupdate` would). */
async function playTo(container: HTMLElement, sec: number) {
  const hls = hlsState.instances.at(-1);
  if (!hls) throw new Error("no hls instance");
  hls.playingDate = new Date(PDT + sec * 1000);
  const video = container.querySelector("video");
  if (!video) throw new Error("no video");
  await act(async () => {
    video.dispatchEvent(new Event("timeupdate"));
  });
}

describe("page state", () => {
  it("maps a VOD to its state", () => {
    expect(vodState(null, "rivertide")).toBe("not-found");
    expect(vodState(vod(), "rivertide")).toBe("ready");
    expect(vodState(vod(), "RiverTide")).toBe("ready");
    expect(vodState(vod(), "someone")).toBe("not-found");
    expect(vodState(vod({ status: "recording", playlistUrl: null }), "rivertide")).toBe("not-ready");
    expect(vodState(vod({ status: "processing", playlistUrl: null }), "rivertide")).toBe("not-ready");
    expect(vodState(vod({ status: "failed", playlistUrl: null }), "rivertide")).toBe("not-found");
    expect(vodState(vod({ status: "deleted", playlistUrl: null }), "rivertide")).toBe("not-found");
    expect(vodState(vod({ playlistUrl: null }), "rivertide")).toBe("gated");
  });

  it("maps a clip to its state", () => {
    expect(clipState(null, "rivertide")).toBe("not-found");
    expect(clipState(clip(), "rivertide")).toBe("ready");
    expect(clipState(clip(), "other")).toBe("not-found");
    expect(clipState(clip({ status: "processing", url: null }), "rivertide")).toBe("not-ready");
    expect(clipState(clip({ status: "failed", url: null }), "rivertide")).toBe("not-found");
    expect(clipState(clip({ status: "deleted", url: null }), "rivertide")).toBe("not-found");
    expect(clipState(clip({ url: null }), "rivertide")).toBe("gated");
  });

  it("formats a line's place in the video", () => {
    expect(lineTime(PDT * 1000 + 65_000_000, PDT * 1000)).toBe("1:05");
    expect(lineTime(PDT * 1000, null)).toBe("—");
  });
});

describe("VOD watch page", () => {
  it("shows a skeleton while loading", () => {
    const c = client({ vod: () => new Promise<VodDto>(() => undefined) });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    expect(container.querySelector('[data-slot="skeleton"], output')).not.toBeNull();
    expect(byId(container, "vod-watch-page")).toBeNull();
  });

  it.each([
    ["missing, private or subscribers-only for a stranger (NOT_FOUND)", () => Promise.reject(notFound())],
    ["failed", async () => vod({ status: "failed", playlistUrl: null, failedReason: "no_segments" })],
    ["removed (deleted)", async () => vod({ status: "deleted", playlistUrl: null })],
    ["on another channel", async () => vod({ channelSlug: "someone-else" })],
  ])("not found when %s, without saying why", async (_label, get) => {
    const c = client({ vod: get as WatchClient["vod"] });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "watch-not-found")).not.toBeNull());
    expect(byId(container, "vod-watch-page")).toBeNull();
    expect(byId(container, "vod-player")).toBeNull();
    expect(container.textContent).toContain(t("replay.watch.notFound"));
    expect(container.textContent).not.toContain("Tuesday build stream");
    expect(c.vodChat).not.toHaveBeenCalled();
  });

  it.each(["recording", "processing"] as const)("%s is not ready yet", async (status) => {
    const c = client({ vod: async () => vod({ status, playlistUrl: null }) });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "watch-not-ready")).not.toBeNull());
    expect(byId(container, "vod-watch-page")?.getAttribute("data-state")).toBe("not-ready");
    expect(byId(container, "watch-title")?.textContent).toBe("Tuesday build stream");
    expect(byId(container, "vod-player")).toBeNull();
    expect(byId(container, "replay-panel")).toBeNull();
  });

  it("a mature VOD shows the 18+ gate, then plays once confirmed", async () => {
    let confirmed = false;
    const c = client({ vod: async () => vod({ playlistUrl: confirmed ? "/media/v.m3u8" : null }) });
    const m: MaturityClient = {
      ...maturity(),
      confirmMature: async () => {
        confirmed = true;
        return {};
      },
    };
    const { container } = wrap(
      <VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={{ username: "fan" }} client={c} maturity={m} />,
    );
    await waitFor(() => expect(byId(container, "mature-gate")).not.toBeNull());
    expect(byId(container, "vod-watch-page")?.getAttribute("data-state")).toBe("gated");
    expect(byId(container, "vod-player")).toBeNull();
    expect(byId(container, "replay-panel")).toBeNull();
    const confirm = byId(container, "mature-gate-confirm");
    if (!confirm) throw new Error("no confirm");
    fireEvent.click(confirm);
    await waitFor(() => expect(byId(container, "vod-watch-page")?.getAttribute("data-state")).toBe("ready"));
    expect(byId(container, "vod-player")).not.toBeNull();
  });

  it("a signed-out viewer of a mature VOD is asked to sign in", async () => {
    const c = client({ vod: async () => vod({ playlistUrl: null }) });
    const { container } = wrap(
      <VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} maturity={maturity()} />,
    );
    await waitFor(() => expect(byId(container, "mature-gate-signin")).not.toBeNull());
  });

  it("a ready VOD: title, channel link, player, replay panel with no live announcements", async () => {
    const c = client();
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "vod-player")).not.toBeNull());
    const page = byId(container, "vod-watch-page");
    expect(page?.getAttribute("data-state")).toBe("ready");
    expect(page?.getAttribute("data-vod-id")).toBe(VOD_ID);
    expect(byId(container, "watch-title")?.textContent).toBe("Tuesday build stream");
    await waitFor(() => expect(byId(container, "watch-channel-link")?.textContent).toContain("Rivertide"));
    expect(byId(container, "vod-player")?.getAttribute("data-playhead")).toBe("");
    const panel = byId(container, "replay-panel");
    const log = panel?.querySelector('[role="log"]');
    expect(log?.getAttribute("aria-live")).toBe("off");
    await waitFor(() => expect(hlsState.instances.at(-1)?.url).toBe("/media/vods/v/index.m3u8"));
    // No caption tracks: no toggle.
    expect(byId(container, "vod-captions-toggle")).toBeNull();
  });

  it("links the VOD's category into the directory, and shows none without one", async () => {
    const withCategory = client({ vod: async () => vod({ category: { slug: "art", name: "Art" } }) });
    const first = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={withCategory} />);
    await waitFor(() => expect(byId(first.container, "watch-meta")).not.toBeNull());
    const link = byId(first.container, "channel-meta-category");
    expect(link?.textContent).toBe("Art");
    expect(link?.getAttribute("href")).toBe("/directory/art");
    expect(link?.getAttribute("data-slug")).toBe("art");
    first.unmount();
    const second = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId(second.container, "watch-meta")).not.toBeNull());
    expect(byId(second.container, "channel-meta-category")).toBeNull();
  });

  it("the captions toggle shows only with tracks and turns the track on and off", async () => {
    const c = client({
      vod: async () => vod({ captions: [{ language: "en", label: "English", url: "/media/vods/v/captions/en.vtt" }] }),
    });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "vod-captions-toggle")).not.toBeNull());
    const track = container.querySelector("video track");
    expect(track?.getAttribute("src")).toBe("/media/vods/v/captions/en.vtt");
    const toggle = byId(container, "vod-captions-toggle") as HTMLElement;
    expect(toggle.getAttribute("data-state")).toBe("off");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("data-state")).toBe("on");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("data-state")).toBe("off");
  });

  it("rows appear as the playhead passes them, in order, catching-up labelled; seeking back trims", async () => {
    const a = line(10);
    const b = line(20, { catchingUp: true, mediaTs: null });
    const c2 = line(30);
    const c = client({}, { items: [a, b, c2] });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(hlsState.instances.length).toBe(1));
    await waitFor(() => expect(c.vodChat).toHaveBeenCalled());
    const rows = () => allById(container, "replay-row").map((r) => r.getAttribute("data-message-id"));
    await playTo(container, 5);
    expect(rows()).toEqual([]);
    expect(byId(container, "vod-player")?.getAttribute("data-playhead")).toBe(iso(5));
    await playTo(container, 20);
    expect(rows()).toEqual([a.id, b.id]);
    const shown = allById(container, "replay-row");
    expect(shown.map((r) => r.getAttribute("data-at"))).toEqual([a.at, b.at]);
    expect(shown[1]?.querySelector('[data-testid="replay-catching-up"]')?.textContent).toBe(t("replay.row.catchingUp"));
    expect(shown[0]?.querySelector('[data-testid="replay-catching-up"]')).toBeNull();
    await playTo(container, 60);
    expect(rows()).toEqual([a.id, b.id, c2.id]);
    await playTo(container, 15);
    expect(rows()).toEqual([a.id]);
  });

  it("a block made during the visit hides that author's rows", async () => {
    const villain = "01900000-0000-7000-8000-0000000000b9";
    const a = line(10, {
      user: {
        id: villain,
        username: "villain",
        displayName: "Villain",
        color: null,
        badges: [],
        accountType: "human",
      },
    });
    const b = line(12);
    const c = client({}, { items: [a, b] });
    const { container } = wrap(
      <VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={{ username: "fan" }} client={c} />,
    );
    await waitFor(() => expect(c.vodChat).toHaveBeenCalled());
    await waitFor(() => expect(hlsState.instances.length).toBe(1));
    await playTo(container, 20);
    expect(allById(container, "replay-row")).toHaveLength(2);
    const { noteBlocked } = await import("../src/chat/blocks.ts");
    act(() => noteBlocked({ id: villain, username: "villain" }));
    expect(allById(container, "replay-row").map((r) => r.getAttribute("data-message-id"))).toEqual([b.id]);
  });

  it("says when chat is no longer kept", async () => {
    const c = client({}, { items: [], retained: false });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "replay-not-retained")).not.toBeNull());
    expect(byId(container, "replay-empty")).toBeNull();
  });

  it("an empty broadcast shows the empty state", async () => {
    const c = client();
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "replay-empty")).not.toBeNull());
  });

  it("shows the loading row while the first page loads, and a retry after a failure", async () => {
    let fail = true;
    const c = client({
      vodChat: vi.fn<WatchClient["vodChat"]>(async () => {
        if (fail) throw new Error("network");
        return { items: [line(1)], nextCursor: null, retained: true };
      }),
    });
    const { container, getByRole } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "replay-panel")).not.toBeNull());
    await waitFor(() => expect(container.textContent).toContain(t("replay.error")));
    fail = false;
    fireEvent.click(getByRole("button", { name: t("replay.retry") }));
    await waitFor(() => expect(container.textContent).not.toContain(t("replay.error")));
    expect(c.vodChat).toHaveBeenCalledTimes(2);
  });

  it("the loading row shows while pages are fetched", async () => {
    const c = client({ vodChat: vi.fn<WatchClient["vodChat"]>(() => new Promise<ReplayPage>(() => undefined)) });
    const { container } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "replay-loading")).not.toBeNull());
  });

  it("an error loading the VOD offers a retry", async () => {
    let calls = 0;
    const c = client({
      vod: vi.fn<WatchClient["vod"]>(async () => {
        calls++;
        if (calls === 1) throw new Error("network");
        return vod();
      }),
    });
    const { container, getByRole } = wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={c} />);
    await waitFor(() => expect(container.textContent).toContain(t("replay.watch.loadFailed")));
    fireEvent.click(getByRole("button", { name: t("replay.retry") }));
    await waitFor(() => expect(byId(container, "vod-player")).not.toBeNull());
  });
});

describe("clip watch page", () => {
  it("not found and not ready, as for VODs", async () => {
    const missing = wrap(
      <ClipWatchPage
        channel="rivertide"
        clipId={CLIP_ID}
        viewer={null}
        client={client({ clip: () => Promise.reject(notFound()) })}
      />,
    );
    await waitFor(() => expect(byId(missing.container, "watch-not-found")).not.toBeNull());
    cleanup();
    const processing = wrap(
      <ClipWatchPage
        channel="rivertide"
        clipId={CLIP_ID}
        viewer={null}
        client={client({ clip: async () => clip({ status: "processing", url: null }) })}
      />,
    );
    await waitFor(() => expect(byId(processing.container, "watch-not-ready")).not.toBeNull());
  });

  it("links the clip's category into the directory", async () => {
    const c = client({ clip: async () => clip({ category: { slug: "speedruns", name: "Speedruns" } }) });
    const { container } = wrap(<ClipWatchPage channel="rivertide" clipId={CLIP_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "watch-meta")).not.toBeNull());
    const link = byId(container, "channel-meta-category");
    expect(link?.textContent).toBe("Speedruns");
    expect(link?.getAttribute("href")).toBe("/directory/speedruns");
  });

  it("plays the MP4 and maps its time onto the clip window; a row's time seeks", async () => {
    const a = line(105);
    const b = line(110);
    const c = client({}, { items: [a, b] });
    const { container } = wrap(<ClipWatchPage channel="rivertide" clipId={CLIP_ID} viewer={null} client={c} />);
    await waitFor(() => expect(byId(container, "clip-watch-page")).not.toBeNull());
    expect(byId(container, "clip-watch-page")?.getAttribute("data-clip-id")).toBe(CLIP_ID);
    await waitFor(() => expect(c.clipChat).toHaveBeenCalled());
    const video = container.querySelector("video");
    if (!video) throw new Error("no video");
    expect(video.getAttribute("src")).toBe("/media/clips/c.mp4");
    let current = 0;
    Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
    Object.defineProperty(video, "duration", { configurable: true, get: () => 30 });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => current,
      set: (v: number) => {
        current = v;
      },
    });
    current = 6;
    await act(async () => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(byId(container, "vod-player")?.getAttribute("data-playhead")).toBe(iso(106));
    const rows = allById(container, "replay-row");
    expect(rows.map((r) => r.getAttribute("data-message-id"))).toEqual([a.id]);
    const time = rows[0]?.querySelector('[data-testid="replay-row-time"]') as HTMLElement;
    expect(time.textContent).toBe("0:05");
    current = 20;
    fireEvent.click(time);
    expect(current).toBe(5);
  });
});
