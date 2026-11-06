// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `RehearsePage` (W2-rehearsal), the owner's container, against a fake API: the first load, a
 * report that is NOT_FOUND (no rehearsal yet), a failed poll and its recovery on the next 5 s
 * tick, no second request while one is in flight, the countdown, the key reminder and follower
 * suggestions, and each action's success and refusal toasts.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RehearsalReport, RehearsalStatus } from "@commonair/contracts/dto";
import { MAX_INVITEES, REHEARSAL_POLL_MS } from "../src/components/rehearsal/lib.ts";
import { RehearsePage } from "../src/components/rehearsal/page.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (m: string) => toasts.success.push(m),
    error: (m: string) => toasts.error.push(m),
  },
}));

type Call<I> = (input: I) => Promise<unknown>;
type In = { channel: string };
type InviteIn = { channel: string; username: string; remove: boolean };
type FollowersIn = { channel: string; limit: number };
type Fn<I, O> = ReturnType<typeof vi.fn<(input: I) => Promise<O>>>;
const fake = vi.hoisted(() => ({
  status: null as unknown as Fn<{ channel: string }, unknown>,
  report: null as unknown as Fn<{ channel: string }, unknown>,
  arm: null as unknown as Fn<{ channel: string }, unknown>,
  disarm: null as unknown as Fn<{ channel: string }, unknown>,
  invite: null as unknown as Fn<{ channel: string; username: string; remove: boolean }, unknown>,
  ingest: null as unknown as Fn<{ channel: string }, unknown>,
  followers: null as unknown as Fn<{ channel: string; limit: number }, unknown>,
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api.ts")>()),
  api: () => ({
    stream: {
      ingest: (i: { channel: string }) => fake.ingest(i),
      rehearsal: {
        status: (i: { channel: string }) => fake.status(i),
        report: (i: { channel: string }) => fake.report(i),
        arm: (i: { channel: string }) => fake.arm(i),
        disarm: (i: { channel: string }) => fake.disarm(i),
        invite: (i: { channel: string; username: string; remove: boolean }) => fake.invite(i),
        // The player is only drawn while rehearsing; it never answers here.
        watch: () => new Promise(() => undefined),
      },
    },
    channels: { followers: (i: { channel: string; limit: number }) => fake.followers(i) },
  }),
}));

const NOW = Date.parse("2026-11-01T12:00:00Z");
const ARM = "01900000-0000-7000-8000-0000000000a1";
const B = "01900000-0000-7000-8000-0000000000b1";
const invitee = (n: number) => ({
  id: `01900000-0000-7000-8000-00000000000${n}`,
  username: `fan${n}`,
  displayName: `Fan ${n}`,
});
const idle: RehearsalStatus = {
  state: "idle",
  armId: null,
  armExpiresAt: null,
  broadcastId: null,
  endsAt: null,
  invitees: [],
};
const armed = (over: Partial<RehearsalStatus> = {}): RehearsalStatus => ({
  state: "armed",
  armId: ARM,
  armExpiresAt: new Date(NOW + 10 * 60_000).toISOString(),
  broadcastId: null,
  endsAt: null,
  invitees: [],
  ...over,
});
const zero = { wordFilter: 0, link: 0, duplicate: 0, rateLimit: 0, other: 0 };
const report: RehearsalReport = {
  broadcastId: B,
  startedAt: new Date(NOW - 5 * 60_000).toISOString(),
  endedAt: new Date(NOW - 60_000).toISOString(),
  endReason: "publisher_ended",
  chat: { accepted: 3, held: zero, rejected: zero },
  ingest: [],
  moderation: { samples: 0, flagged: false },
  inviteesWatched: [],
  updatedAt: new Date(NOW).toISOString(),
};
const refusal = (code: string, requirement?: string) =>
  Object.assign(new Error(code), { code, data: requirement ? { requirement } : {} });
const notFound = () => Object.assign(new Error("none"), { code: "NOT_FOUND" });

beforeEach(() => {
  toasts.success.length = 0;
  toasts.error.length = 0;
  fake.status = vi.fn<Call<In>>(async () => idle);
  fake.report = vi.fn<Call<In>>(async () => {
    throw notFound();
  });
  fake.arm = vi.fn<Call<In>>(async () => armed());
  fake.disarm = vi.fn<Call<In>>(async () => idle);
  fake.invite = vi.fn<Call<InviteIn>>(async () => armed());
  fake.ingest = vi.fn<Call<In>>(async () => ({ activeKeyPrefix: "ca_live_ab12" }));
  fake.followers = vi.fn<Call<FollowersIn>>(async () => ({
    items: [
      { user: { username: "fan1" }, excluded: false },
      { user: { username: "blocked" }, excluded: true },
      { user: { username: "fan2" }, excluded: false },
    ],
    nextCursor: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(channel = "ada") {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RehearsePage channel={channel} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}
const statusBadge = () => screen.getByTestId("rehearsal-status");
/** Lets pending promise callbacks run (fake timers leave microtasks alone). */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const confirm = () =>
  waitFor(() => {
    const b = document.querySelector<HTMLElement>('[data-testid="confirm-dialog-confirm"]');
    if (!b) throw new Error("no confirm dialog");
    return b;
  });

describe("loading", () => {
  it("reads status, report, ingest key and followers for the channel; NOT_FOUND means no report", async () => {
    mount();
    await waitFor(() => expect(statusBadge().dataset.state).toBe("idle"));
    expect(fake.status).toHaveBeenCalledWith({ channel: "ada" });
    expect(fake.report).toHaveBeenCalledWith({ channel: "ada" });
    expect(fake.ingest).toHaveBeenCalledWith({ channel: "ada" });
    expect(fake.followers).toHaveBeenCalledWith({ channel: "ada", limit: 50 });
    expect(screen.queryByTestId("rehearsal-report")).toBeNull();
    expect(screen.queryByText(t("rehearsal.loadFailed"))).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("rehearsal-key-reminder").textContent).toContain(
        t("rehearsal.key.reminder", { prefix: "ca_live_ab12" }),
      ),
    );
  });

  it("shows the report when there is one", async () => {
    fake.report = vi.fn<Call<In>>(async () => report);
    mount();
    await waitFor(() => expect(screen.getByTestId("rehearsal-report")).toBeTruthy());
    expect(screen.queryByText(t("rehearsal.loadFailed"))).toBeNull();
  });

  it("a key lookup that fails says there is no key, with the dashboard link", async () => {
    fake.ingest = vi.fn<Call<In>>(async () => {
      throw new Error("down");
    });
    fake.followers = vi.fn<Call<FollowersIn>>(async () => {
      throw new Error("down");
    });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("rehearsal-key-reminder").textContent).toContain(t("rehearsal.key.none")),
    );
    expect(screen.getByTestId("rehearsal-key-reminder").textContent).toContain(t("rehearsal.key.dashboard"));
  });

  it("armed: follower suggestions leave out excluded followers and those already invited", async () => {
    fake.status = vi.fn<Call<In>>(async () => armed({ invitees: [invitee(1)] }));
    mount();
    await waitFor(() => expect(statusBadge().dataset.state).toBe("armed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "fan2" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "fan1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "blocked" })).toBeNull();
    // The watch link points invitees at this channel's watch view on this origin.
    expect(document.body.textContent).toContain(`${window.location.origin}/rehearse?channel=ada`);
  });

  it("a report error other than NOT_FOUND fails the load; the next poll recovers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fake.report = vi
      .fn<Call<In>>()
      .mockRejectedValueOnce(refusal("INTERNAL_SERVER_ERROR"))
      .mockRejectedValue(notFound());
    mount();
    await settle();
    expect(screen.getByText(t("rehearsal.loadFailed"))).toBeTruthy();
    expect(screen.queryByTestId("rehearsal-status")).toBeNull();
    await tick(REHEARSAL_POLL_MS);
    await settle();
    expect(screen.queryByText(t("rehearsal.loadFailed"))).toBeNull();
    expect(statusBadge().dataset.state).toBe("idle");
    expect(fake.status).toHaveBeenCalledTimes(2);
  });

  it("polls every 5 s but never sends a second request while one is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release: (s: RehearsalStatus) => void = () => undefined;
    fake.status = vi
      .fn<Call<In>>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValue(armed());
    mount();
    await settle();
    expect(fake.status).toHaveBeenCalledTimes(1);
    await tick(REHEARSAL_POLL_MS * 2);
    expect(fake.status).toHaveBeenCalledTimes(1);
    await act(async () => release(idle));
    await settle();
    expect(statusBadge().dataset.state).toBe("idle");
    await tick(REHEARSAL_POLL_MS);
    await settle();
    expect(fake.status).toHaveBeenCalledTimes(2);
    expect(statusBadge().dataset.state).toBe("armed");
  });

  it("the countdown ticks every second between polls", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    fake.status = vi.fn<Call<In>>(async () => armed());
    mount();
    await settle();
    expect(statusBadge().dataset.remainingSeconds).toBe("600");
    await tick(3_000);
    expect(statusBadge().dataset.remainingSeconds).toBe("597");
  });
});

describe("actions", () => {
  it("arm: the new status and a success toast", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("rehearsal-arm"));
    await waitFor(() => expect(statusBadge().dataset.state).toBe("armed"));
    expect(fake.arm).toHaveBeenCalledWith({ channel: "ada" });
    expect(toasts.success).toEqual([t("rehearsal.armed")]);
  });

  it.each([
    ["live", "rehearsal.refusal.live"],
    ["suspended", "rehearsal.refusal.suspended"],
    [undefined, "rehearsal.armFailed"],
  ] as const)("arm refused (%s): the refusal toast, still idle", async (requirement, key) => {
    fake.arm = vi.fn<Call<In>>(async () => {
      throw requirement ? refusal("PRECONDITION_FAILED", requirement) : new Error("down");
    });
    mount();
    fireEvent.click(await screen.findByTestId("rehearsal-arm"));
    await waitFor(() => expect(toasts.error).toEqual([t(key)]));
    expect(statusBadge().dataset.state).toBe("idle");
    expect(toasts.success).toEqual([]);
  });

  it("disarm: asks first, then the new status, a toast, and a fresh load", async () => {
    fake.status = vi.fn<Call<In>>().mockResolvedValueOnce(armed()).mockResolvedValue(idle);
    mount();
    fireEvent.click(await screen.findByTestId("rehearsal-disarm"));
    expect(fake.disarm).not.toHaveBeenCalled();
    fireEvent.click(await confirm());
    await waitFor(() => expect(toasts.success).toEqual([t("rehearsal.disarmed")]));
    expect(fake.disarm).toHaveBeenCalledWith({ channel: "ada" });
    await waitFor(() => expect(fake.status).toHaveBeenCalledTimes(2));
    expect(statusBadge().dataset.state).toBe("idle");
  });

  it("a failed disarm toasts and keeps the dialog open", async () => {
    fake.status = vi.fn<Call<In>>(async () => armed());
    fake.disarm = vi.fn<Call<In>>(async () => {
      throw new Error("down");
    });
    mount();
    fireEvent.click(await screen.findByTestId("rehearsal-disarm"));
    fireEvent.click(await confirm());
    await waitFor(() => expect(toasts.error).toEqual([t("rehearsal.disarmFailed")]));
    expect(document.querySelector('[data-testid="rehearsal-disarm-confirm"]')).not.toBeNull();
    expect(statusBadge().dataset.state).toBe("armed");
  });

  it("invite: sends the lowercased name, toasts, shows the invitee and clears the input", async () => {
    fake.status = vi.fn<Call<In>>(async () => armed());
    fake.invite = vi.fn<Call<InviteIn>>(async () => armed({ invitees: [invitee(3)] }));
    mount();
    const input = (await screen.findByTestId("rehearsal-invitee-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: " Fan3 " } });
    fireEvent.click(screen.getByTestId("rehearsal-invitee-add"));
    await waitFor(() => expect(toasts.success).toEqual([t("rehearsal.invitees.added", { username: "fan3" })]));
    expect(fake.invite).toHaveBeenCalledWith({ channel: "ada", username: "fan3", remove: false });
    expect(screen.getAllByTestId("rehearsal-invitee").map((li) => li.dataset.username)).toEqual(["fan3"]);
    expect(input.value).toBe("");
  });

  it.each([
    ["not_follower", "rehearsal.invitees.notFollower"],
    ["invitee_limit", "rehearsal.invitees.limit"],
    [undefined, "rehearsal.invitees.failed"],
  ] as const)("invite refused (%s): the refusal toast, and the name stays", async (requirement, key) => {
    fake.status = vi.fn<Call<In>>(async () => armed());
    fake.invite = vi.fn<Call<InviteIn>>(async () => {
      throw requirement ? refusal("PRECONDITION_FAILED", requirement) : new Error("down");
    });
    mount();
    const input = (await screen.findByTestId("rehearsal-invitee-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "stranger" } });
    fireEvent.click(screen.getByTestId("rehearsal-invitee-add"));
    await waitFor(() => expect(toasts.error).toEqual([t(key, { max: MAX_INVITEES })]));
    // The limit refusal names the number, never a raw placeholder.
    expect(toasts.error[0]).not.toContain("{");
    expect(input.value).toBe("stranger");
    // The refusal is handled: the button is usable again for a corrected name.
    expect((screen.getByTestId("rehearsal-invitee-add") as HTMLButtonElement).disabled).toBe(false);
    expect(toasts.success).toEqual([]);
  });

  it("remove: sends remove and shows the new list; a refusal toasts and keeps the list", async () => {
    fake.status = vi.fn<Call<In>>(async () => armed({ invitees: [invitee(1), invitee(2)] }));
    fake.invite = vi
      .fn<Call<InviteIn>>()
      .mockResolvedValueOnce(armed({ invitees: [invitee(2)] }))
      .mockRejectedValueOnce(refusal("PRECONDITION_FAILED", "not_armed"));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("rehearsal-invitee")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("rehearsal-invitee-remove")[0]!);
    await waitFor(() => expect(screen.getAllByTestId("rehearsal-invitee")).toHaveLength(1));
    expect(fake.invite).toHaveBeenLastCalledWith({ channel: "ada", username: "fan1", remove: true });
    fireEvent.click(screen.getByTestId("rehearsal-invitee-remove"));
    await waitFor(() => expect(toasts.error).toEqual([t("rehearsal.invitees.notArmed")]));
    expect(fake.invite).toHaveBeenLastCalledWith({ channel: "ada", username: "fan2", remove: true });
    expect(screen.getAllByTestId("rehearsal-invitee").map((li) => li.dataset.username)).toEqual(["fan2"]);
  });
});
