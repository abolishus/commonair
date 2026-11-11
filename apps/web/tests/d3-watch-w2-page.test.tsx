// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 2, d3-watch, on the watch pages: "Resume from m:ss" from Continue watching's
 * stored point (not with `?t=`), the viewer Clip button in the video's player bar (not on a
 * clip), and the clip page's "Watch from this moment" when the API links the clip to its video.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReplayPage } from "../src/chat/replay/model.ts";
import type { ClipDto, VodDto } from "../src/components/vod-watch/state.ts";
import { ClipWatchPage, VodWatchPage, type WatchClient } from "../src/components/vod-watch/watch-page.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { RESUME_KEY, saveResumePoint } from "../src/lib/resume.ts";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | number>;
    children?: React.ReactNode;
  }) => {
    const path = to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "");
    const entries = Object.entries(search ?? {}).map(([k, v]) => [k, String(v)]);
    const query = entries.length > 0 ? `?${new URLSearchParams(entries)}` : "";
    return (
      <a href={`${path}${query}`} {...rest}>
        {children}
      </a>
    );
  },
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

vi.mock("../src/lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api.ts")>()),
  api: () => ({ me: { blocks: { ids: async () => ({ userIds: [] }) } } }),
}));

beforeEach(() => window.localStorage.removeItem(RESUME_KEY));
afterEach(cleanup);

const VOD_ID = "01900000-0000-7000-8000-0000000000d1";
const CLIP_ID = "01900000-0000-7000-8000-0000000000c1";

const vod = (over: Partial<VodDto> = {}): VodDto => ({
  id: VOD_ID,
  channelSlug: "rivertide",
  title: "Tuesday build stream",
  status: "ready",
  visibility: "public",
  durationSeconds: 1800,
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
  title: "The jump",
  creator: null,
  status: "ready",
  durationSeconds: 30,
  url: "/media/clips/c.mp4",
  thumbnailUrl: null,
  views: 3,
  createdAt: "2026-11-01T12:00:00.000Z",
  windowStartedAt: "2026-11-01T12:10:00.000Z",
  vodId: null,
  vodOffsetSeconds: null,
  category: null,
  ...over,
});

const empty: ReplayPage = { items: [], nextCursor: null, retained: true };
const client = (over: Partial<WatchClient> = {}): WatchClient => ({
  vod: async () => vod(),
  clip: async () => clip(),
  channel: async () => ({ displayName: "Rivertide", avatarUrl: null, accent: null }),
  vodChat: async () => empty,
  clipChat: async () => empty,
  channelVods: async () => ({ items: [], nextCursor: null }),
  channelClips: async () => ({ items: [], nextCursor: null }),
  ...over,
});

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

const storePoint = (positionSeconds: number) =>
  saveResumePoint({
    vodId: VOD_ID,
    channelSlug: "rivertide",
    title: "Tuesday build stream",
    thumbnailUrl: null,
    positionSeconds,
    durationSeconds: 1800,
    updatedAt: "2026-11-09T12:00:00.000Z",
  });

describe("the video page", () => {
  it("offers Resume from the stored position; Dismiss hides it", async () => {
    storePoint(724);
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId("watch-resume")).not.toBeNull());
    expect(byId("watch-resume")?.getAttribute("data-at")).toBe("724");
    expect(byId("watch-resume-action")?.textContent).toBe(t("d3Watch.resume.action", { time: "12:04" }));
    fireEvent.click(byId("watch-resume-dismiss") as HTMLElement);
    await waitFor(() => expect(byId("watch-resume")).toBeNull());
  });

  it("Resume goes away once pressed", async () => {
    storePoint(724);
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId("watch-resume-action")).not.toBeNull());
    fireEvent.click(byId("watch-resume-action") as HTMLElement);
    await waitFor(() => expect(byId("watch-resume")).toBeNull());
  });

  it("a link with ?t= starts there: no offer", async () => {
    storePoint(724);
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} startAt={90} />);
    await waitFor(() => expect(byId("vod-player")).not.toBeNull());
    expect(byId("watch-resume")).toBeNull();
  });

  it("nothing stored: no offer", async () => {
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId("vod-player")).not.toBeNull());
    expect(byId("watch-resume")).toBeNull();
  });

  it("has the viewer's Clip button in the player bar", async () => {
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={{ username: "fan" }} client={client()} />);
    await waitFor(() => expect(byId("vod-player")).not.toBeNull());
    const bar = byId("player-controls") as HTMLElement;
    expect(bar.querySelector('[data-testid="clip-button"]')?.getAttribute("data-signed-in")).toBe("true");
  });

  it("signed out, the Clip button is a sign-in link", async () => {
    wrap(<VodWatchPage channel="rivertide" vodId={VOD_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId("clip-button")).not.toBeNull());
    expect(byId("clip-button")?.getAttribute("href")).toContain("intent=clip");
  });
});

describe("the clip page", () => {
  it("has no Clip button, and Watch from this moment when the clip's video is watchable", async () => {
    wrap(
      <ClipWatchPage
        channel="rivertide"
        clipId={CLIP_ID}
        viewer={null}
        client={client({ clip: async () => clip({ vodId: VOD_ID, vodOffsetSeconds: 600.4 }) })}
      />,
    );
    await waitFor(() => expect(byId("watch-from-moment")).not.toBeNull());
    expect(byId("watch-from-moment")?.getAttribute("href")).toBe(`/rivertide/vods/${VOD_ID}?t=600`);
    expect(byId("clip-button")).toBeNull();
  });

  it("without a watchable video, no Watch from this moment", async () => {
    wrap(<ClipWatchPage channel="rivertide" clipId={CLIP_ID} viewer={null} client={client()} />);
    await waitFor(() => expect(byId("clip-watch-page")).not.toBeNull());
    expect(byId("watch-from-moment")).toBeNull();
    expect(byId("watch-actions")).toBeNull();
  });
});
