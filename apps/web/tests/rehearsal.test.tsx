// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The rehearse page (W2-rehearsal; docs/testing/w2-selectors.md "Rehearsal") rendered from its
 * panel with contract-shaped fixtures: idle, armed with the countdown, rehearsing with the player
 * slot and the live checklist, ended with the report, the invitee limit, and a 320 px column in
 * dark and light. Plus the pure helpers.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RehearsalReport, RehearsalStatus } from "@commonair/contracts/dto";
import {
  armErrorKey,
  checklist,
  dips,
  endedBy,
  inviteErrorKey,
  remainingSeconds,
  suggestions,
  viewState,
} from "../src/components/rehearsal/lib.ts";
import { RehearsalPanel, type RehearsalPanelProps } from "../src/components/rehearsal/panel.tsx";
import { playedBetween } from "../src/components/rehearsal/watch-player.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

afterEach(cleanup);

const NOW = Date.parse("2026-11-01T12:00:00Z");
const ARM = "01900000-0000-7000-8000-0000000000a1";
const B = "01900000-0000-7000-8000-0000000000b1";
const user = (n: number) => ({
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
  armExpiresAt: new Date(NOW + 9 * 60_000 + 30_000).toISOString(),
  broadcastId: null,
  endsAt: null,
  invitees: [],
  ...over,
});
const rehearsing = (over: Partial<RehearsalStatus> = {}): RehearsalStatus => ({
  ...armed(),
  state: "rehearsing",
  armExpiresAt: null,
  broadcastId: B,
  endsAt: new Date(NOW + 25 * 60_000).toISOString(),
  ...over,
});
const zero = { wordFilter: 0, link: 0, duplicate: 0, rateLimit: 0, other: 0 };
const report = (over: Partial<RehearsalReport> = {}): RehearsalReport => ({
  broadcastId: B,
  startedAt: new Date(NOW - 5 * 60_000).toISOString(),
  endedAt: null,
  endReason: null,
  chat: {
    accepted: 180,
    held: { ...zero, wordFilter: 4 },
    rejected: { ...zero, link: 15, duplicate: 20, rateLimit: 6 },
  },
  ingest: [
    { check: "bitrate", ok: false, dips: [{ at: new Date(NOW - 60_000).toISOString(), seconds: 10 }] },
    { check: "fps", ok: true, dips: [] },
    { check: "keyframe_interval", ok: true, dips: [] },
    { check: "dropped_frames", ok: true, dips: [] },
    { check: "audio", ok: true, dips: [] },
    { check: "video", ok: true, dips: [] },
  ],
  moderation: { samples: 0, flagged: false },
  inviteesWatched: [{ id: user(1).id, username: user(1).username }],
  updatedAt: new Date(NOW).toISOString(),
  ...over,
});

function panel(over: Partial<RehearsalPanelProps> = {}, theme: "dark" | "light" = "dark") {
  const fns = {
    onArm: vi.fn<() => Promise<void>>(async () => undefined),
    onDisarm: vi.fn<() => Promise<void>>(async () => undefined),
    onInvite: vi.fn<(username: string) => Promise<void>>(async () => undefined),
    onRemove: vi.fn<(username: string) => Promise<void>>(async () => undefined),
  };
  const props: RehearsalPanelProps = {
    status: idle,
    report: null,
    nowMs: NOW,
    keyPrefix: "ca_live_ab12",
    suggestions: [],
    loadFailed: false,
    channel: "streamer",
    watchHref: "https://example.test/rehearse?channel=streamer",
    player: <div data-testid="rehearsal-player" />,
    ...fns,
    ...over,
  };
  const r = render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <div className={theme === "dark" ? "dark w-80" : "w-80"} data-theme={theme}>
          <RehearsalPanel {...props} />
        </div>
      </TooltipProvider>
    </LocaleProvider>,
  );
  return { ...r, props: fns };
}
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: HTMLElement, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe("rehearse page states", () => {
  it("idle: the arm button, the key reminder (prefix only), no checklist or player", () => {
    const { container, props } = panel();
    expect(q(container, "rehearse-page")).not.toBeNull();
    expect(q(container, "rehearsal-status")?.dataset.state).toBe("idle");
    expect(q(container, "rehearsal-status")?.dataset.remainingSeconds).toBe("");
    const reminder = q(container, "rehearsal-key-reminder")!;
    expect(reminder.textContent).toContain("ca_live_ab12");
    expect(q(container, "rehearsal-disarm")).toBeNull();
    expect(q(container, "rehearsal-checklist")).toBeNull();
    expect(q(container, "rehearsal-player")).toBeNull();
    expect(q(container, "rehearsal-invitee-input")).toBeNull();
    fireEvent.click(q(container, "rehearsal-arm")!);
    expect(props.onArm).toHaveBeenCalledOnce();
  });

  it("without a key the reminder points to the dashboard", () => {
    const { container } = panel({ keyPrefix: null });
    expect(q(container, "rehearsal-key-reminder")?.textContent).toContain(t("rehearsal.key.none"));
  });

  it("armed: the countdown, disarm behind a confirm dialog, the invitee picker and a pending checklist", async () => {
    const { container, props } = panel({ status: armed(), suggestions: ["fan7", "fan8"] });
    const s = q(container, "rehearsal-status")!;
    expect(s.dataset.state).toBe("armed");
    expect(s.dataset.remainingSeconds).toBe("570");
    expect(s.textContent).toContain("9:30");
    expect(q(container, "rehearsal-arm")).toBeNull();
    expect(qa(container, "rehearsal-check").map((c) => c.dataset.state)).toEqual(Array(8).fill("pending"));
    expect(q(container, "rehearsal-checklist")?.getAttribute("aria-live")).toBe("polite");

    // A suggestion fills the input; the add button submits it.
    fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "fan7")!);
    expect((q(container, "rehearsal-invitee-input") as HTMLInputElement).value).toBe("fan7");
    fireEvent.click(q(container, "rehearsal-invitee-add")!);
    await waitFor(() => expect(props.onInvite).toHaveBeenCalledWith("fan7"));

    fireEvent.click(q(container, "rehearsal-disarm")!);
    const dialog = await waitFor(() => {
      const d = document.querySelector<HTMLElement>('[data-testid="rehearsal-disarm-confirm"]');
      if (!d) throw new Error("no dialog");
      return d;
    });
    fireEvent.click(dialog.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    await waitFor(() => expect(props.onDisarm).toHaveBeenCalledOnce());
  });

  it("rehearsing: the cap countdown, the player and a live checklist", () => {
    const { container } = panel({ status: rehearsing({ invitees: [user(1)] }), report: report() });
    const s = q(container, "rehearsal-status")!;
    expect(s.dataset.state).toBe("rehearsing");
    expect(s.dataset.remainingSeconds).toBe("1500");
    expect(q(container, "rehearsal-player")).not.toBeNull();
    const checks = Object.fromEntries(qa(container, "rehearsal-check").map((c) => [c.dataset.check, c.dataset.state]));
    expect(checks).toEqual({
      bitrate: "warn",
      fps: "ok",
      keyframe_interval: "ok",
      dropped_frames: "ok",
      audio: "ok",
      video: "ok",
      chat: "ok",
      moderation: "ok",
    });
    const inv = qa(container, "rehearsal-invitee");
    expect(inv.map((i) => i.dataset.username)).toEqual(["fan1"]);
    expect(q(container, "rehearsal-report")?.dataset.endedBy).toBe("");
  });

  it("ended: the report with chat counts, timed dips and who watched", () => {
    const { container } = panel({
      status: idle,
      report: report({ endedAt: new Date(NOW).toISOString(), endReason: "cap" }),
    });
    expect(q(container, "rehearsal-status")?.dataset.state).toBe("ended");
    expect(q(container, "rehearsal-arm")).not.toBeNull();
    const r = q(container, "rehearsal-report")!;
    expect(r.dataset.endedBy).toBe("cap");
    const chat = q(container, "rehearsal-report-chat")!;
    expect([chat.dataset.accepted, chat.dataset.held, chat.dataset.rejected]).toEqual(["180", "4", "41"]);
    expect(q(container, "rehearsal-report-ingest")?.dataset.dips).toBe("1");
    const dip = q(container, "rehearsal-report-dip")!;
    expect(dip.dataset.kind).toBe("bitrate");
    expect(dip.dataset.at).toBe(new Date(NOW - 60_000).toISOString());
    // Four minutes into the rehearsal, ten seconds long.
    expect(dip.textContent).toBe(t("rehearsal.report.dip.bitrate", { at: "4:00", seconds: "10" }));
    expect(r.textContent).toContain("fan1");
  });

  it("a safety end says only that", () => {
    const { container } = panel({
      report: report({ endedAt: new Date(NOW).toISOString(), endReason: "safety" }),
    });
    expect(q(container, "rehearsal-report")?.dataset.endedBy).toBe("safety");
    expect(q(container, "rehearsal-report-chat")).toBeNull();
    expect(q(container, "rehearsal-report-ingest")).toBeNull();
    expect(q(container, "rehearsal-report")?.textContent).toContain(t("rehearsal.report.safety"));
  });

  it("five invitees: the limit notice replaces the picker; each can be removed", () => {
    const five = [1, 2, 3, 4, 5].map(user);
    const { container, props } = panel({ status: armed({ invitees: five }) });
    expect(qa(container, "rehearsal-invitee")).toHaveLength(5);
    expect(q(container, "rehearsal-invitee-limit")).not.toBeNull();
    expect(q(container, "rehearsal-invitee-input")).toBeNull();
    fireEvent.click(qa(container, "rehearsal-invitee-remove")[2]!);
    expect(props.onRemove).toHaveBeenCalledWith("fan3");
    expect(qa(container, "rehearsal-invitee-remove")[0]?.getAttribute("aria-label")).toBe(
      t("rehearsal.invitees.remove", { username: "fan1" }),
    );
  });

  it("an empty list while armed is an EmptyState", () => {
    const { container } = panel({ status: armed() });
    expect(container.textContent).toContain(t("rehearsal.invitees.empty"));
    expect(q(container, "rehearsal-invitee-limit")).toBeNull();
  });

  it("loading: a skeleton instead of the status", () => {
    const { container } = panel({ status: null, keyPrefix: undefined });
    expect(q(container, "rehearsal-status")).toBeNull();
    expect(q(container, "rehearsal-arm")).toBeNull();
  });

  for (const theme of ["dark", "light"] as const)
    it(`fits a 320 px column (${theme}): no fixed widths, wrapping rows`, () => {
      const { container } = panel({ status: rehearsing({ invitees: [1, 2, 3].map(user) }), report: report() }, theme);
      const html = container.innerHTML;
      expect(html).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d|\bw-(96|112|128)\b/);
      expect(q(container, "rehearse-page")?.className).toContain("min-w-0");
      expect(container.querySelector(`[data-theme="${theme}"]`)).not.toBeNull();
    });
});

describe("helpers", () => {
  it("viewState and the countdown", () => {
    expect(viewState(null, null)).toBe("idle");
    expect(viewState(idle, report({ endReason: "disarmed" }))).toBe("ended");
    expect(viewState(idle, report())).toBe("idle");
    expect(viewState(armed(), null)).toBe("armed");
    expect(viewState(rehearsing(), report())).toBe("rehearsing");
    expect(remainingSeconds(idle, NOW)).toBeNull();
    expect(remainingSeconds(armed(), NOW)).toBe(570);
    expect(remainingSeconds(armed(), NOW + 3_600_000)).toBe(0);
    expect(remainingSeconds(rehearsing(), NOW)).toBe(1500);
  });

  it("ended-by mapping", () => {
    expect(endedBy("disarmed")).toBe("owner");
    expect(endedBy("publisher_ended")).toBe("publisher");
    expect(endedBy("cap")).toBe("cap");
    expect(endedBy("safety")).toBe("safety");
    expect(endedBy(null)).toBeNull();
  });

  it("checklist: pending without a report, warn on a flag", () => {
    expect(checklist(null).every((c) => c.state === "pending")).toBe(true);
    const flagged = checklist(report({ moderation: { samples: 3, flagged: true } }));
    expect(flagged.find((c) => c.check === "moderation")?.state).toBe("warn");
    const quiet = checklist(report({ chat: { accepted: 5, held: zero, rejected: zero }, ingest: [] }));
    expect(quiet.find((c) => c.check === "chat")?.state).toBe("pending");
    expect(quiet.find((c) => c.check === "moderation")?.state).toBe("pending");
  });

  it("dips in time order with their offset", () => {
    const r = report({
      ingest: [
        { check: "fps", ok: false, dips: [{ at: new Date(NOW - 30_000).toISOString(), seconds: 5 }] },
        { check: "bitrate", ok: false, dips: [{ at: new Date(NOW - 120_000).toISOString(), seconds: 15 }] },
      ],
    });
    expect(dips(r).map((d) => [d.kind, d.offsetSeconds, d.seconds])).toEqual([
      ["bitrate", 180, 15],
      ["fps", 270, 5],
    ]);
  });

  it("refusals map to messages", () => {
    const refusal = (requirement: string) => ({ code: "PRECONDITION_FAILED", data: { requirement } });
    expect(armErrorKey(refusal("live"))).toBe("rehearsal.refusal.live");
    expect(armErrorKey(refusal("armed"))).toBe("rehearsal.refusal.armed");
    expect(armErrorKey(new Error("x"))).toBe("rehearsal.armFailed");
    expect(inviteErrorKey(refusal("invitee_limit"))).toBe("rehearsal.invitees.limit");
    expect(inviteErrorKey(refusal("not_follower"))).toBe("rehearsal.invitees.notFollower");
    expect(inviteErrorKey(refusal("not_armed"))).toBe("rehearsal.invitees.notArmed");
    expect(inviteErrorKey({ code: "FORBIDDEN" })).toBe("rehearsal.invitees.failed");
  });

  it("suggestions skip excluded follows and invitees", () => {
    expect(
      suggestions(
        [
          { username: "a", excluded: false },
          { username: "b", excluded: true },
          { username: "c", excluded: false },
        ],
        [{ username: "c" }],
      ),
    ).toEqual(["a"]);
  });

  it("played seconds between heartbeats stay within 0–120", () => {
    expect(playedBetween(10, 20)).toBe(10);
    expect(playedBetween(20, 10)).toBe(0);
    expect(playedBetween(0, 500)).toBe(120);
  });
});
