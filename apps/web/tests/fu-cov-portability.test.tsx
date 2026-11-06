// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * "Tell me if they move" beyond the bulk suite: `PortabilityGrants` loading (a failed load, no
 * channels, a load that answers after unmount), one switch (saved, refused with the toast and
 * the switch back, busy while saving), "Load more" (appended, refused, ignored while a page is in
 * flight), bulk runs that change nothing or cross the `setMany` batch size with one refused
 * batch; `FollowGrantToggle`; and the import helpers' schedule and standing edges.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  follows: [] as { items: unknown[]; nextCursor: string | null }[],
  followsFail: new Set<string>(),
  followsHold: null as Promise<void> | null,
  followCalls: [] as (string | undefined)[],
  grants: [] as unknown[],
  mineFail: false,
  set: [] as { channel: string; enabled: boolean }[],
  setFail: false,
  setHold: null as Promise<void> | null,
  setAnswer: null as boolean | null,
  setMany: [] as { channels: string[]; enabled: boolean }[],
  setManyFailAt: -1,
  toasts: [] as [string, string][],
}));

vi.mock("@commonair/ui/toast", () => ({
  toast: {
    error: (m: string) => fake.toasts.push(["error", m]),
    success: (m: string) => fake.toasts.push(["success", m]),
  },
}));

vi.mock("../src/lib/api.ts", () => {
  const api = () => ({
    me: {
      follows: async ({ cursor }: { cursor?: string }) => {
        fake.followCalls.push(cursor);
        if (cursor && fake.followsHold) await fake.followsHold;
        if (fake.followsFail.has(cursor ?? "")) throw Object.assign(new Error("down"), { code: "INTERNAL" });
        const index = cursor ? Number(cursor) : 0;
        return fake.follows[index] ?? { items: [], nextCursor: null };
      },
    },
    portability: {
      grants: {
        mine: async () => {
          if (fake.mineFail) throw new Error("down");
          return fake.grants;
        },
        set: async (input: { channel: string; enabled: boolean }) => {
          fake.set.push(input);
          if (fake.setHold) await fake.setHold;
          if (fake.setFail) throw Object.assign(new Error("down"), { code: "UNAUTHORIZED" });
          return { enabled: fake.setAnswer ?? input.enabled };
        },
        setMany: async (input: { channels: string[]; enabled: boolean }) => {
          fake.setMany.push(input);
          if (fake.setMany.length - 1 === fake.setManyFailAt) throw new Error("down");
          return { enabled: input.enabled, updated: input.channels.length };
        },
      },
    },
  });
  return { api, errorCode: (e: { code?: string }) => e?.code ?? null };
});

const { FollowGrantToggle, GrantsView, PortabilityGrants, grantRows, withMoreFollows } =
  await import("../src/components/portability/grants.tsx");
const lib = await import("../src/components/portability/lib.ts");
const { locale, t, uiMessages } = await import("../src/i18n/index.ts");

afterEach(() => {
  cleanup();
  fake.follows = [];
  fake.followsFail = new Set();
  fake.followsHold = null;
  fake.followCalls = [];
  fake.grants = [];
  fake.mineFail = false;
  fake.set = [];
  fake.setFail = false;
  fake.setHold = null;
  fake.setAnswer = null;
  fake.setMany = [];
  fake.setManyFailAt = -1;
  fake.toasts = [];
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const channel = (i: number) => ({
  slug: `ch${String(i).padStart(3, "0")}`,
  displayName: `Channel ${String(i).padStart(3, "0")}`,
  avatarUrl: null,
});
const followPage = (from: number, to: number, next: string | null) => ({
  items: Array.from({ length: to - from }, (_, i) => ({ channel: channel(from + i) })),
  nextCursor: next,
});
const state = (slug: string) =>
  screen.getAllByTestId("portability-grant").find((r) => r.dataset.channel === slug)?.dataset.state;
const toggleOf = (slug: string) => {
  const row = screen.getAllByTestId("portability-grant").find((r) => r.dataset.channel === slug);
  const el = row?.querySelector<HTMLElement>('[data-testid="portability-grant-toggle"]');
  if (!el) throw new Error(`no toggle for ${slug}`);
  return el;
};

describe("PortabilityGrants: loading", () => {
  it("a failed load says so, without the list", async () => {
    fake.mineFail = true;
    wrap(<PortabilityGrants />);
    await screen.findByText(t("portability.grants.loadFailed"));
    expect(screen.queryByTestId("portability-grant")).toBeNull();
  });

  it("no followed channels and no grants: the empty state", async () => {
    wrap(<PortabilityGrants />);
    await screen.findByText(t("portability.grants.empty"));
    expect(screen.queryByTestId("portability-grants-search")).toBeNull();
  });

  it("an answer after unmount changes nothing (no error, no update)", async () => {
    fake.follows = [followPage(0, 2, null)];
    const { unmount } = wrap(<PortabilityGrants />);
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.toasts).toEqual([]);
  });

  it("a granted channel that is no longer followed is still listed, on", async () => {
    fake.follows = [followPage(0, 2, null)];
    fake.grants = [{ channel: channel(9) }];
    wrap(<PortabilityGrants />);
    await screen.findAllByTestId("portability-grant");
    expect(screen.getAllByTestId("portability-grant").map((r) => [r.dataset.channel, r.dataset.state])).toEqual([
      ["ch000", "off"],
      ["ch001", "off"],
      ["ch009", "on"],
    ]);
  });
});

describe("PortabilityGrants: one switch", () => {
  it("saves the switch and shows what the server answered", async () => {
    fake.follows = [followPage(0, 2, null)];
    fake.setAnswer = false;
    wrap(<PortabilityGrants />);
    await screen.findAllByTestId("portability-grant");
    await act(async () => {
      fireEvent.click(toggleOf("ch001"));
    });
    await waitFor(() => expect(fake.set).toEqual([{ channel: "ch001", enabled: true }]));
    // The server kept it off (say, the channel cannot be granted): the switch follows the answer.
    await waitFor(() => expect(state("ch001")).toBe("off"));
  });

  it("is busy while saving, then on", async () => {
    fake.follows = [followPage(0, 1, null)];
    let release = () => {};
    fake.setHold = new Promise<void>((r) => {
      release = r;
    });
    wrap(<PortabilityGrants />);
    await screen.findAllByTestId("portability-grant");
    await act(async () => {
      fireEvent.click(toggleOf("ch000"));
    });
    await waitFor(() => expect(toggleOf("ch000").getAttribute("data-disabled")).not.toBeNull());
    await act(async () => release());
    await waitFor(() => expect(state("ch000")).toBe("on"));
    expect(toggleOf("ch000").getAttribute("data-disabled")).toBeNull();
  });

  it("a refused save (an expired session) toasts sign-in and leaves the switch as it was", async () => {
    fake.follows = [followPage(0, 1, null)];
    fake.setFail = true;
    wrap(<PortabilityGrants />);
    await screen.findAllByTestId("portability-grant");
    await act(async () => {
      fireEvent.click(toggleOf("ch000"));
    });
    await waitFor(() => expect(fake.toasts).toEqual([["error", t("auth.sessionExpired")]]));
    expect(state("ch000")).toBe("off");
  });
});

describe("PortabilityGrants: Load more", () => {
  it("appends the next follows page (with its grants), then has no more", async () => {
    fake.follows = [followPage(0, 20, "1"), followPage(20, 22, null)];
    fake.grants = [{ channel: channel(21) }];
    wrap(<PortabilityGrants />);
    const more = await screen.findByTestId("portability-grants-more");
    await act(async () => {
      fireEvent.click(more);
    });
    await waitFor(() => expect(screen.getAllByTestId("portability-grant")).toHaveLength(22));
    expect(state("ch021")).toBe("on");
    expect(screen.queryByTestId("portability-grants-more")).toBeNull();
  });

  it("a refused page toasts and keeps what is shown", async () => {
    fake.follows = [followPage(0, 20, "1")];
    fake.followsFail = new Set(["1"]);
    wrap(<PortabilityGrants />);
    const more = await screen.findByTestId("portability-grants-more");
    await act(async () => {
      fireEvent.click(more);
    });
    await waitFor(() => expect(fake.toasts).toEqual([["error", t("portability.grants.loadFailed")]]));
    expect(screen.getAllByTestId("portability-grant")).toHaveLength(20);
  });

  it("asks once while a page is in flight, and bulk buttons wait for it", async () => {
    fake.follows = [followPage(0, 20, "1"), followPage(20, 40, "2"), followPage(40, 41, null)];
    let release = () => {};
    fake.followsHold = new Promise<void>((r) => {
      release = r;
    });
    wrap(<PortabilityGrants />);
    const more = await screen.findByTestId("portability-grants-more");
    await act(async () => {
      fireEvent.click(more);
    });
    // The window grew into the loaded rows; a second click while loading asks nothing new.
    await act(async () => {
      fireEvent.click(screen.getByTestId("portability-grants-more"));
    });
    expect(fake.followCalls).toEqual([undefined, "1"]);
    expect((screen.getByTestId("portability-grants-all-on") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(screen.getAllByTestId("portability-grant").length).toBeGreaterThanOrEqual(40));
  });
});

describe("PortabilityGrants: bulk edges", () => {
  it("nothing to change: no setMany, still the done toast", async () => {
    fake.follows = [followPage(0, 2, null)];
    wrap(<PortabilityGrants />);
    const off = await screen.findByTestId("portability-grants-all-off");
    await act(async () => {
      fireEvent.click(off);
    });
    await waitFor(() => expect(fake.toasts).toEqual([["success", t("settings.grants.allOffDone")]]));
    expect(fake.setMany).toEqual([]);
  });

  it("more than one batch: each goes in its own call; a refused batch flips back and is counted", async () => {
    const n = lib.GRANTS_SET_MANY_MAX + 3;
    fake.follows = [followPage(0, n, null)];
    fake.setManyFailAt = 1;
    wrap(<PortabilityGrants />);
    const on = await screen.findByTestId("portability-grants-all-on");
    await act(async () => {
      fireEvent.click(on);
    });
    await waitFor(() => expect(fake.toasts).toEqual([["error", t("settings.grants.allFailed", { count: 3 })]]));
    expect(fake.setMany.map((c) => c.channels.length)).toEqual([lib.GRANTS_SET_MANY_MAX, 3]);
    expect(state("ch000")).toBe("on");
  });

  it("a follows page that fails while paging to the end toasts the save failure", async () => {
    fake.follows = [followPage(0, 2, "1")];
    fake.followsFail = new Set(["1"]);
    wrap(<PortabilityGrants />);
    const on = await screen.findByTestId("portability-grants-all-on");
    await act(async () => {
      fireEvent.click(on);
    });
    await waitFor(() => expect(fake.toasts).toEqual([["error", t("portability.grants.saveFailed")]]));
    expect(fake.setMany).toEqual([]);
    await waitFor(() => expect(screen.getByTestId("portability-grants-all-on").getAttribute("aria-busy")).toBeNull());
  });
});

describe("GrantsView: search with no match", () => {
  it("says nothing matched, and the bulk buttons are off", () => {
    const rows = grantRows([channel(1), channel(2)], []);
    const onSetAll = vi.fn<(on: boolean, scope: { slugs: readonly string[]; everything: boolean }) => void>();
    wrap(<GrantsView rows={rows} loadFailed={false} busy={new Set()} onToggle={() => {}} onSetAll={onSetAll} />);
    fireEvent.change(screen.getByTestId("portability-grants-search"), { target: { value: "zzz" } });
    expect(screen.queryByTestId("portability-grant")).toBeNull();
    expect((screen.getByTestId("portability-grants-all-on") as HTMLButtonElement).disabled).toBe(true);
  });

  it("without onSetAll there are no bulk controls; loading shows the skeleton", () => {
    const { rerender } = wrap(
      <GrantsView rows={grantRows([channel(1)], [])} loadFailed={false} busy={new Set()} onToggle={() => {}} />,
    );
    expect(screen.queryByTestId("portability-grants-all-on")).toBeNull();
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <GrantsView rows={null} loadFailed={false} busy={new Set()} onToggle={() => {}} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(screen.queryByTestId("portability-grant")).toBeNull();
    expect(screen.getByTestId("portability-grants").textContent).toContain(t("portability.grants.title"));
  });

  it("withMoreFollows ignores channels already listed", () => {
    const rows = grantRows([channel(2)], [channel(1)]);
    expect(withMoreFollows(rows, [channel(1), channel(3)], [channel(3)]).map((r) => [r.slug, r.on])).toEqual([
      ["ch001", true],
      ["ch002", false],
      ["ch003", true],
    ]);
  });
});

describe("FollowGrantToggle", () => {
  it("saves and follows the server's answer", async () => {
    wrap(<FollowGrantToggle channel="rivertide" displayName="Rivertide" initial={false} />);
    const sw = screen.getByTestId("portability-grant-toggle");
    expect(sw.dataset.state).toBe("off");
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(screen.getByTestId("portability-grant-toggle").dataset.state).toBe("on"));
    expect(fake.set).toEqual([{ channel: "rivertide", enabled: true }]);
  });

  it("a refusal toasts and keeps the switch", async () => {
    fake.setFail = true;
    wrap(<FollowGrantToggle channel="rivertide" displayName="Rivertide" initial />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("portability-grant-toggle"));
    });
    await waitFor(() => expect(fake.toasts).toHaveLength(1));
    expect(screen.getByTestId("portability-grant-toggle").dataset.state).toBe("on");
    await waitFor(() =>
      expect(screen.getByTestId("portability-grant-toggle").getAttribute("data-disabled")).toBeNull(),
    );
  });
});

describe("import helpers: schedule and standing", () => {
  const item = (kind: "channel" | "panel" | "emote" | "schedule", ref: string = kind) => ({
    kind,
    ref,
    label: ref,
    outcome: null,
    reason: null,
  });

  it("the schedule is never selectable, chosen or toggled", () => {
    const choices = { channel: true, panels: true, emotes: ["a"] };
    expect(lib.isSelectable(item("schedule"))).toBe(false);
    expect(lib.isChosen(choices, item("schedule"))).toBe(false);
    expect(lib.toggleChoice(choices, item("schedule"))).toBe(choices);
  });

  it("an item with an outcome is not chosen even when its kind is", () => {
    expect(
      lib.isChosen({ channel: true, panels: true, emotes: ["e"] }, { ...item("emote", "e"), outcome: "rejected" }),
    ).toBe(false);
    expect(lib.isChosen({ channel: false, panels: true, emotes: [] }, item("panel"))).toBe(true);
  });

  it("standing: refused wins; only an explicit true is verified", () => {
    expect(lib.standingBadge({ standingVerified: true, status: "previewed" }, true)).toBe("refused");
    expect(lib.standingBadge({ standingVerified: true, status: "previewed" }, false)).toBe("verified");
    expect(lib.standingBadge({ standingVerified: null, status: "previewed" }, false)).toBe("unverified");
    expect(lib.standingBadge({ standingVerified: false, status: "done" }, false)).toBe("unverified");
  });

  it("reason codes, link states and expiry", () => {
    expect(lib.importErrorReason({ data: { reason: 3 } })).toBeNull();
    expect(lib.importErrorReason({ data: null })).toBeNull();
    expect(lib.importErrorReason("x")).toBeNull();
    expect(lib.reasonKey(null)).toBeNull();
    expect(lib.reasonKey("bundle_truncated")).toBe("portability.reason.badBundle");
    expect(lib.reasonKey("whatever")).toBe("portability.reason.other");
    const now = Date.parse("2026-11-06T12:00:00.000Z");
    expect(lib.linkState({ revokedAt: null, expiresAt: "2026-11-06T12:00:00.000Z" }, now)).toBe("expired");
    expect(lib.linkState({ revokedAt: null, expiresAt: "2026-11-06T12:00:00.001Z" }, now)).toBe("active");
    expect(lib.expiresAtFor("7", now)).toBe("2026-11-13T12:00:00.000Z");
    expect(lib.expiresAtFor("never", now)).toBeNull();
    expect(lib.isValidMovedTo(`https://example.org/${"a".repeat(480)}`)).toBe(true);
    expect(lib.isValidMovedTo(`https://example.org/${"a".repeat(482)}`)).toBe(false);
    expect(lib.isValidMovedTo("   ")).toBe(false);
    expect(lib.isValidMovedTo("https://u:p@example.org")).toBe(false);
    expect(lib.isImportRunning({ status: "queued" })).toBe(true);
    expect(lib.isImportRunning({ status: "done" })).toBe(false);
  });
});
