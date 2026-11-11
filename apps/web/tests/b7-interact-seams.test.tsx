// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The batch 7 contract step's interact web seams: giveaway frames routed and applied (malformed
 * ones dropped), giveaway visibility, the hook's giveaway state (loaded on join, refreshed on
 * every giveaway frame, set after an entry), the instance flag gate of the browser client, and
 * bets stamped with the player seam's playhead and playback mode (decision (v)).
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  giveawaysEnabled,
  withPlayhead,
  type InteractClient,
  type PlayheadClock,
} from "../src/chat/interact/client.ts";
import {
  RESULTS_VISIBLE_MS,
  applyGiveawayFrame,
  giveawayVisible,
  parseGiveawayFrame,
  routeEventFrame,
  type GiveawayDto,
  type GiveawayFrame,
} from "../src/chat/interact/state.ts";
import { useChatInteract } from "../src/chat/interact/use-chat-interact.ts";
import { registerMediaClock } from "../src/player/media-clock.ts";

afterEach(() => {
  cleanup();
});

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const GIVE = UUID(3);
const broadcaster = {
  broadcaster_user_id: UUID(9),
  broadcaster_user_login: "rivertide",
  broadcaster_user_name: "Rivertide",
};
const begin = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: GIVE,
  title: "Stickers",
  winner_count: 2,
  keyword: "!enter",
  seed_commitment: "a".repeat(64),
  started_at: "2026-11-01T12:00:00.000Z",
  closes_at: null,
  ...over,
});
const end = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: GIVE,
  title: "Stickers",
  status: "drawn",
  entries: 7,
  winners: 2,
  seed: "b".repeat(64),
  started_at: "2026-11-01T12:00:00.000Z",
  ended_at: "2026-11-01T12:10:00.000Z",
  ...over,
});
const giveaway = (over: Partial<GiveawayDto> = {}): GiveawayDto => ({
  id: GIVE,
  channelSlug: "rivertide",
  title: "Stickers",
  prize: "A sticker pack",
  winnerCount: 2,
  keyword: "!enter",
  status: "open",
  eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
  seedCommitment: "a".repeat(64),
  opensAt: "2026-11-01T12:00:00.000Z",
  closesAt: null,
  drawnAt: null,
  entries: 3,
  me: { entered: false, pseudonym: null, eligible: true, reason: null, won: false },
  winners: [],
  ...over,
});
const frame = (type: string, data: unknown): GiveawayFrame => {
  const f = parseGiveawayFrame(type, data);
  if (!f) throw new Error(`${type} did not parse`);
  return f;
};

describe("giveaway frames", () => {
  it("route to the giveaway card; malformed ones are dropped, never logged", () => {
    expect(routeEventFrame("channel.giveaway.begin", begin()).kind).toBe("giveaway");
    expect(routeEventFrame("channel.giveaway.end", end()).kind).toBe("giveaway");
    expect(routeEventFrame("channel.giveaway.end", end({ status: "closed" })).kind).toBe("drop");
    expect(routeEventFrame("channel.giveaway.begin", { ...begin(), winner_count: "two" }).kind).toBe("drop");
    expect(routeEventFrame("channel.giveaway.end", begin()).kind).toBe("drop");
    expect(routeEventFrame("channel.giveaway.begin", null).kind).toBe("drop");
    expect(routeEventFrame("channel.giveaway.unknown", begin()).kind).toBe("row");
  });

  it("parse begin as open (no entry count) and end with its status, count and end time", () => {
    expect(frame("channel.giveaway.begin", begin())).toEqual({
      type: "channel.giveaway.begin",
      id: GIVE,
      title: "Stickers",
      status: "open",
      entries: null,
      startedAt: "2026-11-01T12:00:00.000Z",
      endedAt: null,
    });
    expect(frame("channel.giveaway.end", end({ status: "cancelled", seed: null }))).toMatchObject({
      status: "cancelled",
      entries: 7,
      endedAt: "2026-11-01T12:10:00.000Z",
    });
  });

  it("an end for the shown giveaway moves it to drawn with the count and draw time", () => {
    const next = applyGiveawayFrame(giveaway(), frame("channel.giveaway.end", end()));
    expect(next).toMatchObject({ status: "drawn", entries: 7, drawnAt: "2026-11-01T12:10:00.000Z" });
    // The viewer's own entry and the prize are kept (only `current` knows them).
    expect(next?.me).toEqual(giveaway().me);
    expect(next?.prize).toBe("A sticker pack");
  });

  it("a cancel keeps drawnAt null; a begin or another giveaway's frame changes nothing", () => {
    expect(applyGiveawayFrame(giveaway(), frame("channel.giveaway.end", end({ status: "cancelled" })))).toMatchObject({
      status: "cancelled",
      drawnAt: null,
    });
    const g = giveaway();
    expect(applyGiveawayFrame(g, frame("channel.giveaway.begin", begin()))).toBe(g);
    expect(applyGiveawayFrame(g, frame("channel.giveaway.end", end({ id: UUID(4) })))).toBe(g);
    expect(applyGiveawayFrame(null, frame("channel.giveaway.end", end()))).toBeNull();
  });

  it("never moves back from drawn or cancelled", () => {
    const drawn = giveaway({ status: "drawn", drawnAt: "2026-11-01T12:09:00.000Z" });
    expect(applyGiveawayFrame(drawn, frame("channel.giveaway.end", end({ status: "cancelled" })))?.status).toBe(
      "cancelled",
    );
    // A second drawn frame keeps the first draw time.
    expect(applyGiveawayFrame(drawn, frame("channel.giveaway.end", end()))?.drawnAt).toBe("2026-11-01T12:09:00.000Z");
  });
});

describe("giveawayVisible", () => {
  const now = Date.parse("2026-11-01T12:10:00.000Z");
  it("shows open and closed giveaways, a drawn one for RESULTS_VISIBLE_MS, never a cancelled one", () => {
    expect(giveawayVisible(null, now)).toBe(false);
    expect(giveawayVisible(giveaway(), now)).toBe(true);
    expect(giveawayVisible(giveaway({ status: "closed" }), now)).toBe(true);
    expect(giveawayVisible(giveaway({ status: "cancelled" }), now)).toBe(false);
    const drawn = giveaway({ status: "drawn", drawnAt: "2026-11-01T12:10:00.000Z" });
    expect(giveawayVisible(drawn, now + RESULTS_VISIBLE_MS - 1)).toBe(true);
    expect(giveawayVisible(drawn, now + RESULTS_VISIBLE_MS)).toBe(false);
    expect(giveawayVisible(giveaway({ status: "drawn", drawnAt: null }), now)).toBe(false);
  });
});

function fakeClient(current: () => Promise<GiveawayDto | null>) {
  const bet = vi.fn<InteractClient["bet"]>();
  const giveawayCurrent = vi.fn<InteractClient["giveawayCurrent"]>(current);
  const client: InteractClient = {
    pollCurrent: async () => null,
    vote: vi.fn<InteractClient["vote"]>(),
    predictionCurrent: async () => null,
    bet,
    balance: async () => ({
      channelSlug: "rivertide",
      user: { id: UUID(50), username: "fan" },
      points: 0,
      pointsName: "points",
      accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
      earnedToday: null,
      enabled: false,
    }),
    giveawayCurrent,
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
  };
  return { client, bet, giveawayCurrent };
}

describe("useChatInteract giveaway state", () => {
  const hook = (client: InteractClient) =>
    renderHook(() =>
      useChatInteract({ channel: "rivertide", signedIn: true, selfUsername: "fan", client, onFollowRaid: () => {} }),
    );

  it("loads the giveaway on join and refreshes it on every giveaway frame, which never reaches the log", async () => {
    let next: GiveawayDto | null = giveaway();
    const { client, giveawayCurrent } = fakeClient(async () => next);
    const { result } = hook(client);
    await waitFor(() => expect(result.current.giveaway?.id).toBe(GIVE));
    expect(giveawayCurrent).toHaveBeenCalledWith("rivertide");
    next = giveaway({ status: "closed", entries: 5 });
    let handled = false;
    act(() => {
      handled = result.current.onEvent("channel.giveaway.begin", begin());
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(result.current.giveaway?.status).toBe("closed"));
    expect(giveawayCurrent).toHaveBeenCalledTimes(2);
  });

  it("a cancel hides the card at once; setGiveaway shows the viewer's entry", async () => {
    const { client } = fakeClient(async () => giveaway());
    const { result } = hook(client);
    await waitFor(() => expect(result.current.giveaway).not.toBeNull());
    act(() => {
      result.current.setGiveaway(
        giveaway({ me: { entered: true, pseudonym: "p", eligible: true, reason: null, won: false } }),
      );
    });
    expect(result.current.giveaway?.me?.entered).toBe(true);
    act(() => {
      result.current.onEvent("channel.giveaway.end", end({ status: "cancelled", seed: null }));
    });
    expect(result.current.giveaway).toBeNull();
  });

  it("a giveaway that fails to load leaves the card empty", async () => {
    const { client, giveawayCurrent } = fakeClient(async () => {
      throw new Error("FORBIDDEN");
    });
    const { result } = hook(client);
    await waitFor(() => expect(giveawayCurrent).toHaveBeenCalled());
    expect(result.current.giveaway).toBeNull();
  });
});

describe("giveawaysEnabled (GIVEAWAYS_ENABLED)", () => {
  const instance = (giveaways: boolean | Error) => {
    const info = vi.fn<() => Promise<{ features: { giveaways: boolean } }>>(async () => {
      if (giveaways instanceof Error) throw giveaways;
      return { features: { giveaways } };
    });
    return { client: { instance: { info } } as unknown as Parameters<typeof giveawaysEnabled>[0], info };
  };

  it("reads instance.info once per client", async () => {
    const { client, info } = instance(true);
    expect(await giveawaysEnabled(client)).toBe(true);
    expect(await giveawaysEnabled(client)).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(await giveawaysEnabled(instance(false).client)).toBe(false);
  });

  it("does not cache a failure", async () => {
    const { client, info } = instance(new Error("down"));
    await expect(giveawaysEnabled(client)).rejects.toThrow("down");
    await expect(giveawaysEnabled(client)).rejects.toThrow("down");
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe("withPlayhead (decision (v))", () => {
  const at = new Date("2026-11-01T12:00:05.250Z");

  it("stamps a bet with the channel's playhead and playback mode", async () => {
    const { client, bet } = fakeClient(async () => null);
    const clock = {
      playheadWallclock: vi.fn<PlayheadClock["playheadWallclock"]>(() => at),
      playbackMode: vi.fn<PlayheadClock["playbackMode"]>(() => "live"),
    };
    await withPlayhead(client, "rivertide", clock).bet({ id: UUID(2), outcomeId: "o1", points: 100 });
    expect(bet).toHaveBeenCalledWith({
      id: UUID(2),
      outcomeId: "o1",
      points: 100,
      mediaTs: "2026-11-01T12:00:05.250Z",
      playbackMode: "live",
    });
    expect(clock.playheadWallclock).toHaveBeenCalledWith("rivertide");
  });

  it("sends a null playhead before the first frame, and dvr while catching up", async () => {
    const { client, bet } = fakeClient(async () => null);
    const clock = { playheadWallclock: () => null, playbackMode: () => "dvr" as const };
    await withPlayhead(client, "rivertide", clock).bet({ id: UUID(2), outcomeId: "o1", points: 1 });
    expect(bet).toHaveBeenCalledWith({ id: UUID(2), outcomeId: "o1", points: 1, mediaTs: null, playbackMode: "dvr" });
  });

  it("keeps a caller's own values, and leaves every other call alone", async () => {
    const { client, bet, giveawayCurrent } = fakeClient(async () => null);
    const clock = { playheadWallclock: () => at, playbackMode: () => "live" as const };
    const wrapped = withPlayhead(client, "rivertide", clock);
    await wrapped.bet({ id: UUID(2), outcomeId: "o1", points: 1, mediaTs: null, playbackMode: "dvr" });
    expect(bet).toHaveBeenCalledWith({ id: UUID(2), outcomeId: "o1", points: 1, mediaTs: null, playbackMode: "dvr" });
    await wrapped.giveawayCurrent("rivertide");
    expect(giveawayCurrent).toHaveBeenCalledWith("rivertide");
  });

  it("reads the registered player by default", async () => {
    const { client, bet } = fakeClient(async () => null);
    const unregister = registerMediaClock("rivertide", { playheadWallclock: () => at, playbackMode: () => "live" });
    try {
      await withPlayhead(client, "rivertide").bet({ id: UUID(2), outcomeId: "o2", points: 5 });
    } finally {
      unregister();
    }
    expect(bet).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTs: "2026-11-01T12:00:05.250Z", playbackMode: "live" }),
    );
    await withPlayhead(client, "elsewhere").bet({ id: UUID(2), outcomeId: "o2", points: 5 });
    expect(bet).toHaveBeenLastCalledWith(expect.objectContaining({ mediaTs: null, playbackMode: "live" }));
  });
});
