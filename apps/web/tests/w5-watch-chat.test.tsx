// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 5 on the watch page: the composer gate for every chat mode against every viewer
 * state (J3-d, now with the subscribers-only reason before typing), the facts the panel derives
 * from the `joined` badges and `Channel.viewer.subscribed`, and the points popover's
 * "Today: N of {cap}" line with its Progress bar.
 */
import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  composerGate,
  joinedStanding,
  subscribedFact,
  type GateFacts,
  type GateReason,
} from "../src/chat/gate-reason.ts";
import { PointsChip, pointsToday } from "../src/chat/interact/points-chip.tsx";
import type { LoyaltyBalanceDto } from "../src/chat/interact/state.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: () => undefined }));

afterEach(() => cleanup());

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY = 86_400_000;

const settings = (over: Partial<ChannelChatSettings> = {}): ChannelChatSettings =>
  ({
    slowModeSeconds: 0,
    followersOnlyMinutes: null,
    subscribersOnly: false,
    emoteOnly: false,
    uniqueChat: false,
    requireVerifiedEmail: false,
    minAccountAgeDays: 0,
    minVerifiedWatchSeconds: 0,
    ...over,
  }) as ChannelChatSettings;

// ── composerGate: every chat mode × every viewer state ─────────────────────────────────────────

type Mode = "open" | "email" | "age" | "followers" | "followersAge" | "subs";
const MODES: Record<Mode, ChannelChatSettings> = {
  open: settings(),
  email: settings({ requireVerifiedEmail: true }),
  age: settings({ minAccountAgeDays: 7 }),
  followers: settings({ followersOnlyMinutes: 0 }),
  followersAge: settings({ followersOnlyMinutes: 30 }),
  subs: settings({ subscribersOnly: true }),
};

const OLD = new Date(NOW - 365 * DAY).toISOString();
const YOUNG = new Date(NOW - DAY).toISOString();
const SETTLED: GateFacts = { emailVerified: true, accountCreatedAt: OLD };

type Viewer =
  | "unknown"
  | "settled"
  | "unverified"
  | "young"
  | "follower"
  | "nonFollower"
  | "subscriber"
  | "nonSubscriber"
  | "vip"
  | "staff"
  | "privileged";
const VIEWERS: Record<Viewer, { facts: GateFacts; privileged?: boolean }> = {
  unknown: { facts: {} },
  settled: { facts: SETTLED },
  unverified: { facts: { ...SETTLED, emailVerified: false } },
  young: { facts: { ...SETTLED, accountCreatedAt: YOUNG } },
  follower: { facts: { ...SETTLED, following: true } },
  nonFollower: { facts: { ...SETTLED, following: false } },
  subscriber: { facts: { ...SETTLED, following: false, subscribed: true } },
  nonSubscriber: { facts: { ...SETTLED, following: true, subscribed: false } },
  vip: { facts: { ...SETTLED, following: false, subscribed: false, vip: true } },
  staff: { facts: { ...SETTLED, following: true, subscribed: false, staff: true } },
  // The owner and moderators: every gate fact against them, still nothing.
  privileged: {
    facts: { emailVerified: false, accountCreatedAt: YOUNG, following: false, subscribed: false },
    privileged: true,
  },
};

/** The expected reason kind per mode and viewer (null: nothing stops them before typing). */
const EXPECTED: Record<Mode, Partial<Record<Viewer, GateReason["kind"]>>> = {
  open: {},
  email: { unverified: "verifiedEmail" },
  age: { young: "accountAge" },
  followers: { nonFollower: "followers", subscriber: "followers" },
  followersAge: { nonFollower: "followers", subscriber: "followers" },
  subs: { nonSubscriber: "subs" },
};

describe("composerGate: every chat mode against every viewer state", () => {
  const cases = (Object.keys(MODES) as Mode[]).flatMap((mode) =>
    (Object.keys(VIEWERS) as Viewer[]).map((viewer) => [mode, viewer] as const),
  );
  it.each(cases)("%s × %s", (mode, viewer) => {
    const v = VIEWERS[viewer];
    const gate = composerGate({
      settings: MODES[mode],
      facts: v.facts,
      refused: null,
      privileged: v.privileged ?? false,
      now: NOW,
    });
    expect(gate?.kind ?? null).toBe(EXPECTED[mode][viewer] ?? null);
  });
});

describe("composerGate: subscribers-only (J3-d)", () => {
  const base = { refused: null, privileged: false, now: NOW } as const;
  const subs = settings({ subscribersOnly: true });

  it("known not subscribed: the reason before typing", () => {
    expect(composerGate({ ...base, settings: subs, facts: { subscribed: false } })).toEqual({ kind: "subs" });
  });

  it("unknown or subscribed: nothing until the server refuses", () => {
    expect(composerGate({ ...base, settings: subs, facts: { subscribed: null } })).toBeNull();
    expect(composerGate({ ...base, settings: subs, facts: { subscribed: true } })).toBeNull();
    expect(composerGate({ ...base, settings: subs, facts: { subscribed: true }, refused: "msg_subsonly" })).toEqual({
      kind: "subs",
    });
  });

  it("staff are not gated before typing, but a refusal still says why", () => {
    const staff: GateFacts = { subscribed: false, staff: true };
    expect(composerGate({ ...base, settings: subs, facts: staff })).toBeNull();
    expect(composerGate({ ...base, settings: subs, facts: staff, refused: "msg_subsonly" })).toEqual({ kind: "subs" });
  });

  it("VIPs skip it, as on the server, even after a stray refusal", () => {
    const vip: GateFacts = { subscribed: false, vip: true };
    expect(composerGate({ ...base, settings: subs, facts: vip })).toBeNull();
    expect(composerGate({ ...base, settings: subs, facts: vip, refused: "msg_subsonly" })).toBeNull();
  });

  it("the mode off: no reason whatever the facts", () => {
    expect(composerGate({ ...base, settings: settings(), facts: { subscribed: false } })).toBeNull();
  });

  it("the server's order: followers-only comes before subscribers-only", () => {
    const both = settings({ followersOnlyMinutes: 0, subscribersOnly: true });
    expect(composerGate({ ...base, settings: both, facts: { following: false, subscribed: false } })?.kind).toBe(
      "followers",
    );
    expect(composerGate({ ...base, settings: both, facts: { following: true, subscribed: false } })?.kind).toBe("subs");
  });
});

describe("joinedStanding and subscribedFact", () => {
  it("reads the joined badges, tiers included", () => {
    expect(joinedStanding([])).toEqual({ subscriber: false, vip: false, staff: false });
    expect(joinedStanding(["subscriber/3", "member"])).toEqual({ subscriber: true, vip: false, staff: false });
    expect(joinedStanding(["vip", "staff"])).toEqual({ subscriber: false, vip: true, staff: true });
    // A badge whose name only starts the same is not the badge.
    expect(joinedStanding(["subscriberish"]).subscriber).toBe(false);
  });

  it("either yes is enough; a no needs the join or the page", () => {
    const none = joinedStanding([]);
    const sub = joinedStanding(["subscriber/1"]);
    expect(subscribedFact(true, none)).toBe(true);
    expect(subscribedFact(undefined, sub)).toBe(true);
    expect(subscribedFact(null, none)).toBe(false);
    expect(subscribedFact(false, null)).toBe(false);
    expect(subscribedFact(null, null)).toBeNull();
    expect(subscribedFact(undefined, null)).toBeNull();
  });
});

// ── the points popover's "Today" line ──────────────────────────────────────────────────────────

describe("pointsToday", () => {
  it("hidden when earnedToday is null (not the caller's own) or the cap is 0", () => {
    expect(pointsToday(null, 1000)).toBeNull();
    expect(pointsToday(0, 0)).toBeNull();
    expect(pointsToday(50, 0)).toBeNull();
  });

  it("the earned part of the cap, rounded, clamped to the cap", () => {
    expect(pointsToday(0, 1000)).toEqual({ earned: 0, cap: 1000, left: 1000, percent: 0 });
    expect(pointsToday(340, 1000)).toEqual({ earned: 340, cap: 1000, left: 660, percent: 34 });
    expect(pointsToday(1, 3)).toEqual({ earned: 1, cap: 3, left: 2, percent: 33 });
    expect(pointsToday(1000, 1000)).toEqual({ earned: 1000, cap: 1000, left: 0, percent: 100 });
    // A cap lowered mid-day: today never reads above it.
    expect(pointsToday(1200, 1000)).toEqual({ earned: 1000, cap: 1000, left: 0, percent: 100 });
  });
});

const balance = (over: Partial<LoyaltyBalanceDto> = {}): LoyaltyBalanceDto => ({
  channelSlug: "indigo",
  user: { id: "0192f000-0000-7000-8000-000000000001", username: "fan" },
  points: 1240,
  pointsName: "notes",
  enabled: true,
  accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
  earnedToday: 340,
  ...over,
});

async function openPopover(b: LoyaltyBalanceDto): Promise<HTMLElement> {
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <PointsChip balance={b} />
      </TooltipProvider>
    </LocaleProvider>,
  );
  await act(async () => fireEvent.click(screen.getByTestId("chat-points")));
  return screen.findByTestId("chat-points-popover");
}

describe("PointsChip: Today: N of {cap}", () => {
  it("shows today's progress with a house Progress bar", async () => {
    const popover = await openPopover(
      balance({ earnedToday: 1340, accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 2000 } }),
    );
    const today = popover.querySelector('[data-testid="chat-points-today"]');
    expect(today?.getAttribute("data-earned")).toBe("1340");
    expect(today?.getAttribute("data-cap")).toBe("2000");
    expect(today?.textContent).toContain("Today: 1,340 of 2,000.");
    expect(today?.textContent).toContain("660 more to earn today.");
    const bar = today?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("67");
  });

  it("plurals: one left, and none left at the cap", () => {
    expect(t("w5Watch.points.todayLeft", { count: 1 })).toBe("1 more to earn today.");
    expect(t("w5Watch.points.todayLeft", { count: 0 })).toBe("That's today's most. Watching earns more tomorrow.");
    expect(t("w5Watch.points.todayLeft", { count: 2 })).toBe("2 more to earn today.");
  });

  it("at the cap it says so", async () => {
    const popover = await openPopover(balance({ earnedToday: 1000 }));
    expect(popover.querySelector('[data-testid="chat-points-today"]')?.textContent).toContain(
      "Today: 1,000 of 1,000. That's today's most.",
    );
  });

  it("hidden for someone else's balance (earnedToday null) and when accrual is off", async () => {
    const popover = await openPopover(balance({ earnedToday: null }));
    expect(popover.querySelector('[data-testid="chat-points-today"]')).toBeNull();
    cleanup();
    const off = await openPopover(balance({ accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 0 } }));
    expect(off.querySelector('[data-testid="chat-points-today"]')).toBeNull();
  });
});
