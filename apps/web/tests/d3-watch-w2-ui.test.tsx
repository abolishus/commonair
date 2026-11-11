// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 2, d3-watch, rendered: the viewer Clip button and its dialog (D3.7), the offline
 * channel's content page and the panels' markdown (D3.8), Share's share sheet, "Watch from this
 * moment", the embed's identity and the giveaway page's way back (D3.9), and Continue watching's
 * writer hook (D3.6).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChannelAboutSection } from "../src/components/channel/about.tsx";
import { OfflineChannelHome } from "../src/components/channel/offline-hero.tsx";
import { PANEL_LINK_REL, PanelMarkdown } from "../src/components/channel/panels.tsx";
import type { VideoTile } from "../src/components/channel/video-grid.tsx";
import { useResumeWriter } from "../src/components/vod-watch/resume-writer.ts";
import type { PlayerProgress } from "../src/components/vod-watch/vod-player.tsx";
import { WatchFromMoment } from "../src/components/vod-watch/watch-page.tsx";
import { ClipButton, type ClipCreate } from "../src/components/watch/clip-button.tsx";
import { EmbedIdentity, EmbedOffline, EmbedWatchOn } from "../src/components/watch/embed-identity.tsx";
import { GiveawayChannelFrame } from "../src/components/watch/giveaway-channel.tsx";
import { WatchShare } from "../src/components/watch/watch-meta.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { readResumePoints, RESUME_KEY } from "../src/lib/resume.ts";

const metrics = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (...args: unknown[]) => {
    metrics.calls.push(args);
  },
}));

const toasts = vi.hoisted(() => ({
  success: [] as { message: unknown; options?: { action?: { onClick: () => void } } }[],
  error: [] as unknown[],
}));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (message: unknown, options?: { action?: { onClick: () => void } }) => {
      toasts.success.push({ message, options });
      return 1;
    },
    error: (message: unknown) => {
      toasts.error.push(message);
      return 2;
    },
  },
}));

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

beforeEach(() => {
  metrics.calls.length = 0;
  toasts.success.length = 0;
  toasts.error.length = 0;
});
afterEach(cleanup);

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const CLIP_ID = "01900000-0000-7000-8000-0000000000c9";
const VOD_ID = "01900000-0000-7000-8000-0000000000d9";

describe("ClipButton", () => {
  it("signed out: opens the sign-up prompt with the clip intent, counted", async () => {
    wrap(<ClipButton target={{ kind: "live", channel: "rivertide" }} signedIn={false} />);
    const button = byId("clip-button") as HTMLButtonElement;
    expect([button.tagName, button.getAttribute("data-auth-gate")]).toEqual(["BUTTON", "clip"]);
    expect(button.getAttribute("aria-label")).toBe(t("d3Watch.clip.label"));
    act(() => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(byId("auth-gate")?.getAttribute("data-intent")).toBe("clip"));
    const create = new URL(byId("auth-gate-create")?.getAttribute("href") ?? "", "https://x.invalid");
    expect([create.pathname, create.searchParams.get("intent")]).toEqual(["/signup", "clip"]);
    expect(metrics.calls).toContainEqual(["clip.viewer", "signin", "clip"]);
    expect(metrics.calls).toContainEqual(["authGate", "view", "clip"]);
  });

  it("live: the last 30 seconds, a title, then a toast with the clip's link", async () => {
    const create = vi.fn<ClipCreate>(async () => ({ id: CLIP_ID, channelSlug: "rivertide" }));
    const copy = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const opened: boolean[] = [];
    wrap(
      <ClipButton
        target={{ kind: "live", channel: "rivertide" }}
        signedIn
        publicUrl="https://air.example/"
        create={create}
        copy={copy}
        onOpenChange={(o) => opened.push(o)}
      />,
    );
    fireEvent.click(byId("clip-button") as HTMLElement);
    await waitFor(() => expect(byId("clip-dialog")).not.toBeNull());
    expect(byId("clip-dialog")?.getAttribute("data-kind")).toBe("live");
    expect(byId("clip-dialog-range")?.textContent).toBe(t("d3Watch.clip.whatLive", { seconds: 30 }));
    const submit = byId("clip-dialog-create") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(byId("clip-dialog-title") as HTMLInputElement, { target: { value: "  The jump  " } });
    expect(submit.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(create).toHaveBeenCalledWith({ channel: "rivertide", title: "The jump", durationSeconds: 30 });
    await waitFor(() => expect(byId("clip-dialog")).toBeNull());
    expect(toasts.success[0]?.message).toBe(t("d3Watch.clip.created"));
    toasts.success[0]?.options?.action?.onClick();
    await waitFor(() => expect(copy).toHaveBeenCalledWith(`https://air.example/rivertide/clips/${CLIP_ID}`));
    expect(opened).toEqual([true, false]);
    expect(metrics.calls).toEqual([
      ["clip.viewer", "click"],
      ["clip.viewer", "create"],
    ]);
  });

  it("video: the 30 seconds that end at the playhead, starting from the video's title", async () => {
    const create = vi.fn<ClipCreate>(async () => ({ id: CLIP_ID, channelSlug: "rivertide" }));
    wrap(
      <ClipButton
        target={{ kind: "vod", channel: "rivertide", vodId: VOD_ID, durationSeconds: 1800, position: () => 754.4 }}
        signedIn
        defaultTitle="Tuesday build stream"
        create={create}
      />,
    );
    fireEvent.click(byId("clip-button") as HTMLElement);
    await waitFor(() => expect(byId("clip-dialog")).not.toBeNull());
    expect(byId("clip-dialog-range")?.textContent).toBe(t("d3Watch.clip.whatVideo", { from: "12:04", to: "12:34" }));
    expect((byId("clip-dialog-title") as HTMLInputElement).value).toBe("Tuesday build stream");
    await act(async () => {
      fireEvent.submit((byId("clip-dialog-title") as HTMLInputElement).form as HTMLFormElement);
    });
    expect(create).toHaveBeenCalledWith({
      channel: "rivertide",
      title: "Tuesday build stream",
      vodId: VOD_ID,
      startOffset: 724,
      durationSeconds: 30,
    });
  });

  it("a refusal stays in the dialog with what to do, and is counted", async () => {
    const create = vi.fn<ClipCreate>(async () => {
      throw Object.assign(new Error("slow down"), { code: "RATE_LIMITED", data: { retryAfterSeconds: 5 } });
    });
    wrap(<ClipButton target={{ kind: "live", channel: "rivertide" }} signedIn create={create} />);
    fireEvent.click(byId("clip-button") as HTMLElement);
    await waitFor(() => expect(byId("clip-dialog")).not.toBeNull());
    fireEvent.change(byId("clip-dialog-title") as HTMLInputElement, { target: { value: "x" } });
    await act(async () => {
      fireEvent.click(byId("clip-dialog-create") as HTMLElement);
    });
    await waitFor(() => expect(byId("clip-dialog-error")?.textContent).toBe(t("d3Watch.clip.error.rateLimited")));
    expect(byId("clip-dialog")).not.toBeNull();
    expect(toasts.success).toEqual([]);
    expect(metrics.calls).toContainEqual(["clip.viewer", "error", "rate_limited"]);
  });

  it("a video too short to clip says so and cannot be sent", async () => {
    const create = vi.fn<ClipCreate>();
    wrap(
      <ClipButton
        target={{ kind: "vod", channel: "rivertide", vodId: VOD_ID, durationSeconds: 3, position: () => 1 }}
        signedIn
        defaultTitle="Short"
        create={create}
      />,
    );
    fireEvent.click(byId("clip-button") as HTMLElement);
    await waitFor(() => expect(byId("clip-dialog")).not.toBeNull());
    expect(byId("clip-dialog-range")?.textContent).toBe(t("d3Watch.clip.tooShort"));
    expect((byId("clip-dialog-create") as HTMLButtonElement).disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("PanelMarkdown", () => {
  it("renders the subset as elements, never HTML, and links as the streamer's", () => {
    const { container } = wrap(
      <PanelMarkdown
        body={
          "I play **grand strategy**.\n\n- Monday: *deep dives*\n- [Shop](https://shop.example.org)\n\n<img src=x onerror=alert(1)>"
        }
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("grand strategy");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelector("em")?.textContent).toBe("deep dives");
    const a = container.querySelector("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://shop.example.org");
    expect(a.getAttribute("rel")).toBe(PANEL_LINK_REL);
    expect(a.getAttribute("rel")).toContain("nofollow");
    expect(a.getAttribute("rel")).toContain("ugc");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

const tile = (n: number, kind: "vods" | "clips" = "vods"): VideoTile => ({
  id: `${kind}-${n}`,
  kind,
  channelSlug: "rivertide",
  title: `${kind} ${n}`,
  thumbnailUrl: null,
  durationSeconds: 8048,
  createdAt: "2026-11-09T12:00:00.000Z",
  views: kind === "clips" ? n : null,
  clippedBy: null,
});
const channel = { slug: "rivertide", displayName: "Rivertide", accent: null, avatarUrl: null };

describe("OfflineChannelHome", () => {
  it("last live: the latest video beside Follow, then clips, the other videos, About, and Live now last", () => {
    const { container } = wrap(
      <OfflineChannelHome
        channel={channel}
        lastLiveAt="2026-11-09T12:00:00.000Z"
        videos={[tile(1), tile(2), tile(3)]}
        clips={[tile(1, "clips")]}
        follow={
          <button data-testid="follow" data-filled-cta type="button">
            Follow
          </button>
        }
        own={false}
        about={<div data-testid="about" />}
        liveNow={<div data-testid="live-now" />}
      />,
    );
    const hero = byId("channel-offline-follow-hero") as HTMLElement;
    expect(hero.getAttribute("data-state")).toBe("lastLive");
    expect(hero.querySelector('[data-testid="channel-offline-hero"]')?.getAttribute("href")).toBe(
      "/rivertide/vods/vods-1",
    );
    expect(byId("channel-offline-heading")?.textContent).toContain(t("channel.offline.lastLive"));
    expect(hero.textContent).toContain(t("d3Watch.offline.followBody"));
    expect(hero.querySelector('[data-testid="follow"]')).not.toBeNull();
    expect(byId("channel-offline-latest-meta")?.textContent).toContain("2:14:08");
    const shelves = [...container.querySelectorAll('[data-testid="channel-shelf"]')];
    expect(shelves.map((s) => s.getAttribute("data-kind"))).toEqual(["clips", "vods"]);
    // The hero's video is not repeated in the shelf.
    expect(shelves[1]?.querySelectorAll('[data-testid="channel-video-card"]')).toHaveLength(2);
    const home = byId("channel-offline-home") as HTMLElement;
    expect(home.lastElementChild?.getAttribute("data-testid")).toBe("live-now");
    expect(byId("about")).not.toBeNull();
    expect(byId("channel-offline-calendar")).toBeNull();
  });

  it("never streamed, nothing recorded: the channel's art, an honest heading, no empty shelves", () => {
    const { container } = wrap(
      <OfflineChannelHome
        channel={channel}
        lastLiveAt={null}
        videos={[]}
        clips={[]}
        follow={
          <button data-testid="follow" type="button">
            Follow
          </button>
        }
        own={false}
        about={null}
        liveNow={null}
      />,
    );
    expect(byId("channel-offline-follow-hero")?.getAttribute("data-state")).toBe("never");
    expect(byId("channel-offline-heading")?.textContent).toBe(t("d3Watch.offline.never", { name: "Rivertide" }));
    expect(container.textContent).toContain(t("d3Watch.offline.neverBody"));
    expect(container.querySelector('[data-slot="media-fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-shelf"]')).toBeNull();
  });

  it("a known next stream: when, its title, Add to calendar (the feed's next event) and the subscribable feed", async () => {
    wrap(
      <OfflineChannelHome
        channel={channel}
        lastLiveAt="2026-11-09T12:00:00.000Z"
        videos={[]}
        clips={[]}
        follow={
          <button data-testid="follow" type="button">
            Follow
          </button>
        }
        own={false}
        about={null}
        liveNow={null}
        nextStream={{ startsAt: "2026-11-12T19:00:00.000Z", title: "Campaign night" }}
        publicUrl="https://air.example"
      />,
    );
    expect(byId("channel-offline-follow-hero")?.getAttribute("data-state")).toBe("next");
    expect(byId("channel-offline-heading")?.textContent).toContain(t("d3Watch.offline.next"));
    expect(document.body.textContent).toContain("Campaign night");
    const cal = byId("channel-offline-calendar") as HTMLAnchorElement;
    expect(cal.getAttribute("href")).toBe("/api/channels/rivertide/schedule.ics?next=1");
    expect(cal.getAttribute("download")).toBe("rivertide.ics");
    const feed = byId("channel-schedule-subscribe") as HTMLAnchorElement;
    expect(feed.getAttribute("href")).toBe("webcal://air.example/api/channels/rivertide/schedule.ics");
    // The date block and the weekday and time are the viewer's, after hydration.
    await waitFor(() => expect(byId("channel-next-stream")).not.toBeNull());
    const start = new Date("2026-11-12T19:00:00.000Z");
    expect(byId("channel-next-stream")?.textContent).toContain(String(start.getDate()));
    fireEvent.click(cal);
    fireEvent.click(feed);
    expect(metrics.calls).toEqual(
      expect.arrayContaining([
        ["channel.schedule", "click", "ics"],
        ["channel.schedule", "click", "feed"],
      ]),
    );
  });

  it("the owner gets the studio instead of Follow", () => {
    wrap(
      <OfflineChannelHome
        channel={channel}
        lastLiveAt={null}
        videos={[]}
        clips={[]}
        follow={
          <button data-testid="follow" type="button">
            Follow
          </button>
        }
        own
        about={null}
        liveNow={null}
      />,
    );
    expect(byId("follow")).toBeNull();
    expect(document.querySelector('a[href="/dashboard"]')?.textContent).toBe(t("channel.tabs.streamManager"));
  });
});

describe("About", () => {
  const about = { bio: "", socials: [] };
  it("says when the channel was created, when known", () => {
    wrap(
      <ChannelAboutSection
        name="Rivertide"
        about={about}
        category={null}
        followers={null}
        panels={[]}
        since="2025-03-01T00:00:00.000Z"
      />,
    );
    const since = byId("channel-about-since") as HTMLElement;
    expect(since.textContent).toContain(t("d3Watch.about.since"));
    expect(since.querySelector("time")?.getAttribute("datetime")).toBe("2025-03-01T00:00:00.000Z");
    cleanup();
    wrap(<ChannelAboutSection name="Rivertide" about={about} category={null} followers={null} panels={[]} />);
    expect(byId("channel-about-since")).toBeNull();
  });
});

describe("Share's share sheet", () => {
  it("a clip with a share sheet opens the popover: Copy link and Share…", async () => {
    const share = vi.fn<(d: { title: string; url: string }) => Promise<void>>(async () => undefined);
    wrap(
      <WatchShare
        kind="clip"
        publicUrl="https://air.example"
        slug="rivertide"
        id={CLIP_ID}
        title="The jump"
        nativeShare={share}
        clipboard={null}
      />,
    );
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-popover")).not.toBeNull());
    expect(byId("watch-share-time")).toBeNull();
    expect(byId("watch-share-copy")).not.toBeNull();
    await act(async () => {
      fireEvent.click(byId("watch-share-native") as HTMLElement);
    });
    expect(share).toHaveBeenCalledWith({ title: "The jump", url: `https://air.example/rivertide/clips/${CLIP_ID}` });
  });

  it("closing the sheet is quiet; a failing sheet says to copy instead", async () => {
    let fail: Error = Object.assign(new Error("x"), { name: "AbortError" });
    const share = vi.fn<() => Promise<void>>(async () => {
      throw fail;
    });
    wrap(<WatchShare kind="vod" publicUrl="https://air.example" slug="rivertide" id={VOD_ID} nativeShare={share} />);
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-native")).not.toBeNull());
    await act(async () => {
      fireEvent.click(byId("watch-share-native") as HTMLElement);
    });
    expect(toasts.error).toEqual([]);
    fail = new Error("denied");
    await act(async () => {
      fireEvent.click(byId("watch-share-native") as HTMLElement);
    });
    await waitFor(() => expect(toasts.error).toEqual([t("d3Watch.share.nativeFailed")]));
  });

  it("no share sheet: no Share… button", async () => {
    wrap(<WatchShare kind="vod" publicUrl="https://air.example" slug="rivertide" id={VOD_ID} nativeShare={null} />);
    fireEvent.click(byId("watch-share") as HTMLElement);
    await waitFor(() => expect(byId("watch-share-popover")).not.toBeNull());
    expect(byId("watch-share-native")).toBeNull();
  });
});

describe("Watch from this moment", () => {
  it("links to the video at the clip's start", () => {
    wrap(<WatchFromMoment slug="rivertide" vodId={VOD_ID} offsetSeconds={754.5} />);
    const a = byId("watch-from-moment") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(`/rivertide/vods/${VOD_ID}?t=754`);
    expect(a.textContent).toBe(t("d3Watch.moment.action"));
  });

  it("a clip from the very start links to the video without ?t=", () => {
    wrap(<WatchFromMoment slug="rivertide" vodId={VOD_ID} offsetSeconds={0} />);
    expect(byId("watch-from-moment")?.getAttribute("href")).toBe(`/rivertide/vods/${VOD_ID}`);
  });
});

describe("the embed", () => {
  it("names the channel and links home in a new tab, live and offline", () => {
    wrap(
      <>
        <EmbedIdentity channel={channel} />
        <EmbedWatchOn channel={channel} site="Air Co-op" />
      </>,
    );
    expect(byId("embed-identity")?.textContent).toContain("Rivertide");
    const a = byId("embed-watch-on") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/rivertide");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(a.textContent).toBe(t("d3Watch.embed.watchOn", { site: "Air Co-op" }));
    expect(a.getAttribute("aria-label")).toBe(
      t("d3Watch.embed.watchOnLabel", { name: "Rivertide", site: "Air Co-op" }),
    );
    cleanup();
    wrap(<EmbedOffline channel={channel} site="Air Co-op" />);
    expect(byId("offline-state")?.textContent).toContain(t("channel.offline", { name: "Rivertide" }));
    expect(byId("embed-watch-on")?.getAttribute("href")).toBe("/rivertide");
  });
});

describe("the giveaway page's way back", () => {
  it("the channel card on top and Back to <channel> at the end", async () => {
    wrap(
      <GiveawayChannelFrame
        slug="rivertide"
        signedIn={false}
        load={async () => ({ displayName: "Rivertide", avatarUrl: null, accent: null, live: null })}
      >
        <div data-testid="verify" />
      </GiveawayChannelFrame>,
    );
    expect(byId("verify")).not.toBeNull();
    await waitFor(() => expect(byId("watch-channel-card")).not.toBeNull());
    const back = byId("giveaway-back-to-channel") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/rivertide");
    await waitFor(() => expect(back.textContent).toBe(t("watch.notAvailable.back", { name: "Rivertide" })));
  });

  it("a channel that does not exist: no card and no link", async () => {
    const load = vi.fn<() => Promise<never>>(async () => {
      throw Object.assign(new Error("nf"), { code: "NOT_FOUND" });
    });
    wrap(
      <GiveawayChannelFrame slug="gone" signedIn={false} load={load}>
        <div data-testid="verify" />
      </GiveawayChannelFrame>,
    );
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect(byId("giveaway-back-to-channel")).toBeNull());
    expect(byId("watch-channel-card")).toBeNull();
  });
});

describe("useResumeWriter", () => {
  const video = { vodId: "v1", channelSlug: "rivertide", title: "Build", thumbnailUrl: null, durationSeconds: 1800 };
  let report: ((p: PlayerProgress) => void) | null = null;
  function Harness({ now, on }: { now: () => number; on: boolean }) {
    const write = useResumeWriter(on ? video : null, { now });
    React.useEffect(() => {
      report = write;
    }, [write]);
    return null;
  }
  const at = () => readResumePoints()[0]?.positionSeconds ?? null;
  const p = (positionSeconds: number, paused = false): PlayerProgress => ({
    positionSeconds,
    durationSeconds: 1800,
    paused,
  });

  beforeEach(() => {
    window.localStorage.removeItem(RESUME_KEY);
    report = null;
  });

  it("throttles while playing, saves on pause, on hide and when the page goes away", () => {
    let clock = 0;
    const { unmount } = render(<Harness now={() => clock} on />);
    report?.(p(100));
    expect(at()).toBe(100);
    clock = 5_000;
    report?.(p(105));
    expect(at()).toBe(100);
    clock = 10_000;
    report?.(p(110));
    expect(at()).toBe(110);
    clock = 11_000;
    report?.(p(111, true));
    expect(at()).toBe(111);
    clock = 12_000;
    report?.(p(150));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(at()).toBe(150);
    clock = 13_000;
    report?.(p(160));
    window.dispatchEvent(new Event("pagehide"));
    expect(at()).toBe(160);
    report?.(p(170));
    unmount();
    expect(at()).toBe(170);
  });

  it("near the start writes nothing, so the point being offered survives the page loading at 0:00", () => {
    let clock = 0;
    render(<Harness now={() => clock} on />);
    report?.(p(400, true));
    clock = 20_000;
    report?.(p(0));
    report?.(p(3, true));
    expect(at()).toBe(400);
  });

  it("near the end clears the point (finished videos leave Continue watching)", () => {
    render(<Harness now={() => 0} on />);
    report?.(p(400, true));
    expect(at()).toBe(400);
    report?.(p(1790, true));
    expect(readResumePoints()).toEqual([]);
  });

  it("no playable video: nothing is written", () => {
    render(<Harness now={() => 0} on={false} />);
    report?.(p(400, true));
    expect(readResumePoints()).toEqual([]);
  });
});
