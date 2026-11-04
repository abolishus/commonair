// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D3-watch (F11): the channel card under a VOD or clip (`watch-channel-card`). Offline: the avatar,
 * the name, the follower count and Follow. Live: `<LiveBadge>`, the verified count ("Just started"
 * below the threshold) and "Watch live". The live state is polled on the channel page's interval.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  useWatchChannel,
  WatchChannelCard,
  type ChannelCard,
  type ChannelCardState,
} from "../src/components/watch/watch-channel-card.tsx";
import { VodWatchPage, type WatchClient } from "../src/components/vod-watch/watch-page.tsx";
import type { VodDto } from "../src/components/vod-watch/state.ts";
import { t, locale, uiMessages } from "../src/i18n/index.ts";
import { CHANNEL_POLL_MS } from "../src/lib/use-channel.ts";

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
  }) => (
    <a href={to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    levels: unknown[] = [];
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }
  return { default: FakeHls };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);

const card = (over: Partial<ChannelCard> = {}): ChannelCard => ({
  displayName: "Rivertide",
  avatarUrl: null,
  accent: null,
  followerCount: 1204,
  following: false,
  live: null,
  requestedAt: 1,
  ...over,
});

describe("WatchChannelCard", () => {
  it("offline: avatar, name, follower count, Follow; no live badge and no Watch live", () => {
    const { container } = wrap(<WatchChannelCard slug="rivertide" card={card()} signedIn />);
    const root = byId(container, "watch-channel-card") as HTMLElement;
    expect(root.getAttribute("data-live")).toBe("false");
    expect(root.getAttribute("aria-label")).toBe(t("watch.card.label", { name: "Rivertide" }));
    expect(byId(root, "watch-channel-link")?.getAttribute("href")).toBe("/rivertide");
    expect(byId(root, "watch-channel-link")?.textContent).toContain("Rivertide");
    expect(byId(root, "follower-count")?.getAttribute("data-count")).toBe("1204");
    expect(byId(root, "follow-button")?.getAttribute("data-following")).toBe("false");
    expect(root.querySelector('[data-slot="live-badge"]')).toBeNull();
    expect(byId(root, "watch-live")).toBeNull();
  });

  it("live: LiveBadge, the verified count and Watch live to the channel", () => {
    const { container } = wrap(
      <WatchChannelCard slug="rivertide" card={card({ live: { viewerCount: 42 } })} signedIn={false} />,
    );
    const root = byId(container, "watch-channel-card") as HTMLElement;
    expect(root.getAttribute("data-live")).toBe("true");
    expect(root.querySelector('[data-slot="live-badge"]')).not.toBeNull();
    expect(root.querySelector('[data-slot="viewer-count"]')?.textContent).toContain("42");
    expect(byId(root, "channel-just-started")).toBeNull();
    const watch = byId(root, "watch-live");
    expect(watch?.textContent).toContain(t("watch.card.watchLive"));
    expect(watch?.getAttribute("href")).toBe("/rivertide");
    // Signed out, Follow goes to sign-in.
    expect(byId(root, "follow-button")?.getAttribute("href")).toBe("/signin");
  });

  it("live with a low verified count: Just started instead of the number", () => {
    const { container } = wrap(
      <WatchChannelCard slug="rivertide" card={card({ live: { viewerCount: 1 } })} signedIn />,
    );
    expect(byId(container, "channel-just-started")).not.toBeNull();
    expect(container.querySelector('[data-slot="viewer-count"]')).toBeNull();
    expect(byId(container, "watch-live")).not.toBeNull();
  });

  it("not loaded yet: the slug stands in and nothing is invented", () => {
    const { container } = wrap(<WatchChannelCard slug="rivertide" card={null} signedIn />);
    expect(byId(container, "watch-channel-link")?.textContent).toContain("rivertide");
    expect(byId(container, "follower-count")).toBeNull();
    expect(byId(container, "follow-button")).toBeNull();
    expect(byId(container, "watch-live")).toBeNull();
  });

  it("a channel that never reported a follower count shows none", () => {
    const { container } = wrap(
      <WatchChannelCard slug="rivertide" card={{ displayName: "Rivertide", avatarUrl: null, accent: null }} signedIn />,
    );
    expect(byId(container, "follower-count")).toBeNull();
    expect(byId(container, "follow-button")).not.toBeNull();
  });
});

function Probe({ get, onState }: { get: (s: string) => Promise<ChannelCard>; onState: (s: ChannelCardState) => void }) {
  onState(useWatchChannel("rivertide", get));
  return null;
}

describe("useWatchChannel", () => {
  it("polls on the channel page's interval, no faster, and goes live without a reload", async () => {
    vi.useFakeTimers();
    let live = false;
    const get = vi.fn<(s: string) => Promise<ChannelCard>>(async () =>
      card({ live: live ? { viewerCount: 9 } : null }),
    );
    const states: ChannelCardState[] = [];
    wrap(<Probe get={get} onState={(s) => states.push(s)} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(get).toHaveBeenCalledTimes(1);
    live = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANNEL_POLL_MS - 1);
    });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(get).toHaveBeenCalledTimes(2);
    const last = states.at(-1);
    expect(last?.status === "ok" && last.card.live?.viewerCount).toBe(9);
  });

  it("a failed poll keeps the card; a missing channel stops polling", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const get = vi.fn<(s: string) => Promise<ChannelCard>>(async () => {
      calls++;
      if (calls === 2) throw new Error("network");
      if (calls === 3) throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
      return card();
    });
    const states: ChannelCardState[] = [];
    wrap(<Probe get={get} onState={(s) => states.push(s)} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANNEL_POLL_MS);
    });
    expect(states.at(-1)?.status).toBe("ok");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANNEL_POLL_MS);
    });
    expect(states.at(-1)?.status).toBe("missing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANNEL_POLL_MS * 3);
    });
    expect(get).toHaveBeenCalledTimes(3);
  });
});

const VOD_ID = "01900000-0000-7000-8000-0000000000d1";
const vod: VodDto = {
  id: VOD_ID,
  channelSlug: "rivertide",
  title: "Tuesday build stream",
  status: "ready",
  visibility: "public",
  durationSeconds: 600,
  thumbnailUrl: null,
  playlistUrl: "/media/vods/v/index.m3u8",
  createdAt: "2026-11-01T12:00:00.000Z",
  expiresAt: null,
  failedReason: null,
  captions: [],
};

const client = (live: boolean): WatchClient => ({
  vod: async () => vod,
  clip: async () => {
    throw new Error("unused");
  },
  channel: async () => card({ live: live ? { viewerCount: 42 } : null }),
  vodChat: async () => ({ items: [], nextCursor: null, retained: true }),
  clipChat: async () => ({ items: [], nextCursor: null, retained: true }),
  channelVods: async () => ({ items: [], nextCursor: null }),
  channelClips: async () => ({ items: [], nextCursor: null }),
});

describe("on the VOD page", () => {
  it("the card sits under the metadata, with Watch live while the channel is live", async () => {
    const { container } = wrap(
      <VodWatchPage
        channel="rivertide"
        vodId={VOD_ID}
        viewer={null}
        client={client(true)}
        publicUrl="https://a.example"
      />,
    );
    await waitFor(() => expect(byId(container, "watch-live")).not.toBeNull());
    expect(byId(container, "watch-meta")).not.toBeNull();
    const order = [...container.querySelectorAll('[data-testid="watch-meta"], [data-testid="watch-channel-card"]')];
    expect(order.map((el) => el.getAttribute("data-testid"))).toEqual(["watch-meta", "watch-channel-card"]);
  });

  it("offline: no Watch live", async () => {
    const { container } = wrap(
      <VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client(false)} />,
    );
    await waitFor(() => expect(byId(container, "follow-button")).not.toBeNull());
    expect(byId(container, "watch-live")).toBeNull();
    expect(byId(container, "watch-channel-card")?.getAttribute("data-live")).toBe("false");
  });
});
