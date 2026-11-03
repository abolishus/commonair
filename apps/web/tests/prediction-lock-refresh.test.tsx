// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The lock frame reaching the prediction card (batch 8, B8-web; ADR 0039 §3): the
 * `channel.prediction.lock` frame carries no `lock_media_ts`, and the grace after a lock needs it,
 * so the hook refetches `current` on a lock. Without that, a card that loaded while the prediction
 * was active kept `lockMediaTs: null`, `graceEndsAt` was null, and `prediction-grace` never showed
 * (CI run 41721879712, interact `grace-bet-web`).
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { InteractClient } from "../src/chat/interact/client.ts";
import { graceEndsAt } from "../src/chat/interact/prediction-card.tsx";
import type { PredictionViewDto } from "../src/chat/interact/state.ts";
import { useChatInteract } from "../src/chat/interact/use-chat-interact.ts";

afterEach(() => {
  cleanup();
});

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const PRED = UUID(2);
const LOCKED_AT = "2026-11-03T12:00:00.000Z";
const LOCK_MEDIA = "2026-11-03T11:59:59.000Z";
const broadcaster = {
  broadcaster_user_id: UUID(9),
  broadcaster_user_login: "rivertide",
  broadcaster_user_name: "Rivertide",
};
const wireOutcomes = [
  { id: "o1", title: "Alpha", channel_points: 0, users: 0, top_predictors: [] },
  { id: "o2", title: "Beta", channel_points: 0, users: 0, top_predictors: [] },
];
const lockFrame = {
  ...broadcaster,
  id: PRED,
  title: "Who wins?",
  outcomes: wireOutcomes,
  started_at: "2026-11-03T11:58:00.000Z",
  locked_at: LOCKED_AT,
};

const view = (over: Partial<PredictionViewDto> = {}): PredictionViewDto => ({
  id: PRED,
  title: "Who wins?",
  outcomes: [
    { id: "o1", title: "Alpha", points: 0, users: 0 },
    { id: "o2", title: "Beta", points: 0, users: 0 },
  ],
  status: "active",
  startedAt: "2026-11-03T11:58:00.000Z",
  locksAt: "2026-11-03T12:00:00.000Z",
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
  lockMediaTs: null,
  resolvedBy: null,
  result: null,
  ...over,
});

function client(current: () => PredictionViewDto | null) {
  return {
    pollCurrent: async () => null,
    predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(async () => current()),
    vote: vi.fn<InteractClient["vote"]>(),
    bet: vi.fn<InteractClient["bet"]>(),
    balance: async () => ({ enabled: false, balance: 0, name: "points" }) as never,
    giveawayCurrent: async () => null,
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
  } satisfies InteractClient;
}

describe("a lock frame", () => {
  it("refetches current, so the card learns lockMediaTs and offers the grace", async () => {
    let server = view();
    const c = client(() => server);
    const { result } = renderHook(() =>
      useChatInteract({ channel: "rivertide", signedIn: true, selfUsername: "fan", client: c, onFollowRaid: () => {} }),
    );
    await waitFor(() => expect(result.current.prediction?.status).toBe("active"));
    expect(c.predictionCurrent).toHaveBeenCalledTimes(1);

    // The server locks (lock_media_ts set) and the frame reaches chat without it.
    server = view({ status: "locked", lockedAt: LOCKED_AT, lockMediaTs: LOCK_MEDIA });
    result.current.onEvent("channel.prediction.lock", lockFrame);

    await waitFor(() => expect(result.current.prediction?.lockMediaTs).toBe(LOCK_MEDIA));
    expect(c.predictionCurrent).toHaveBeenCalledTimes(2);
    const p = result.current.prediction;
    expect(p?.status).toBe("locked");
    expect(p?.lockedAt).toBe(LOCKED_AT);
    expect(p && graceEndsAt(p)).toBe(Date.parse(LOCKED_AT) + 30_000);
  });

  it("keeps the frame's locked status when current answers late with the active view", async () => {
    let server = view();
    const c = client(() => server);
    const { result } = renderHook(() =>
      useChatInteract({ channel: "rivertide", signedIn: true, selfUsername: "fan", client: c, onFollowRaid: () => {} }),
    );
    await waitFor(() => expect(result.current.prediction?.status).toBe("active"));
    // A replica behind the lock: current still says active, without a media-time lock.
    server = view();
    result.current.onEvent("channel.prediction.lock", lockFrame);
    await waitFor(() => expect(c.predictionCurrent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.prediction?.status).toBe("locked"));
    expect(result.current.prediction?.lockedAt).toBe(LOCKED_AT);
  });
});
