// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E8-studio pages with a fake API: `/interact` (polls, predictions, raids, goals) and `/bot`
 * (settings, commands, timers, variables, song requests, points). Form payloads, live-card
 * transitions, confirmations before end/resolve/cancel/remove, raid refusal codes and what each
 * role sees (docs/testing/e8-selectors.md).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BotStudio } from "../src/components/bot-studio/bot-studio.tsx";
import { InteractStudio } from "../src/components/interact-studio/interact-studio.tsx";
import type { StudioApi } from "../src/components/interact-studio/shared.tsx";
import { resolveStudioRole } from "../src/components/interact-studio/studio-access.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { BotSettingsDto, SongRequestDto } from "../src/lib/bot-studio.ts";
import type { GoalDto, PollDto, PredictionDto, RaidStateDto } from "../src/lib/interact-studio.ts";

afterEach(cleanup);

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const ME = { id: "0192f000-0000-7000-8000-000000000001", username: "ann", channelSlug: "ann" };
const FAR = "2099-10-29T10:01:00.000Z";

const poll = (over: Partial<PollDto> = {}): PollDto => ({
  id: "0192f000-0000-7000-8000-0000000000a1",
  title: "Best map?",
  choices: [
    { id: "c1", title: "Dust", votes: 2 },
    { id: "c2", title: "Mirage", votes: 1 },
    { id: "c3", title: "Inferno", votes: 0 },
  ],
  status: "active",
  startedAt: "2026-10-29T10:00:00.000Z",
  endsAt: FAR,
  endedAt: null,
  pointsPerExtraVote: 0,
  myVote: null,
  myVotes: 0,
  ...over,
});

const prediction = (over: Partial<PredictionDto> = {}): PredictionDto => ({
  id: "0192f000-0000-7000-8000-0000000000b1",
  title: "Who wins?",
  outcomes: [
    { id: "oa", title: "Team A", points: 400, users: 2 },
    { id: "ob", title: "Team B", points: 200, users: 1 },
  ],
  status: "active",
  startedAt: "2026-10-29T10:00:00.000Z",
  locksAt: FAR,
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
  ...over,
});

const raidState = (over: Partial<RaidStateDto> = {}): RaidStateDto => ({
  raid: null,
  cooldownEndsAt: null,
  policy: "anyone",
  ...over,
});

const raid = (over: Partial<NonNullable<RaidStateDto["raid"]>> = {}): NonNullable<RaidStateDto["raid"]> => ({
  id: "0192f000-0000-7000-8000-0000000000c1",
  from: "ann",
  to: "bob",
  toDisplayName: "Bob",
  viewerCount: 0,
  status: "pending",
  cancelReason: null,
  createdAt: "2026-10-29T10:00:00.000Z",
  executeAt: FAR,
  ...over,
});

const goal = (over: Partial<GoalDto> = {}): GoalDto => ({
  id: "0192f000-0000-7000-8000-0000000000d1",
  type: "followers",
  title: "Two follows",
  target: 2,
  current: 1,
  startedAt: "2026-10-29T10:00:00.000Z",
  endedAt: null,
  ...over,
});

const botSettings = (over: Partial<BotSettingsDto> = {}): BotSettingsDto => ({
  enabled: false,
  botUser: null,
  config: {
    displayName: "ChannelBot",
    filters: {
      spam: { enabled: true, maxRepeatedChars: 12 },
      links: { enabled: false, allowSubscribers: true, allowlist: [] },
      caps: { enabled: false, minLength: 15, maxRatio: 0.7 },
      timeoutSeconds: 10,
    },
    loyalty: { enabled: true, pointsName: "points" },
    songRequests: { enabled: false, maxQueue: 25 },
  },
  ...over,
});

const apiError = (code: string, data?: Record<string, unknown>) => Object.assign(new Error(code), { code, data });

/** A typed `vi.fn` around `impl` (its signature is the mock's). */
function fn<A extends unknown[], R>(impl: (...args: A) => R) {
  return vi.fn<(...args: A) => R>(impl);
}

/** Every procedure the studio pages call, as a `vi.fn` with harmless defaults. */
function fakeApi() {
  const m = {
    interact: {
      polls: {
        current: fn(async (_i: unknown): Promise<PollDto | null> => null),
        create: fn(async (input: { title: string; choices: string[] }) =>
          poll({ title: input.title, choices: input.choices.map((title, i) => ({ id: `n${i}`, title, votes: 0 })) }),
        ),
        end: fn(async (input: { status: "terminated" | "archived" }) => poll({ status: input.status })),
      },
      predictions: {
        current: fn(async (_i: unknown): Promise<PredictionDto | null> => null),
        create: fn(async (_i: unknown) => prediction()),
        lock: fn(async (_i: unknown) => prediction({ status: "locked" })),
        resolve: fn(async (input: { winningOutcomeId: string }) =>
          prediction({ status: "resolved", winningOutcomeId: input.winningOutcomeId }),
        ),
        cancel: fn(async (_i: unknown) => prediction({ status: "canceled" })),
      },
      raids: {
        current: fn(async (_i: unknown) => raidState()),
        start: fn(async (_i: unknown) => raid()),
        cancel: fn(async (_i: unknown) => ({ ok: true })),
        setPolicy: fn(async (input: { policy: RaidStateDto["policy"] }) => raidState({ policy: input.policy })),
      },
      goals: {
        list: fn(async (_i: unknown): Promise<GoalDto[]> => []),
        create: fn(async (input: { type: GoalDto["type"]; title: string; target: number }) =>
          goal({ ...input, current: 0, id: "0192f000-0000-7000-8000-0000000000d9" }),
        ),
        end: fn(async (input: { id: string }) => goal({ id: input.id, endedAt: "2026-10-29T11:00:00.000Z" })),
      },
    },
    bot: {
      settings: fn(async (_i: unknown) => botSettings()),
      updateSettings: fn(async (input: { enabled: boolean; config: BotSettingsDto["config"] }) =>
        botSettings({ enabled: input.enabled, config: input.config, botUser: { id: "b1", username: "annbot" } }),
      ),
      commands: {
        list: fn(async (_i: unknown): Promise<unknown[]> => []),
        upsert: fn(async (input: Record<string, unknown>) => ({ id: "cmd1", useCount: 0, ...input })),
        remove: fn(async (_i: unknown) => ({ ok: true })),
      },
      timers: {
        list: fn(async (_i: unknown): Promise<unknown[]> => []),
        upsert: fn(async (input: Record<string, unknown>) => ({ id: "t1", ...input })),
        remove: fn(async (_i: unknown) => ({ ok: true })),
      },
      variables: {
        list: fn(async (_i: unknown): Promise<unknown[]> => []),
        set: fn(async (_i: unknown) => ({ ok: true })),
      },
      songRequests: {
        list: fn(async (_i: unknown): Promise<SongRequestDto[]> => []),
        setStatus: fn(async (input: { id: string; status: SongRequestDto["status"] }) => ({
          id: input.id,
          url: "https://example.org/song",
          requester: "viewer1",
          status: input.status,
          createdAt: "2026-10-29T10:00:00.000Z",
        })),
      },
      points: {
        leaderboard: fn(async (_i: unknown): Promise<unknown[]> => []),
        adjust: fn(async (input: { username: string; delta: number }) => ({
          channelSlug: "ann",
          user: { id: "u9", username: input.username },
          points: Math.max(0, input.delta),
          pointsName: "points",
          enabled: true,
        })),
      },
    },
    channels: {
      roles: { list: fn(async (_i: unknown): Promise<unknown[]> => []) },
    },
  };
  return { m, client: m as unknown as StudioApi };
}

const id = (testId: string) => screen.getByTestId(testId);
const type = (testId: string, value: string) => fireEvent.change(id(testId), { target: { value } });
const submit = (testId: string) => fireEvent.click(id(testId));

/** Open a confirmation and press its confirm button. */
async function confirm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
}

/** Pick a `SelectField` option by its test id (Base UI opens on click). */
async function pick(triggerId: string, optionId: string, alsoListed: readonly string[] = []): Promise<void> {
  const trigger = id(triggerId);
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const option = await screen.findByTestId(optionId);
  for (const other of alsoListed) expect(screen.getByTestId(other)).toBeTruthy();
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseUp(option, { button: 0 });
  fireEvent.click(option);
}

function renderInteract(client: StudioApi, opts: { channel?: string } = {}) {
  return wrap(<InteractStudio me={ME} channel={opts.channel ?? "ann"} currency="usd" client={client} refreshMs={10} />);
}

// ── /interact ────────────────────────────────────────────────────────────────────────────────

describe("/interact: owner", () => {
  it("shows every section and the raid policy", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    for (const t of ["poll-form", "prediction-form", "raid-form", "raid-policy", "goal-form"])
      expect(await screen.findByTestId(t)).toBeTruthy();
    expect(screen.getByTestId("poll-choice-1")).toBeTruthy();
    expect(screen.getByTestId("poll-choice-2")).toBeTruthy();
    expect(screen.queryByTestId("poll-choice-3")).toBeNull();
    expect(m.channels.roles.list).not.toHaveBeenCalled();
    expect(m.interact.raids.current).toHaveBeenCalledWith({ channel: "ann" });
  });

  it("shows the load error and retries", async () => {
    const { client, m } = fakeApi();
    m.interact.polls.current.mockRejectedValueOnce(new Error("down"));
    renderInteract(client);
    const error = await screen.findByTestId("interact-load-error");
    expect(error.textContent).toContain(en["interact.loadFailed"]);
    fireEvent.click(screen.getByTestId("interact-retry"));
    expect(await screen.findByTestId("poll-form")).toBeTruthy();
    expect(screen.queryByTestId("interact-load-error")).toBeNull();
  });
});

describe("/interact: polls", () => {
  it("validates the form and sends nothing out of bounds", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    await screen.findByTestId("poll-form");
    type("poll-title", "x".repeat(61));
    type("poll-choice-1", "Only one");
    type("poll-duration", "14");
    submit("poll-start");
    await waitFor(() => expect(screen.getByText(en["interact.poll.error.title"].replace("{max}", "60"))).toBeTruthy());
    expect(
      screen.getByText(en["interact.poll.error.choices"].replace("{min}", "2").replace("{max}", "5")),
    ).toBeTruthy();
    expect(m.interact.polls.create).not.toHaveBeenCalled();
  });

  it("adds choices up to five and sends the payload", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    await screen.findByTestId("poll-form");
    for (let i = 0; i < 3; i++) fireEvent.click(id("poll-add-choice"));
    expect(screen.getByTestId("poll-choice-5")).toBeTruthy();
    expect(screen.queryByTestId("poll-add-choice")).toBeNull();
    type("poll-title", "Best map?");
    type("poll-choice-1", "Dust");
    type("poll-choice-2", "Mirage");
    type("poll-choice-3", "Inferno");
    type("poll-duration", "20");
    type("poll-extra-cost", "0");
    submit("poll-start");
    await waitFor(() => expect(m.interact.polls.create).toHaveBeenCalledTimes(1));
    expect(m.interact.polls.create).toHaveBeenCalledWith({
      channel: "ann",
      title: "Best map?",
      choices: ["Dust", "Mirage", "Inferno"],
      durationSeconds: 20,
      pointsPerExtraVote: 0,
    });
    const live = await screen.findByTestId("poll-live");
    expect(live.dataset.status).toBe("active");
    // A running poll replaces the form.
    expect(screen.queryByTestId("poll-form")).toBeNull();
  });

  it("refreshes the counts while active, then shows the result with archive", async () => {
    const { client, m } = fakeApi();
    m.interact.polls.current
      .mockResolvedValueOnce(poll())
      .mockResolvedValueOnce(
        poll({
          choices: [
            { id: "c1", title: "Dust", votes: 3 },
            { id: "c2", title: "Mirage", votes: 1 },
            { id: "c3", title: "Inferno", votes: 0 },
          ],
        }),
      )
      .mockResolvedValue(poll({ status: "completed", endedAt: "2026-10-29T10:01:00.000Z" }));
    renderInteract(client);
    const live = await screen.findByTestId("poll-live");
    expect(live.dataset.pollId).toBe(poll().id);
    expect(live.dataset.endsAt).toBe(FAR);
    const votes = () => screen.getAllByTestId("poll-live-choice").map((c) => [c.dataset.choiceId, c.dataset.votes]);
    expect(votes()).toEqual([
      ["c1", "2"],
      ["c2", "1"],
      ["c3", "0"],
    ]);
    await waitFor(() => expect(screen.getByTestId("poll-live").dataset.status).toBe("completed"));
    expect(screen.queryByTestId("poll-end")).toBeNull();
    expect(screen.getByTestId("poll-archive")).toBeTruthy();
    expect(screen.getByTestId("poll-form")).toBeTruthy();
    const polledAfterEnd = m.interact.polls.current.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(m.interact.polls.current.mock.calls.length).toBe(polledAfterEnd);

    fireEvent.click(id("poll-archive"));
    await waitFor(() => expect(screen.queryByTestId("poll-live")).toBeNull());
    expect(m.interact.polls.end).toHaveBeenCalledWith({ id: poll().id, status: "archived" });
  });

  it("ends a poll only after the confirmation", async () => {
    const { client, m } = fakeApi();
    m.interact.polls.current.mockResolvedValue(poll());
    renderInteract(client);
    fireEvent.click(await screen.findByTestId("poll-end"));
    expect(await screen.findByText(en["interact.poll.endTitle"])).toBeTruthy();
    expect(m.interact.polls.end).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(m.interact.polls.end).toHaveBeenCalledWith({ id: poll().id, status: "terminated" }));
  });
});

describe("/interact: predictions", () => {
  it("validates and sends the payload", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    await screen.findByTestId("prediction-form");
    type("prediction-title", "x".repeat(46));
    type("prediction-outcome-1", "A");
    submit("prediction-start");
    await waitFor(() =>
      expect(screen.getByText(en["interact.prediction.error.title"].replace("{max}", "45"))).toBeTruthy(),
    );
    expect(m.interact.predictions.create).not.toHaveBeenCalled();
    fireEvent.click(id("prediction-add-outcome"));
    type("prediction-title", "Who wins?");
    type("prediction-outcome-2", "B");
    type("prediction-outcome-3", "Draw");
    type("prediction-window", "30");
    submit("prediction-start");
    await waitFor(() =>
      expect(m.interact.predictions.create).toHaveBeenCalledWith({
        channel: "ann",
        title: "Who wins?",
        outcomes: ["A", "B", "Draw"],
        windowSeconds: 30,
      }),
    );
  });

  it("locks, then resolves after a confirmation naming the outcome, then shows payouts", async () => {
    const { client, m } = fakeApi();
    m.interact.predictions.current.mockResolvedValue(prediction());
    renderInteract(client);
    const live = await screen.findByTestId("prediction-live");
    expect(live.dataset.locksAt).toBe(FAR);
    expect(
      screen
        .getAllByTestId("prediction-live-outcome")
        .map((o) => [o.dataset.outcomeId, o.dataset.points, o.dataset.users]),
    ).toEqual([
      ["oa", "400", "2"],
      ["ob", "200", "1"],
    ]);
    expect(screen.queryByTestId("prediction-resolve-oa")).toBeNull();
    m.interact.predictions.current.mockResolvedValue(prediction({ status: "locked" }));
    fireEvent.click(id("prediction-lock"));
    await waitFor(() => expect(screen.getByTestId("prediction-live").dataset.status).toBe("locked"));
    expect(screen.queryByTestId("prediction-lock")).toBeNull();

    fireEvent.click(id("prediction-resolve-oa"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Team A");
    expect(m.interact.predictions.resolve).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() =>
      expect(m.interact.predictions.resolve).toHaveBeenCalledWith({ id: prediction().id, winningOutcomeId: "oa" }),
    );
    m.interact.predictions.current.mockResolvedValue(prediction({ status: "resolved", winningOutcomeId: "oa" }));
    await waitFor(() => expect(screen.getByTestId("prediction-live").dataset.status).toBe("resolved"));
    const [won, lost] = screen.getAllByTestId("prediction-live-outcome");
    expect(won?.textContent).toContain("Paid out 600 points to 2 viewers");
    expect(lost?.textContent).toContain(en["interact.prediction.payout.lost"]);
    expect(screen.queryByTestId("prediction-cancel")).toBeNull();
    expect(screen.getByTestId("prediction-form")).toBeTruthy();
  });

  it("cancels only after the confirmation and shows refunds", async () => {
    const { client, m } = fakeApi();
    m.interact.predictions.current.mockResolvedValue(prediction({ status: "locked" }));
    renderInteract(client);
    fireEvent.click(await screen.findByTestId("prediction-cancel"));
    await screen.findByText(en["interact.prediction.cancelTitle"]);
    expect(m.interact.predictions.cancel).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(m.interact.predictions.cancel).toHaveBeenCalledWith({ id: prediction().id }));
    m.interact.predictions.current.mockResolvedValue(prediction({ status: "canceled" }));
    await waitFor(() => expect(screen.getByTestId("prediction-live").dataset.status).toBe("canceled"));
    expect(screen.getAllByTestId("prediction-live-outcome")[0]?.textContent).toContain("Refunded 400 points");
  });
});

describe("/interact: raids", () => {
  it.each([
    [apiError("PRECONDITION_FAILED", { requirement: "raid_refused" }), "raid_refused", "interact.raid.error.refused"],
    [
      apiError("PRECONDITION_FAILED", { requirement: "raid_cooldown" }),
      "raid_cooldown",
      "interact.raid.error.cooldown",
    ],
    [
      apiError("PRECONDITION_FAILED", { requirement: "raid_target_offline" }),
      "raid_target_offline",
      "interact.raid.error.targetOffline",
    ],
    [apiError("CONFLICT"), "raid_pending", "interact.raid.error.pending"],
    [apiError("NOT_FOUND"), "raid_not_found", "interact.raid.error.notFound"],
  ] as const)("shows a refusal with its code (%#)", async (error, code, key) => {
    const { client, m } = fakeApi();
    m.interact.raids.start.mockRejectedValueOnce(error);
    renderInteract(client);
    await screen.findByTestId("raid-form");
    type("raid-target", "Bob");
    submit("raid-start");
    const shown = await screen.findByTestId("raid-error");
    expect(shown.dataset.code).toBe(code);
    expect(shown.textContent).toBe(en[key]);
    expect(m.interact.raids.start).toHaveBeenCalledWith({ channel: "ann", to: "bob" });
  });

  it("shows a raid started elsewhere (raid_pending) with its cancel button", async () => {
    const { client, m } = fakeApi();
    m.interact.raids.start.mockRejectedValueOnce(apiError("CONFLICT"));
    m.interact.raids.current.mockResolvedValueOnce(raidState()).mockResolvedValue(raidState({ raid: raid() }));
    renderInteract(client);
    await screen.findByTestId("raid-form");
    type("raid-target", "bob");
    submit("raid-start");
    expect((await screen.findByTestId("raid-pending")).dataset.to).toBe("bob");
    expect(screen.getByTestId("raid-cancel")).toBeTruthy();
  });

  it("checks the target before sending", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    await screen.findByTestId("raid-form");
    type("raid-target", "a b");
    submit("raid-start");
    expect(await screen.findByText(en["interact.raid.error.target"])).toBeTruthy();
    expect(m.interact.raids.start).not.toHaveBeenCalled();
  });

  it("counts down a started raid, then shows the last raid and the cooldown", async () => {
    const { client, m } = fakeApi();
    const until = new Date(Date.now() + 600_000).toISOString();
    m.interact.raids.current
      .mockResolvedValueOnce(raidState())
      .mockResolvedValueOnce(raidState({ raid: raid() }))
      .mockResolvedValue(raidState({ raid: raid({ status: "completed", viewerCount: 7 }), cooldownEndsAt: until }));
    renderInteract(client);
    await screen.findByTestId("raid-form");
    type("raid-target", "bob");
    submit("raid-start");
    const pending = await screen.findByTestId("raid-pending");
    expect(pending.dataset.to).toBe("bob");
    expect(pending.dataset.executeAt).toBe(FAR);
    expect(screen.queryByTestId("raid-form")).toBeNull();
    const last = await screen.findByTestId("raid-last");
    expect(last.dataset.status).toBe("completed");
    expect(last.dataset.viewers).toBe("7");
    expect(last.dataset.cancelReason).toBe("");
    expect(screen.getByTestId("raid-cooldown").dataset.until).toBe(until);
    expect(screen.getByTestId("raid-form")).toBeTruthy();
  });

  it("cancels a pending raid", async () => {
    const { client, m } = fakeApi();
    m.interact.raids.current
      .mockResolvedValueOnce(raidState({ raid: raid() }))
      .mockResolvedValue(raidState({ raid: raid({ status: "canceled", cancelReason: "owner" }) }));
    renderInteract(client);
    fireEvent.click(await screen.findByTestId("raid-cancel"));
    await waitFor(() => expect(screen.getByTestId("raid-last").dataset.cancelReason).toBe("owner"));
    expect(m.interact.raids.cancel).toHaveBeenCalledWith({ channel: "ann" });
  });

  it("saves the raid policy on change", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    await screen.findByTestId("raid-policy");
    await pick("raid-policy", "raid-policy-off", ["raid-policy-anyone", "raid-policy-followed"]);
    await waitFor(() => expect(m.interact.raids.setPolicy).toHaveBeenCalledWith({ channel: "ann", policy: "off" }));
  });
});

describe("/interact: goals", () => {
  it("sends a tips target in minor units", async () => {
    const { client, m } = fakeApi();
    renderInteract(client);
    await screen.findByTestId("goal-form");
    await pick("goal-type", "goal-type-tips", ["goal-type-followers", "goal-type-subscriptions"]);
    type("goal-title", "New mic");
    type("goal-target", "12.50");
    submit("goal-start");
    await waitFor(() =>
      expect(m.interact.goals.create).toHaveBeenCalledWith({
        channel: "ann",
        type: "tips",
        title: "New mic",
        target: 1250,
      }),
    );
    const row = await screen.findByTestId("goal-row");
    expect(row.dataset.type).toBe("tips");
    expect(row.dataset.target).toBe("1250");
    expect(row.textContent).toContain("$12.50");
    expect(row.textContent).toContain("$0.00 / $12.50");
  });

  it("validates a follower target and lists goals with their numbers", async () => {
    const { client, m } = fakeApi();
    m.interact.goals.list.mockResolvedValue([
      goal(),
      goal({ id: "g2", current: 2, endedAt: "2026-10-29T11:00:00.000Z" }),
    ]);
    renderInteract(client);
    await screen.findByTestId("goal-form");
    type("goal-title", "Follows");
    type("goal-target", "2.5");
    submit("goal-start");
    expect(await screen.findByText(en["interact.goal.error.count"])).toBeTruthy();
    expect(m.interact.goals.create).not.toHaveBeenCalled();
    const rows = screen.getAllByTestId("goal-row");
    expect(rows.map((r) => [r.dataset.current, r.dataset.target, r.dataset.ended])).toEqual([
      ["1", "2", "false"],
      ["2", "2", "true"],
    ]);
    expect(within(rows[1] as HTMLElement).queryByTestId("goal-end")).toBeNull();
  });

  it("ends a goal after the confirmation", async () => {
    const { client, m } = fakeApi();
    m.interact.goals.list.mockResolvedValue([goal()]);
    renderInteract(client);
    fireEvent.click(await screen.findByTestId("goal-end"));
    await screen.findByRole("alertdialog");
    expect(m.interact.goals.end).not.toHaveBeenCalled();
    m.interact.goals.list.mockResolvedValue([goal({ endedAt: "2026-10-29T11:00:00.000Z" })]);
    await confirm();
    await waitFor(() => expect(screen.getByTestId("goal-row").dataset.ended).toBe("true"));
    expect(m.interact.goals.end).toHaveBeenCalledWith({ channel: "ann", id: goal().id });
  });
});

describe("/interact: roles", () => {
  it("a moderator gets polls, predictions and the goal list, without raids or goal changes", async () => {
    const { client, m } = fakeApi();
    m.channels.roles.list.mockResolvedValue([{ user: { id: ME.id }, role: "moderator", grantedAt: "x" }]);
    m.interact.goals.list.mockResolvedValue([goal()]);
    renderInteract(client, { channel: "bob" });
    expect(await screen.findByTestId("poll-form")).toBeTruthy();
    expect(screen.getByTestId("prediction-form")).toBeTruthy();
    expect(screen.getByTestId("goal-row")).toBeTruthy();
    for (const t of ["raid-form", "raid-policy", "goal-form", "goal-end"]) expect(screen.queryByTestId(t)).toBeNull();
    expect(m.interact.raids.current).not.toHaveBeenCalled();
    expect(m.channels.roles.list).toHaveBeenCalledWith({ channel: "bob" });
  });

  it("an editor gets the owner's controls on another channel", async () => {
    const { client, m } = fakeApi();
    m.channels.roles.list.mockResolvedValue([{ user: { id: ME.id }, role: "editor", grantedAt: "x" }]);
    renderInteract(client, { channel: "bob" });
    expect(await screen.findByTestId("raid-form")).toBeTruthy();
    expect(screen.getByTestId("goal-form")).toBeTruthy();
  });

  it("no role, or a refused lookup, means no studio", async () => {
    const { client, m } = fakeApi();
    expect(await resolveStudioRole(client, ME, "bob")).toEqual({ role: null });
    m.channels.roles.list.mockRejectedValueOnce(apiError("FORBIDDEN"));
    expect(await resolveStudioRole(client, ME, "bob")).toEqual({ role: null });
    m.channels.roles.list.mockRejectedValueOnce(apiError("INTERNAL_SERVER_ERROR"));
    await expect(resolveStudioRole(client, ME, "bob")).rejects.toThrow("INTERNAL_SERVER_ERROR");
    expect(await resolveStudioRole(client, ME, "ann")).toEqual({ role: "owner" });
  });
});

// ── /bot ─────────────────────────────────────────────────────────────────────────────────────

function renderBot(client: StudioApi, channel = "ann") {
  return wrap(<BotStudio me={ME} channel={channel} client={client} />);
}

describe("/bot: settings", () => {
  it("saves every setting together and shows the account the first enable created", async () => {
    const { client, m } = fakeApi();
    renderBot(client);
    const account = await screen.findByTestId("bot-account");
    expect(account.dataset.username).toBe("");
    for (const t of [
      "bot-display-name",
      "bot-filter-spam",
      "bot-filter-links",
      "bot-filter-caps",
      "bot-filter-timeout",
      "bot-points-enabled",
      "bot-points-name",
      "bot-sr-enabled",
      "bot-sr-max",
    ])
      expect(screen.getByTestId(t)).toBeTruthy();
    fireEvent.click(id("bot-enabled"));
    fireEvent.click(id("bot-filter-spam"));
    fireEvent.click(id("bot-sr-enabled"));
    type("bot-display-name", "AnnBot");
    type("bot-sr-max", "10");
    type("bot-filter-timeout", "0");
    submit("bot-save");
    await waitFor(() => expect(m.bot.updateSettings).toHaveBeenCalledTimes(1));
    const sent = m.bot.updateSettings.mock.calls[0]?.[0];
    expect(sent).toEqual({
      channel: "ann",
      enabled: true,
      config: {
        displayName: "AnnBot",
        filters: {
          spam: { enabled: false, maxRepeatedChars: 12 },
          links: { enabled: false, allowSubscribers: true, allowlist: [] },
          caps: { enabled: false, minLength: 15, maxRatio: 0.7 },
          timeoutSeconds: 0,
        },
        loyalty: { enabled: true, pointsName: "points" },
        songRequests: { enabled: true, maxQueue: 10 },
      },
    });
    await waitFor(() => expect(screen.getByTestId("bot-account").dataset.username).toBe("annbot"));
    expect(screen.getByText(en["bot.settings.createdTitle"])).toBeTruthy();
  });

  it("refuses out-of-range values before sending", async () => {
    const { client, m } = fakeApi();
    renderBot(client);
    await screen.findByTestId("bot-settings");
    type("bot-sr-max", "201");
    type("bot-points-name", "");
    submit("bot-save");
    expect(
      await screen.findByText(en["bot.settings.error.srMax"].replace("{min}", "1").replace("{max}", "200")),
    ).toBeTruthy();
    expect(m.bot.updateSettings).not.toHaveBeenCalled();
  });

  it("shows the load error and retries", async () => {
    const { client, m } = fakeApi();
    m.bot.commands.list.mockRejectedValueOnce(new Error("down"));
    renderBot(client);
    await screen.findByTestId("bot-load-error");
    fireEvent.click(id("bot-retry"));
    expect(await screen.findByTestId("bot-settings")).toBeTruthy();
  });

  it("a moderator gets everything but the settings", async () => {
    const { client, m } = fakeApi();
    m.channels.roles.list.mockResolvedValue([{ user: { id: ME.id }, role: "moderator", grantedAt: "x" }]);
    renderBot(client, "bob");
    expect(await screen.findByTestId("command-new")).toBeTruthy();
    for (const t of ["timer-new", "variable-form", "points-leaderboard", "points-adjust-open", "sr-empty"])
      expect(screen.getByTestId(t)).toBeTruthy();
    expect(screen.queryByTestId("bot-settings")).toBeNull();
    expect(m.bot.settings).not.toHaveBeenCalled();
  });
});

describe("/bot: commands", () => {
  const hello = {
    id: "cmd0",
    name: "hello",
    aliases: [],
    response: "Hi ${user}!",
    userLevel: "everyone",
    cooldownSeconds: 30,
    costPoints: 0,
    enabled: true,
    useCount: 4,
  };

  it("creates a command in the dialog with the level and the numbers", async () => {
    const { client, m } = fakeApi();
    renderBot(client);
    expect(await screen.findByTestId("command-empty")).toBeTruthy();
    fireEvent.click(id("command-new"));
    await screen.findByTestId("command-form");
    type("command-name", "!ModCheck");
    type("command-aliases", "mc, check");
    type("command-response", "moderators only");
    type("command-cooldown", "0");
    type("command-cost", "50");
    await pick("command-level", "command-level-moderator");
    fireEvent.click(id("command-enabled"));
    submit("command-save");
    await waitFor(() =>
      expect(m.bot.commands.upsert).toHaveBeenCalledWith({
        channel: "ann",
        name: "modcheck",
        aliases: ["mc", "check"],
        response: "moderators only",
        userLevel: "moderator",
        cooldownSeconds: 0,
        costPoints: 50,
        enabled: false,
      }),
    );
    const row = await screen.findByTestId("command-row");
    expect([row.dataset.name, row.dataset.uses, row.dataset.enabled, row.dataset.cost]).toEqual([
      "modcheck",
      "0",
      "false",
      "50",
    ]);
    expect(screen.queryByTestId("command-empty")).toBeNull();
  });

  it("refuses a built-in name and shows a server refusal in command-error", async () => {
    const { client, m } = fakeApi();
    renderBot(client);
    fireEvent.click(await screen.findByTestId("command-new"));
    await screen.findByTestId("command-form");
    type("command-name", "points");
    type("command-response", "x");
    submit("command-save");
    expect(await screen.findByText(en["bot.command.error.builtin"])).toBeTruthy();
    expect(m.bot.commands.upsert).not.toHaveBeenCalled();
    m.bot.commands.upsert.mockRejectedValueOnce(apiError("CONFLICT"));
    type("command-name", "taken");
    submit("command-save");
    const error = await screen.findByTestId("command-error");
    expect(error.textContent).toBe(en["bot.command.error.conflict"]);
  });

  it("refuses a new command named like an existing one instead of overwriting it", async () => {
    const { client, m } = fakeApi();
    m.bot.commands.list.mockResolvedValue([hello]);
    renderBot(client);
    fireEvent.click(await screen.findByTestId("command-new"));
    await screen.findByTestId("command-form");
    type("command-name", "!Hello");
    type("command-response", "replaced");
    submit("command-save");
    expect(await screen.findByText(en["bot.command.error.exists"].replace("{name}", "hello"))).toBeTruthy();
    expect(m.bot.commands.upsert).not.toHaveBeenCalled();
  });

  it("edits with the name fixed and removes after a confirmation", async () => {
    const { client, m } = fakeApi();
    m.bot.commands.list.mockResolvedValue([hello]);
    renderBot(client);
    fireEvent.click(await screen.findByTestId("command-edit"));
    const name = (await screen.findByTestId("command-name")) as HTMLInputElement;
    expect(name.value).toBe("hello");
    expect(name.disabled).toBe(true);
    expect((screen.getByTestId("command-cooldown") as HTMLInputElement).value).toBe("30");
    fireEvent.keyDown(name, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("command-form")).toBeNull());

    fireEvent.click(id("command-remove"));
    await screen.findByRole("alertdialog");
    expect(m.bot.commands.remove).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(screen.queryByTestId("command-row")).toBeNull());
    expect(m.bot.commands.remove).toHaveBeenCalledWith({ channel: "ann", name: "hello" });
  });

  it("lists the template variables", async () => {
    const { client } = fakeApi();
    renderBot(client);
    await screen.findByTestId("command-empty");
    for (const token of ["${user}", "${touser}", "${count}", "${var:name}"])
      expect(screen.getByText(token)).toBeTruthy();
  });
});

describe("/bot: timers, variables, song requests and points", () => {
  it("creates a timer", async () => {
    const { client, m } = fakeApi();
    renderBot(client);
    expect(await screen.findByTestId("timer-empty")).toBeTruthy();
    fireEvent.click(id("timer-new"));
    await screen.findByTestId("timer-form");
    type("timer-name", "Follow");
    type("timer-message", "Follow ${channel}!");
    type("timer-interval", "1");
    type("timer-min-lines", "0");
    submit("timer-save");
    expect(
      await screen.findByText(en["bot.timer.error.minLines"].replace("{min}", "1").replace("{max}", "1000")),
    ).toBeTruthy();
    type("timer-min-lines", "3");
    submit("timer-save");
    await waitFor(() =>
      expect(m.bot.timers.upsert).toHaveBeenCalledWith({
        channel: "ann",
        name: "Follow",
        message: "Follow ${channel}!",
        intervalMinutes: 1,
        minChatLines: 3,
        enabled: true,
      }),
    );
    const row = await screen.findByTestId("timer-row");
    expect([row.dataset.timerId, row.dataset.enabled]).toEqual(["t1", "true"]);
    expect(screen.getByTestId("timer-edit")).toBeTruthy();
    expect(screen.getByTestId("timer-remove")).toBeTruthy();
  });

  it("sets a variable", async () => {
    const { client, m } = fakeApi();
    renderBot(client);
    await screen.findByTestId("variable-form");
    type("variable-name", "schedule");
    type("variable-value", "Mon 8pm");
    submit("variable-save");
    await waitFor(() =>
      expect(m.bot.variables.set).toHaveBeenCalledWith({ channel: "ann", name: "schedule", value: "Mon 8pm" }),
    );
    expect((await screen.findByTestId("variable-row")).dataset.name).toBe("schedule");
  });

  it("lists song requests as links that are never embedded, and marks them", async () => {
    const { client, m } = fakeApi();
    m.bot.songRequests.list.mockResolvedValue([
      {
        id: "s1",
        url: "https://example.org/song",
        requester: "v1",
        status: "queued",
        createdAt: "2026-10-29T10:00:00.000Z",
      },
      { id: "s2", url: "not-a-link", requester: "v2", status: "queued", createdAt: "2026-10-29T10:01:00.000Z" },
    ]);
    renderBot(client);
    const rows = await screen.findAllByTestId("sr-row");
    const link = within(rows[0] as HTMLElement).getByRole("link");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link.getAttribute("href")).toBe("https://example.org/song");
    expect(within(rows[1] as HTMLElement).queryByRole("link")).toBeNull();
    expect(document.querySelector("iframe, audio, video, embed, object")).toBeNull();
    fireEvent.click(within(rows[0] as HTMLElement).getByTestId("sr-played"));
    await waitFor(() =>
      expect(m.bot.songRequests.setStatus).toHaveBeenCalledWith({ channel: "ann", id: "s1", status: "played" }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("sr-row").find((r) => r.dataset.id === "s1")?.dataset.status).toBe("played"),
    );
    fireEvent.click(within(screen.getAllByTestId("sr-row")[0] as HTMLElement).getByTestId("sr-skip"));
    await waitFor(() =>
      expect(m.bot.songRequests.setStatus).toHaveBeenCalledWith({ channel: "ann", id: "s2", status: "skipped" }),
    );
  });

  it("shows the leaderboard and insufficient_points inline on adjust", async () => {
    const { client, m } = fakeApi();
    m.bot.points.leaderboard.mockResolvedValue([
      { channelSlug: "ann", user: { id: "u1", username: "viewer1" }, points: 450, pointsName: "beans", enabled: true },
    ]);
    renderBot(client);
    const row = await screen.findByTestId("points-row");
    expect([row.dataset.username, row.dataset.points]).toEqual(["viewer1", "450"]);
    fireEvent.click(id("points-adjust-open"));
    await screen.findByTestId("points-adjust");
    type("points-adjust-user", "viewer1");
    type("points-adjust-delta", "-500");
    await pick("points-adjust-reason", "points-adjust-reason-penalty");
    m.bot.points.adjust.mockRejectedValueOnce(apiError("PRECONDITION_FAILED", { requirement: "insufficient_points" }));
    submit("points-adjust-submit");
    expect(await screen.findByText(en["bot.points.error.insufficient"])).toBeTruthy();
    expect(m.bot.points.adjust).toHaveBeenCalledWith({
      channel: "ann",
      username: "viewer1",
      delta: -500,
      reason: "penalty",
    });
    type("points-adjust-delta", "100");
    await act(async () => {
      submit("points-adjust-submit");
    });
    await waitFor(() => expect(screen.queryByTestId("points-adjust")).toBeNull());
    expect(m.bot.points.leaderboard).toHaveBeenCalledTimes(2);
  });
});
