// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Home v2 (wave 2, D2.3 and D3.1) at 9, 2 and 0 channels live, signed out and in: the hero and its
 * one filled CTA, the promise strip's number, Live now's labelled backfill, Continue watching with
 * Remove, the media shelves, categories that never say "0 live", Recently live as chips, the two
 * bands, each shelf failing on its own, and the counters.
 */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, MEMBER, MUSIC, category, home, live, offline } from "./d1-fixtures.tsx";
import { clip, failed, ok, renderHome, video } from "./d3-home-fixtures.tsx";

const tracked = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => tracked.calls.push(`${surface}|${action}|${step}`),
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { HomePage } = await import("../src/components/home/home-page.tsx");
const { resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { resetResumeCache } = await import("../src/components/home/use-resume.ts");
const { RESUME_KEY, readResumePoints } = await import("../src/lib/resume.ts");
const { t } = await import("../src/i18n/index.ts");

type Props = Parameters<typeof HomePage>[0];

const COOP = { creatorShare: 0.9, earned: { cents: 429_480, currency: "USD", month: "2026-10" } };
const VIDEOS = Array.from({ length: 8 }, (_, i) => video(`v${i + 1}`));

function props(over: Partial<Props> = {}): Props {
  return {
    home: home(),
    categories: ok([category(ART, 2), category(MUSIC, 0)]),
    shelves: { videos: ok(VIDEOS), clips: ok([clip("c1"), clip("c2")]), coop: ok(COOP) },
    me: null,
    site: "Test Air",
    viewer: "anonymous",
    ...over,
  };
}

const nineLive = () =>
  home({
    spotlight: [live("s1", { viewers: 90 })],
    live: Array.from({ length: 9 }, (_, i) => live(i === 0 ? "s1" : `l${i}`, { viewers: 90 - i })),
  });
const twoLive = () => home({ spotlight: [live("s1")], live: [live("s1"), live("l1")] });

const section = (id: string) => document.querySelector(`[data-testid="directory-section"][data-section="${id}"]`);
const cardSlugs = (root: Element | null) =>
  [...(root?.querySelectorAll('[data-testid="stream-card"]') ?? [])].map((el) => el.getAttribute("data-channel"));
const videoIds = (root: Element | null) =>
  [...(root?.querySelectorAll('[data-testid="home-video"]') ?? [])].map((el) => el.getAttribute("data-vod"));
const shelf = (id: string) => document.querySelector(`[data-testid="home-shelf"][data-shelf="${id}"]`);

beforeEach(() => {
  tracked.calls = [];
  localStorage.clear();
  resetResumeCache();
});
afterEach(() => {
  cleanup();
  resetHomeFeed();
});

describe("signed out at 9 live", () => {
  it("leads with the hero: headline, one filled CTA, Browse live, the quiet creator link", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t("d3Home.hero.title"));
    const filled = document.querySelectorAll("[data-filled-cta]");
    expect(filled).toHaveLength(1);
    const cta = screen.getByTestId("home-hero-signup");
    expect(filled[0]).toBe(cta);
    expect(cta.getAttribute("href")).toBe("/signup?intent=none");
    expect(cta.textContent).toBe(t("d3Home.hero.cta"));
    expect(screen.getByTestId("home-hero-browse").getAttribute("href")).toBe("/directory");
    expect(screen.getByTestId("home-hero-stream").getAttribute("href")).toBe("/creators");
    expect(screen.getByTestId("home-hero-stream").textContent).toContain(t("d3Home.hero.stream", { site: "Test Air" }));
    expect(screen.getByText(t("d3Home.hero.eyebrow", { site: "Test Air" }))).toBeTruthy();
    expect(screen.getByText(t("d3Home.hero.body", { creatorShare: "90%" }))).toBeTruthy();
  });

  it("features one real stream at feature size (a poster, never a player) and the rest on Live now", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    const hero = screen.getByTestId("home-hero");
    expect(cardSlugs(hero)).toEqual(["s1"]);
    expect(hero.querySelector('[data-size="feature"]')).not.toBeNull();
    expect(hero.querySelector("video")).toBeNull();
    expect(cardSlugs(section("live"))).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]);
    // Enough live: no backfill, and Catch up starts at the newest video.
    expect(videoIds(section("live"))).toEqual([]);
    expect(videoIds(shelf("videos"))).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("the promise strip carries one hard number, labelled as earned by creators", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    const strip = screen.getByTestId("home-promise");
    expect(within(strip).getByRole("list", { name: t("d3Home.promise.label") })).toBeTruthy();
    const earned = within(strip).getByTestId("home-earned");
    expect(earned.textContent).toContain("$4,294.80");
    expect(earned.textContent).toContain("earned by creators in");
    expect(earned.textContent).not.toMatch(/paid/i);
    // The optional items hide below 480 px (`inline-flex-from-xs`, styles.css); the owned and share items always show.
    expect(strip.querySelector('[data-promise="fees"]')?.className).toContain("inline-flex-from-xs");
    expect(strip.querySelector('[data-promise="share"]')?.className).not.toContain("inline-flex-from-xs");
  });

  it("counts the hero, each shelf, the bands and the CTA click", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    for (const call of [
      "home.hero|view|none",
      "home.shelf|view|live",
      "home.shelf|view|videos",
      "home.shelf|view|clips",
      "home.shelf|view|categories",
      "home.coopBand|view|none",
      "home.streamBand|view|none",
    ])
      expect(tracked.calls).toContain(call);
    fireEvent.click(screen.getByTestId("home-hero-signup"));
    fireEvent.click(screen.getByTestId("home-hero-browse"));
    expect(tracked.calls).toContain("home.hero|create|none");
    expect(tracked.calls).toContain("home.hero|click|live");
    const firstLive = section("live")?.querySelector("a");
    if (firstLive) fireEvent.click(firstLive);
    expect(tracked.calls).toContain("home.shelf|click|live");
  });
});

describe("the cold start (2 live) and nobody live", () => {
  it("2 live: Live now is backfilled with videos labelled Video, with a note, and Catch up skips them", async () => {
    await renderHome(<HomePage {...props({ home: twoLive() })} />);
    const shelfEl = section("live");
    expect(cardSlugs(shelfEl)).toEqual(["l1"]);
    expect(videoIds(shelfEl)).toEqual(["v1", "v2", "v3"]);
    expect(within(shelfEl as HTMLElement).getAllByText(t("d3Home.video.kind"))).toHaveLength(3);
    expect(shelfEl?.textContent).toContain(t("d3Home.live.backfill", { count: 2 }));
    expect(videoIds(shelf("videos"))).toEqual(["v4", "v5", "v6", "v7"]);
  });

  it("0 live with videos: the newest video stands in for the feature, then Latest videos", async () => {
    await renderHome(<HomePage {...props()} />);
    expect(screen.queryByTestId("home-hero")).toBeNull();
    const recorded = screen.getByTestId("home-hero-recorded");
    expect(recorded.textContent).toContain(t("d3Home.hero.recorded.body", { channel: "aurora" }));
    expect(recorded.querySelector('a[href="/aurora/vods/v1"]')).not.toBeNull();
    expect(screen.getByText(t("d3Home.hero.eyebrowQuiet"))).toBeTruthy();
    const latest = section("live");
    expect(within(latest as HTMLElement).getByRole("heading", { name: t("d3Home.live.latest") })).toBeTruthy();
    expect(videoIds(latest)).toEqual(["v2", "v3", "v4", "v5"]);
    expect(latest?.textContent).toContain(t("d3Home.live.backfillNone"));
    expect(videoIds(shelf("videos"))).toEqual(["v6", "v7", "v8"]);
    // The CTA is still the one filled button.
    expect(document.querySelectorAll("[data-filled-cta]")).toHaveLength(1);
  });

  it("0 live and no video: the empty state, counted, and the bands still show", async () => {
    await renderHome(<HomePage {...props({ shelves: { videos: ok([]), clips: ok([]), coop: ok(COOP) } })} />);
    const empty = screen.getByTestId("directory-empty");
    expect(empty.textContent).toContain(t("d3Home.empty.title"));
    expect(within(empty).getByText(t("d3Home.empty.action")).closest("a")?.getAttribute("href")).toBe("/creators");
    expect(tracked.calls).toContain("home.empty|view|none");
    expect(screen.getByTestId("home-coop-band")).toBeTruthy();
    expect(screen.getByTestId("home-stream-band")).toBeTruthy();
    expect(shelf("videos")).toBeNull();
  });
});

describe("each shelf fails on its own", () => {
  it("videos, clips and categories each show their own Retry; the rest of the page stays", async () => {
    await renderHome(
      <HomePage
        {...props({
          home: nineLive(),
          categories: failed,
          shelves: { videos: failed, clips: failed, coop: failed },
        })}
      />,
    );
    expect(screen.getByTestId("home-videos-load-error").textContent).toContain(t("d3Home.catchUp.title"));
    expect(screen.getByTestId("home-clips-load-error").textContent).toContain(t("d3Home.clips.title"));
    expect(screen.getByTestId("home-categories-load-error").textContent).toContain(t("d3Home.categories.title"));
    expect(cardSlugs(section("live"))).toHaveLength(8);
    // Without the co-op numbers the copy says less, never a guessed figure.
    expect(screen.getByText(t("d3Home.hero.bodyNoShare"))).toBeTruthy();
    expect(screen.queryByTestId("home-earned")).toBeNull();
    expect(screen.queryByTestId("home-coop-earned")).toBeNull();
    expect(screen.getByText(t("d3Home.streamBand.bodyNoShare"))).toBeTruthy();
  });

  it("the live feed failing says so in place of Live now; the media shelves still load", async () => {
    await renderHome(<HomePage {...props({ home: null })} />);
    expect(screen.getByTestId("home-live-load-error").textContent).toContain(t("d3Home.live.title"));
    expect(videoIds(shelf("videos"))).toHaveLength(4);
    expect(screen.queryByTestId("home-hero-recorded")).toBeNull();
  });
});

describe("the media and channel shelves", () => {
  it("Fresh clips link to the clip page and say who clipped them", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    const clips = shelf("clips") as HTMLElement;
    expect(clips.querySelector('a[href="/aurora/clips/c1"]')).not.toBeNull();
    expect(clips.textContent).toContain(t("d3Home.clips.by", { name: "Clipper" }));
  });

  it("categories list the quiet ones too, never with a 0 live badge", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    const cats = screen.getByTestId("home-categories-shelf");
    expect(
      [...cats.querySelectorAll('[data-testid="category-tile"]')].map((el) => el.getAttribute("data-category")),
    ).toEqual(["art", "music"]);
    expect(cats.textContent).not.toMatch(/\b0 (channels )?live/);
  });

  it("Recently live is a row of channel chips, none of them live on the page", async () => {
    const h = home({ ...twoLive(), recentlyLive: [offline("l1"), offline("dune", null), offline("fern")] });
    await renderHome(<HomePage {...props({ home: h })} />);
    const recent = section("recent") as HTMLElement;
    expect(
      [...recent.querySelectorAll('[data-testid="home-recent-tile"]')].map((el) => el.getAttribute("data-channel")),
    ).toEqual(["dune", "fern"]);
    expect(recent.querySelector('[data-slot="channel-chip-row"]')).not.toBeNull();
    expect(recent.textContent).toContain(t("d3Home.recent.never"));
  });

  it("the co-op band shows the share and the earned figure, with no filled button", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    const band = screen.getByTestId("home-coop-band");
    expect(band.textContent).toContain("90%");
    expect(within(band).getByTestId("home-coop-earned").textContent).toContain("$4,294.80");
    expect(band.querySelector("[data-filled-cta]")).toBeNull();
    expect(within(band).getByTestId("home-coop-cta").getAttribute("href")).toBe("/coop");
    fireEvent.click(within(band).getByTestId("home-coop-cta"));
    expect(tracked.calls).toContain("home.coopBand|click|join");
    fireEvent.click(screen.getByTestId("home-stream-cta"));
    expect(tracked.calls).toContain("home.streamBand|click|stream");
  });
});

describe("Continue watching", () => {
  const point = (vodId: string, positionSeconds: number) => ({
    vodId,
    channelSlug: "aurora",
    title: `${vodId} title`,
    thumbnailUrl: null,
    positionSeconds,
    durationSeconds: 600,
    updatedAt: "2026-11-01T12:00:00.000Z",
  });

  it("is absent with no resume points", async () => {
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    expect(shelf("continue")).toBeNull();
  });

  it("lists this browser's videos with progress, and Remove drops one here and in storage", async () => {
    localStorage.setItem(RESUME_KEY, JSON.stringify([point("r1", 150), point("r2", 300)]));
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    const items = await screen.findAllByTestId("home-continue");
    expect(items.map((el) => el.getAttribute("data-vod"))).toEqual(["r1", "r2"]);
    expect(items[0]?.querySelector('a[href="/aurora/vods/r1"]')).not.toBeNull();
    expect(items[0]?.textContent).toContain("2:30 of 10:00");
    const progress = items[0]?.querySelector<HTMLElement>('[data-testid="home-continue-progress"]');
    expect(progress?.getAttribute("data-percent")).toBe("25");
    expect(tracked.calls).toContain("home.shelf|view|continue");
    fireEvent.click(
      within(items[0] as HTMLElement).getByRole("button", { name: t("d3Home.continue.remove", { title: "r1 title" }) }),
    );
    expect(screen.getAllByTestId("home-continue").map((el) => el.getAttribute("data-vod"))).toEqual(["r2"]);
    expect(readResumePoints().map((p) => p.vodId)).toEqual(["r2"]);
  });

  it("still hides a removed video when storage throws", async () => {
    localStorage.setItem(RESUME_KEY, JSON.stringify([point("r1", 150)]));
    await renderHome(<HomePage {...props({ home: nineLive() })} />);
    await screen.findAllByTestId("home-continue");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    fireEvent.click(screen.getByTestId("home-continue-remove"));
    expect(screen.queryByTestId("home-continue")).toBeNull();
    spy.mockRestore();
  });
});

describe("signed in", () => {
  it("no marketing hero: the featured stream alone, Following live, then Live now", async () => {
    const h = home({
      spotlight: [live("s1"), live("s2")],
      live: [live("s1"), live("s2"), live("f1")],
      following: [live("f1")],
    });
    await renderHome(<HomePage {...props({ home: h, me: MEMBER, viewer: MEMBER.id })} />);
    expect(screen.queryByTestId("home-welcome")).toBeNull();
    expect(document.querySelector("[data-filled-cta]")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t("pageTitle.home"));
    expect(cardSlugs(screen.getByTestId("home-hero"))).toEqual(["s1"]);
    expect(cardSlugs(section("following"))).toEqual(["f1"]);
    expect(cardSlugs(section("live"))).toEqual(["s2"]);
    expect(tracked.calls).not.toContain("home.hero|view|none");
  });

  it("nothing at all yet: the empty state points to the studio", async () => {
    await renderHome(
      <HomePage
        {...props({ me: MEMBER, viewer: MEMBER.id, shelves: { videos: ok([]), clips: ok([]), coop: ok(COOP) } })}
      />,
    );
    const empty = screen.getByTestId("directory-empty");
    expect(within(empty).getByText(t("home.toDashboard")).closest("a")?.getAttribute("href")).toBe("/dashboard");
  });

  it("a live streamer gets their status bar in the feature's place and no stream band", async () => {
    const me = { ...MEMBER, id: "u2", username: "aurora", channelSlug: "aurora" };
    const h = home({
      spotlight: [live("aurora"), live("birch")],
      live: [live("aurora"), live("birch"), live("cedar")],
    });
    await renderHome(<HomePage {...props({ home: h, me, viewer: me.id })} />);
    expect(screen.getByTestId("home-own-live").getAttribute("data-channel")).toBe("aurora");
    expect(screen.queryByTestId("home-hero")).toBeNull();
    expect(cardSlugs(section("live"))).toEqual(["birch", "cedar"]);
    expect(screen.queryByTestId("home-stream-band")).toBeNull();
  });
});
