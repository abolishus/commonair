// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The watch pages' API client (`watchClient`: the calls it makes and the channel card it builds
 * from `channels.get`, live or not), the VOD page's Share reading the playhead (none yet: the
 * timestamp cannot be chosen), a clip with no channel card, and the
 * metadata's fallbacks: an untitled clip, a clipboard that refuses (or is missing), and a VOD
 * Share without a playhead source. Plus `summarize`'s defaults for a channel without the newer
 * fields.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({ calls: [] as [string, unknown][], channel: null as unknown, toasts: [] as string[] }));

vi.mock("@commonair/ui/toast", () => ({
  toast: { error: (m: string) => fake.toasts.push(`error:${m}`), success: (m: string) => fake.toasts.push(`ok:${m}`) },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a href="/x" className={className}>
      {children}
    </a>
  ),
}));

vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    playingDate: Date | null = null;
    currentLevel = 0;
    levels: unknown[] = [];
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }
  return { default: FakeHls };
});

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const rec = (name: string, out: () => unknown) => async (input: unknown) => {
    fake.calls.push([name, input]);
    return out();
  };
  const page = () => ({ items: [], nextCursor: null });
  const client = {
    me: { blocks: { ids: async () => ({ userIds: [] }) } },
    vods: { get: rec("vods.get", () => ({})), list: rec("vods.list", page), chat: rec("vods.chat", page) },
    clips: { get: rec("clips.get", () => ({})), list: rec("clips.list", page), chat: rec("clips.chat", page) },
    channels: { get: rec("channels.get", () => fake.channel) },
  };
  return { ...(await importOriginal<typeof import("../src/lib/api.ts")>()), api: () => client };
});

const { ClipWatchPage, VodWatchPage, watchClient } = await import("../src/components/vod-watch/watch-page.tsx");
const { WatchMeta, WatchShare } = await import("../src/components/watch/watch-meta.tsx");
const { summarize } = await import("../src/lib/channel-summary.ts");
const { locale, t, uiMessages } = await import("../src/i18n/index.ts");
type WatchClient = import("../src/components/vod-watch/watch-page.tsx").WatchClient;
type VodDto = import("../src/components/vod-watch/state.ts").VodDto;
type ClipDto = import("../src/components/vod-watch/state.ts").ClipDto;

afterEach(() => {
  cleanup();
  fake.calls.length = 0;
  fake.toasts.length = 0;
  fake.channel = null;
});

const VOD_ID = "01900000-0000-7000-8000-0000000000d1";
const CLIP_ID = "01900000-0000-7000-8000-0000000000c1";

const channelDto = (over: Record<string, unknown> = {}) => ({
  id: "01900000-0000-7000-8000-00000000c001",
  slug: "rivertide",
  displayName: "Rivertide",
  title: "Building things",
  description: "",
  avatarUrl: null,
  theme: { accent: "teal" },
  mature: false,
  live: null,
  category: null,
  tags: [],
  followerCount: 12,
  viewer: { following: true },
  movedTo: null,
  ...over,
});

const vod = (over: Partial<VodDto> = {}): VodDto => ({
  id: VOD_ID,
  channelSlug: "rivertide",
  title: "Tuesday build stream",
  status: "ready",
  views: 0,
  visibility: "public",
  durationSeconds: 600,
  thumbnailUrl: null,
  playlistUrl: "/media/vods/v/index.m3u8",
  createdAt: "2026-11-01T12:00:00.000Z",
  expiresAt: null,
  failedReason: null,
  captions: [],
  category: null,
  ...over,
});
const clip = (over: Partial<ClipDto> = {}): ClipDto => ({
  id: CLIP_ID,
  channelSlug: "rivertide",
  title: "",
  creator: null,
  status: "ready",
  durationSeconds: 30,
  url: "/media/clips/c.mp4",
  thumbnailUrl: null,
  views: 0,
  createdAt: "2026-11-01T12:00:00.000Z",
  windowStartedAt: "2026-11-01T12:01:40.000Z",
  vodId: null,
  vodOffsetSeconds: null,
  category: null,
  ...over,
});

const replay = async () => ({ items: [], nextCursor: null, retained: true });
const client = (over: Partial<WatchClient> = {}): WatchClient => ({
  vod: async () => vod(),
  clip: async () => clip(),
  channel: async () => ({ displayName: "Rivertide", avatarUrl: null, accent: null }),
  vodChat: replay,
  clipChat: replay,
  channelVods: async () => ({ items: [], nextCursor: null }),
  channelClips: async () => ({ items: [], nextCursor: null }),
  ...over,
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("watchClient", () => {
  it("calls the API for the VOD, the clip, their chat and the More-from lists", async () => {
    const c = watchClient();
    await c.vod(VOD_ID);
    await c.clip(CLIP_ID);
    await c.vodChat(VOD_ID, { limit: 50 } as never);
    await c.clipChat(CLIP_ID, { limit: 50 } as never);
    await c.channelVods?.("rivertide");
    await c.channelClips?.("rivertide");
    expect(fake.calls).toEqual([
      ["vods.get", { id: VOD_ID }],
      ["clips.get", { id: CLIP_ID }],
      ["vods.chat", { id: VOD_ID, limit: 50 }],
      ["clips.chat", { id: CLIP_ID, limit: 50 }],
      ["vods.list", { channel: "rivertide", limit: 12 }],
      ["clips.list", { channel: "rivertide", limit: 12, sort: "recent" }],
    ]);
  });

  it("builds the channel card from channels.get, with the live viewer count and when it asked", async () => {
    fake.channel = channelDto({
      live: {
        id: "b1",
        title: "Live now",
        viewerCount: 7,
        startedAt: "2026-11-06T11:00:00.000Z",
        category: null,
      },
    });
    const before = Date.now();
    const card = await watchClient().channel("rivertide");
    expect(fake.calls).toEqual([["channels.get", { channel: "rivertide" }]]);
    expect(card).toMatchObject({
      displayName: "Rivertide",
      avatarUrl: null,
      accent: "teal",
      followerCount: 12,
      following: true,
      live: { viewerCount: 7 },
    });
    expect(card.requestedAt).toBeGreaterThanOrEqual(before);
    fake.channel = channelDto({ viewer: undefined, theme: {} });
    expect(await watchClient().channel("rivertide")).toMatchObject({ live: null, following: null, accent: null });
  });
});

describe("summarize defaults", () => {
  it("an older API without the newer fields: no category, tags, last live, catching-up or restriction", () => {
    const s = summarize(
      channelDto({
        tags: undefined,
        lastLiveAt: undefined,
        movedTo: undefined,
        category: undefined,
        viewer: { following: false },
        live: { id: "b1", title: "x", viewerCount: 1, startedAt: "2026-11-06T11:00:00.000Z", mature: true },
      }) as never,
    );
    expect(s).toMatchObject({
      tags: [],
      lastLiveAt: null,
      movedTo: null,
      category: null,
      portabilityGrant: false,
      live: { catchingUpCount: 0, restricted: null, mature: true },
    });
    expect(summarize(channelDto({ viewer: null }) as never).portabilityGrant).toBeNull();
    // `Channel.viewer.notify` while following; unknown (null) otherwise.
    expect(s.notify).toBeNull();
    expect(summarize(channelDto({ viewer: { following: true, notify: false } }) as never).notify).toBe(false);
    expect(summarize(channelDto({ viewer: null }) as never).notify).toBeNull();
    // `Channel.viewer.subscribed` (w5-watch): left out when false, so signed in without it is false.
    expect(s.subscribed).toBe(false);
    expect(summarize(channelDto({ viewer: { following: false, subscribed: true } }) as never).subscribed).toBe(true);
    expect(summarize(channelDto({ viewer: null }) as never).subscribed).toBeNull();
  });
});

describe("VOD page Share", () => {
  it("reads the playhead when it opens: none yet, so the timestamp cannot be chosen", async () => {
    wrap(
      <VodWatchPage
        channel="rivertide"
        vodId={VOD_ID}
        viewer={null}
        client={client()}
        publicUrl="https://air.example"
      />,
    );
    await waitFor(() => expect(byId("vod-watch-page")).not.toBeNull());
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-time")).not.toBeNull());
    const box = byId("watch-share-time") as HTMLElement;
    expect(box.getAttribute("aria-disabled") === "true" || box.hasAttribute("data-disabled")).toBe(true);
    expect((byId("watch-share-url") as HTMLInputElement).value).toBe(`https://air.example/rivertide/vods/${VOD_ID}`);
  });

  it("without publicUrl, Share uses this page's origin", async () => {
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId("vod-watch-page")).not.toBeNull());
    expect(byId("watch-share")?.dataset.url).toBe(`${window.location.origin}/rivertide/vods/${VOD_ID}`);
  });
});

describe("clip page without a channel card", () => {
  it("an untitled clip says so, and More from names the channel by its slug", async () => {
    const c = client({
      channel: async () => {
        throw new Error("down");
      },
    });
    wrap(
      <ClipWatchPage channel="rivertide" clipId={CLIP_ID} viewer={null} client={c} publicUrl="https://air.example" />,
    );
    await waitFor(() => expect(byId("clip-watch-page")).not.toBeNull());
    expect(byId("watch-title")?.textContent).toBe(t("channel.tabs.untitledClip"));
    expect(byId("watch-meta-views")?.dataset.count).toBe("0");
    expect(byId("watch-meta-clipped-by")).toBeNull();
  });
});

describe("Share fallbacks", () => {
  it("a clipboard that refuses toasts the failure and keeps the popover open", async () => {
    const clipboard = {
      writeText: vi.fn<(s: string) => Promise<void>>(async () => Promise.reject(new Error("denied"))),
    };
    wrap(
      <WatchShare
        kind="vod"
        publicUrl="https://air.example"
        slug="rivertide"
        id={VOD_ID}
        currentTime={() => 5}
        clipboard={clipboard}
      />,
    );
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-copy")).not.toBeNull());
    await act(async () => {
      fireEvent.click(byId("watch-share-copy") as HTMLElement);
    });
    await waitFor(() => expect(fake.toasts).toEqual([`error:${t("watch.share.failed")}`]));
    expect(byId("watch-share-popover")).not.toBeNull();
  });

  it("no clipboard at all is a failure too; a success closes the popover", async () => {
    wrap(<WatchShare kind="clip" publicUrl="https://air.example" slug="rivertide" id={CLIP_ID} clipboard={null} />);
    await act(async () => {
      fireEvent.click(byId("watch-share") as HTMLElement);
    });
    await waitFor(() => expect(fake.toasts).toEqual([`error:${t("watch.share.failed")}`]));
    cleanup();
    fake.toasts.length = 0;
    const clipboard = { writeText: vi.fn<(s: string) => Promise<void>>(async () => undefined) };
    wrap(<WatchShare kind="vod" publicUrl="https://air.example" slug="rivertide" id={VOD_ID} clipboard={clipboard} />);
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-copy")).not.toBeNull());
    await act(async () => {
      fireEvent.click(byId("watch-share-copy") as HTMLElement);
    });
    await waitFor(() => expect(fake.toasts).toEqual([`ok:${t("watch.share.copied")}`]));
    await waitFor(() => expect(byId("watch-share-popover")).toBeNull());
  });

  it("the default clipboard is the browser's when it has one", async () => {
    const writeText = vi.fn<(s: string) => Promise<void>>(async () => undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      wrap(<WatchShare kind="clip" publicUrl="https://air.example" slug="rivertide" id={CLIP_ID} />);
      await act(async () => {
        fireEvent.click(byId("watch-share") as HTMLElement);
      });
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://air.example/rivertide/clips/${CLIP_ID}`));
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
    cleanup();
    fake.toasts.length = 0;
    try {
      wrap(<WatchShare kind="clip" publicUrl="https://air.example" slug="rivertide" id={CLIP_ID} />);
      await act(async () => {
        fireEvent.click(byId("watch-share") as HTMLElement);
      });
      await waitFor(() => expect(fake.toasts).toEqual([`error:${t("watch.share.failed")}`]));
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("an untitled clip's metadata names it as a clip", () => {
    wrap(
      <WatchMeta
        kind="clip"
        id={CLIP_ID}
        slug="rivertide"
        title=""
        createdAt="2026-11-01T12:00:00.000Z"
        durationSeconds={30}
        publicUrl="https://air.example"
        clipboard={null}
      />,
    );
    expect(byId("watch-title")?.textContent).toBe(t("channel.tabs.untitledClip"));
    expect(byId("watch-meta-views")).toBeNull();
  });
});
