// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-shell (overhaul wave 3, D5.2, D5.8, J5-a): the studio LiveStatusBar's rules, its gentle poll
 * (only while visible, backoff on 429, Retry), its slot, the shared `me.moderates` list and the
 * account menu's "Mod view".
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ModeratedChannel } from "@commonair/contracts/dto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MEMBER, boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({
  boot: null as unknown,
  moderates: (async () => []) as () => Promise<unknown[]>,
}));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ me: { moderates: () => fake.moderates() } }),
  errorCode: (err: unknown) =>
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const model = await import("../src/components/studio-shell/model.ts");
const { StudioLiveStatusBar, LiveStatusSlot, LiveStatusSlotProvider } =
  await import("../src/components/studio-shell/live-status.tsx");
const { forgetModerates, loadModerates, MODERATES_TTL_MS } =
  await import("../src/components/studio-shell/moderates.ts");
const { useAccountItems } = await import("../src/components/shell/account-items.tsx");
const { t } = await import("../src/i18n/index.ts");

type StatusChannel = import("../src/components/studio-shell/model.ts").StatusChannel;
type StatusHealth = import("../src/components/studio-shell/model.ts").StatusHealth;
type StatusPollEnv = import("../src/components/studio-shell/use-live-status.ts").StatusPollEnv;

const STARTED = "2026-11-04T11:00:00.000Z";
const sample = (warnings: string[] = []) => ({
  at: "2026-11-04T11:59:50.000Z",
  bitrateKbps: 6000,
  fps: 60,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  keyframeIntervalMs: 2000,
  droppedFrames: 0,
  warnings,
});
const offlineChannel: StatusChannel = { slug: "aurora", live: null, lastLiveAt: null };
const liveChannel: StatusChannel = {
  slug: "aurora",
  live: { startedAt: STARTED, viewerCount: 7, title: "Pixel art" },
  lastLiveAt: null,
};
const health = (live: boolean, samples: ReturnType<typeof sample>[] = [], verified = 9): StatusHealth => ({
  live,
  samples,
  viewers: { verified, pending: 0, excluded: 0 },
});
const busy = (retryAfterSeconds?: number) =>
  Object.assign(new Error("busy"), {
    code: "TOO_MANY_REQUESTS",
    status: 429,
    data: retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
  });

beforeEach(() => {
  forgetModerates();
  fake.boot = boot({ me: { ...MEMBER, id: "u2", username: "aurora", channelSlug: "aurora" } });
  fake.moderates = async () => [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("liveStatusState", () => {
  it.each([
    ["nothing yet", null, null, "offline"],
    ["offline", offlineChannel, health(false), "offline"],
    ["live, no samples yet", liveChannel, health(true), "starting"],
    ["live with samples", liveChannel, health(true, [sample()]), "live"],
    ["live, health failed", liveChannel, null, "live"],
    ["health live before the channel", offlineChannel, health(true, [sample()]), "starting"],
  ] as const)("%s → %s", (_name, channel, h, want) => {
    expect(model.liveStatusState(channel, h)).toBe(want);
  });
});

describe("healthSummary and verifiedViewers", () => {
  it("says unknown without a live answer or a sample, else healthy or needs attention", () => {
    expect(model.healthSummary(null)).toBe("unknown");
    expect(model.healthSummary(health(false, [sample()]))).toBe("unknown");
    expect(model.healthSummary(health(true))).toBe("unknown");
    expect(model.healthSummary(health(true, [sample()]))).toBe("healthy");
    expect(model.healthSummary(health(true, [sample(["bitrate_low"])]))).toBe("warning");
  });

  it("prefers the owner's health count, then the public count, else nothing", () => {
    expect(model.verifiedViewers(liveChannel, health(true, [], 12))).toBe(12);
    expect(model.verifiedViewers(liveChannel, health(false))).toBe(7);
    expect(model.verifiedViewers(liveChannel, null)).toBe(7);
    expect(model.verifiedViewers(offlineChannel, null)).toBeNull();
    expect(model.verifiedViewers(null, null)).toBeNull();
  });
});

describe("statusPollDelay", () => {
  it("polls every 30 s, doubling after failures up to 5 minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => model.statusPollDelay(n))).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
    expect(model.statusPollDelay(-2)).toBe(30_000);
    expect(model.statusPollDelay(1.7)).toBe(60_000);
  });

  it("waits out a longer 429 hint, capped, and ignores a shorter one", () => {
    expect(model.statusPollDelay(1, busy(90))).toBe(90_000);
    expect(model.statusPollDelay(1, busy(5))).toBe(60_000);
    expect(model.statusPollDelay(1, busy(9999))).toBe(300_000);
    expect(model.statusPollDelay(1, busy())).toBe(60_000);
    expect(model.statusPollDelay(1, new Error("not found"))).toBe(60_000);
  });
});

/** Manual timers and visibility. */
function fakeEnv() {
  let visible = true;
  const listeners = new Set<() => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const env: StatusPollEnv = {
    isVisible: () => visible,
    onVisibilityChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setTimeout: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  return {
    env,
    pending: () => [...timers.values()].map((x) => x.ms),
    async fire() {
      const all = [...timers.entries()];
      timers.clear();
      await act(async () => {
        for (const [, x] of all) x.fn();
        await Promise.resolve();
      });
    },
    async setVisible(v: boolean) {
      visible = v;
      await act(async () => {
        for (const l of listeners) l();
        await Promise.resolve();
      });
    },
  };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const barEl = () => screen.getByTestId("studio-status-bar");

describe("StudioLiveStatusBar", () => {
  it("renders nothing without a channel and reads nothing", async () => {
    const channel = vi.fn<(slug: string) => Promise<StatusChannel>>(async () => offlineChannel);
    const loader = { channel, health: vi.fn<(slug: string) => Promise<StatusHealth>>(async () => health(false)) };
    await renderInRouter(<StudioLiveStatusBar slug={null} pathname="/dashboard" loader={loader} env={fakeEnv().env} />);
    await flush();
    expect(screen.queryByTestId("studio-status-bar")).toBeNull();
    expect(channel).not.toHaveBeenCalled();
  });

  it("offline: says so, never-live line, and links the stream manager (current here) and the channel", async () => {
    const f = fakeEnv();
    const loader = { channel: async () => offlineChannel, health: async () => health(false) };
    await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/dashboard/" loader={loader} env={f.env} />);
    await flush();
    expect(barEl().getAttribute("data-state")).toBe("offline");
    expect(barEl().getAttribute("aria-label")).toBe(t("d5Shell.status.region"));
    expect(barEl().textContent).toContain(t("d5Shell.status.neverLive"));
    const manager = screen.getByTestId("studio-status-manager");
    expect(manager.getAttribute("href")).toBe("/dashboard");
    expect(manager.getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("studio-status-channel").getAttribute("href")).toBe("/aurora");
    expect(f.pending()).toEqual([30_000]);
  });

  it("offline after a stream: the last-live time", async () => {
    const loader = {
      channel: async () => ({ ...offlineChannel, lastLiveAt: "2026-11-04T11:40:00.000Z" }),
      health: async () => health(false),
    };
    await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/content" loader={loader} env={fakeEnv().env} />);
    await flush();
    expect(barEl().textContent).toContain(t("d5Shell.status.lastLive"));
    expect(barEl().querySelector('[data-slot="live-status-detail"] time')).not.toBeNull();
    expect(screen.getByTestId("studio-status-manager").hasAttribute("aria-current")).toBe(false);
  });

  it("live: uptime, the health count and word, the title; starting before the first sample", async () => {
    let h = health(true);
    const loader = { channel: async () => liveChannel, health: async () => h };
    const f = fakeEnv();
    await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/content" loader={loader} env={f.env} />);
    await flush();
    expect(barEl().getAttribute("data-state")).toBe("starting");
    h = health(true, [sample(["fps_drop"])], 16);
    await f.fire();
    await flush();
    expect(barEl().getAttribute("data-state")).toBe("live");
    expect(barEl().querySelector('[data-slot="live-status-viewers"]')?.textContent).toContain("16");
    expect(barEl().querySelector('[data-slot="live-status-health"]')?.getAttribute("data-health")).toBe("warning");
    expect(barEl().textContent).toContain("Pixel art");
  });

  it("polls only while visible and reads at once on coming back", async () => {
    const channel = vi.fn<(slug: string) => Promise<StatusChannel>>(async () => offlineChannel);
    const loader = { channel, health: async () => health(false) };
    const f = fakeEnv();
    await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/content" loader={loader} env={f.env} />);
    await flush();
    expect(channel).toHaveBeenCalledTimes(1);
    await f.setVisible(false);
    expect(f.pending()).toEqual([]);
    await f.setVisible(true);
    await flush();
    expect(channel).toHaveBeenCalledTimes(2);
    expect(f.pending()).toEqual([30_000]);
  });

  it("a 429 backs off by its hint, shows Retry with nothing to show, and Retry resets the pace", async () => {
    let fail = true;
    const channel = vi.fn<(slug: string) => Promise<StatusChannel>>(async () => {
      if (fail) throw busy(120);
      return offlineChannel;
    });
    const loader = { channel, health: async () => health(false) };
    const f = fakeEnv();
    await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/content" loader={loader} env={f.env} />);
    await flush();
    expect(f.pending()).toEqual([120_000]);
    expect(screen.getByTestId("studio-status-error").textContent).toBe(t("d5Shell.status.loadFailed"));
    fail = false;
    fireEvent.click(screen.getByTestId("studio-status-retry"));
    await flush();
    expect(screen.queryByTestId("studio-status-error")).toBeNull();
    expect(f.pending()).toEqual([30_000]);
  });

  it("a later failure keeps the last answer on screen (no Retry), and health reads unknown", async () => {
    let fail = false;
    const loader = {
      channel: async () => {
        if (fail) throw busy();
        return liveChannel;
      },
      health: async () => {
        if (fail) throw busy();
        return health(true, [sample()]);
      },
    };
    const f = fakeEnv();
    await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/content" loader={loader} env={f.env} />);
    await flush();
    fail = true;
    await f.fire();
    await flush();
    expect(barEl().getAttribute("data-state")).toBe("live");
    expect(screen.queryByTestId("studio-status-retry")).toBeNull();
    expect(barEl().querySelector('[data-slot="live-status-health"]')?.getAttribute("data-health")).toBe("unknown");
    expect(f.pending()).toEqual([60_000]);
  });
});

describe("LiveStatusSlot", () => {
  it("portals a page's prompt into the bar's slot, and renders nothing without a host", async () => {
    const host = document.createElement("span");
    document.body.append(host);
    await renderInRouter(
      <>
        <LiveStatusSlotProvider host={host}>
          <LiveStatusSlot>
            <button>Copy your channel link</button>
          </LiveStatusSlot>
        </LiveStatusSlotProvider>
        <LiveStatusSlot>
          <button>Nowhere</button>
        </LiveStatusSlot>
      </>,
    );
    expect(host.querySelector("button")?.textContent).toBe("Copy your channel link");
    expect(screen.queryByText("Nowhere")).toBeNull();
    host.remove();
  });
});

const moderated = (slug: string, live = false): ModeratedChannel => ({
  channel: { id: slug, slug, displayName: slug.toUpperCase(), avatarUrl: null, accent: "violet" },
  role: "moderator",
  live,
});

describe("loadModerates", () => {
  it("shares one request per member until the TTL, then asks again", async () => {
    const load = vi.fn<() => Promise<ModeratedChannel[]>>(async () => [moderated("birch")]);
    const now = 1_000_000;
    const [a, b] = await Promise.all([loadModerates("u", load, now), loadModerates("u", load, now + 10)]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
    await loadModerates("other", load, now);
    expect(load).toHaveBeenCalledTimes(2);
    await loadModerates("u", load, now + MODERATES_TTL_MS);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("a failure reads as empty and is asked again next time", async () => {
    const load = vi
      .fn<() => Promise<ModeratedChannel[]>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([moderated("birch")]);
    expect(await loadModerates("u", load, 0)).toEqual([]);
    expect((await loadModerates("u", load, 1)).map((m) => m.channel.slug)).toEqual(["birch"]);
  });
});

function MenuIds(): React.JSX.Element {
  const items = useAccountItems();
  return (
    <ul data-testid="menu">
      {items.map((i) => (
        <li key={i.id}>{`${i.id}:${i.label}`}</li>
      ))}
    </ul>
  );
}

describe("account menu", () => {
  it("is Your channel, Creator studio, Following, Settings, Co-op membership, Sign out without roles", async () => {
    await renderInRouter(<MenuIds />);
    await flush();
    expect([...screen.getByTestId("menu").children].map((li) => li.textContent)).toEqual([
      `channel:${t("shell.menu.channel")}`,
      "studio:Creator studio",
      `following:${t("shell.menu.following")}`,
      `settings:${t("shell.menu.settings")}`,
      `coop:${t("nav.coopMembership")}`,
      `signOut:${t("nav.signOut")}`,
    ]);
  });

  it("adds Mod view, opening the first channel the member moderates", async () => {
    fake.moderates = async () => [moderated("birch", true), moderated("cedar")];
    await renderInRouter(
      <>
        <MenuIds />
      </>,
    );
    await flush();
    expect(screen.getByTestId("menu").children[2]?.textContent).toBe(`modView:${t("d5Shell.menu.modView")}`);
  });

  it("a failed list leaves the menu as it is", async () => {
    fake.moderates = async () => {
      throw new Error("down");
    };
    await renderInRouter(<MenuIds />);
    await flush();
    expect(screen.getByTestId("menu").textContent).not.toContain("modView");
  });
});
