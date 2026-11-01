// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * W3-giveaways web (ADR 0039; docs/testing/b7-selectors.md "Giveaways"): the open form's checks,
 * the viewer card's states (enter, entered, ineligible with its reason, won, sign in, closed,
 * drawn) with "no purchase necessary", the rules and the verify link; the studio panel (open,
 * close, draw, cancel; nothing while giveaways are off); and the verify page's in-browser re-run:
 * "matches" for an honest result (with a passed-over winner too) and "does not match" for a
 * tampered one, a wrong seed or an unsorted list, and the signed-in entrant's own pseudonym.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { commit, draw, newSeed } from "@commonair/draw";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { InteractClient } from "../src/chat/interact/client.ts";
import { GiveawayCard, giveawayCardState } from "../src/chat/interact/giveaway-card.tsx";
import {
  emptyGiveawayDraft,
  enterErrorKey,
  giveawayInput,
  verifyDraw,
  winnersFollowDraw,
  type GiveawayDto,
  type GiveawayVerificationDto,
} from "../src/components/giveaways/logic.ts";
import type { RulesClient } from "../src/components/giveaways/rules-link.tsx";
import { GiveawayVerifyPage, type VerifyClient } from "../src/components/giveaways/verify-page.tsx";
import {
  GiveawayPanel,
  GiveawayStudio,
  type GiveawayStudioApi,
} from "../src/components/interact-studio/giveaway-panel.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(() => {
  cleanup();
});

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const GIVE = UUID(3);

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

/** Render inside a memory router (the card and pages link to routes) and the locale. */
function inRouter(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  root.update({ component: () => <>{node}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

function fakeInteract(over: Partial<InteractClient> = {}): InteractClient {
  return {
    pollCurrent: vi.fn<InteractClient["pollCurrent"]>(async () => null),
    vote: vi.fn<InteractClient["vote"]>(),
    predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(async () => null),
    bet: vi.fn<InteractClient["bet"]>(),
    balance: vi.fn<InteractClient["balance"]>(),
    giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(async () => null),
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
    ...over,
  };
}

const rules: RulesClient = {
  legal: {
    get: vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
      id: UUID(8),
      kind: "terms",
      title: "Terms of service",
      version: "2026-11-01-draft",
      body: "Giveaways: no purchase necessary.",
      isDraft: true,
      requiresAcceptance: true,
      publishedAt: "2026-11-01T00:00:00.000Z",
    })),
  } as unknown as RulesClient["legal"],
};

// ------------------------------------------------------------------ the form

describe("the open form's checks", () => {
  const draft = (over: Partial<ReturnType<typeof emptyGiveawayDraft>> = {}) => ({
    ...emptyGiveawayDraft(),
    title: "Stickers",
    prize: "A pack",
    ...over,
  });

  it("builds the input: optional keyword, timed close and follow rule", () => {
    expect(giveawayInput("rivertide", draft())).toEqual({
      ok: true,
      input: {
        channel: "rivertide",
        title: "Stickers",
        prize: "A pack",
        winnerCount: 1,
        keyword: null,
        durationMinutes: null,
        eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
      },
    });
    const r = giveawayInput(
      "rivertide",
      draft({ keyword: "!win", duration: "30", minFollowDays: "0", minWatchSeconds: "120", winnerCount: "10" }),
    );
    expect(r.ok && r.input).toMatchObject({
      keyword: "!win",
      durationMinutes: 30,
      winnerCount: 10,
      eligibility: { minFollowDays: 0, minVerifiedWatchSeconds: 120 },
    });
  });

  it("refuses each field at its edges", () => {
    const errors = (over: Partial<ReturnType<typeof emptyGiveawayDraft>>) => {
      const r = giveawayInput("rivertide", draft(over));
      return r.ok ? {} : r.errors;
    };
    expect(errors({ title: " " })).toHaveProperty("title");
    expect(errors({ title: "x".repeat(61) })).toHaveProperty("title");
    expect(errors({ prize: "" })).toHaveProperty("prize");
    expect(errors({ winnerCount: "0" })).toHaveProperty("winnerCount");
    expect(errors({ winnerCount: "11" })).toHaveProperty("winnerCount");
    expect(errors({ keyword: "two words" })).toHaveProperty("keyword");
    expect(errors({ keyword: "!a" })).toHaveProperty("keyword");
    expect(errors({ duration: "1441" })).toHaveProperty("duration");
    expect(errors({ duration: "0" })).toHaveProperty("duration");
    expect(errors({ minAccountAgeDays: "-1" })).toHaveProperty("minAccountAgeDays");
    expect(errors({ minFollowDays: "1.5" })).toHaveProperty("minFollowDays");
    expect(errors({ minWatchSeconds: "14401" })).toHaveProperty("minWatchSeconds");
  });

  it("maps refusals to the viewer's messages, never the server's text", () => {
    const err = (code: string, reason?: string) => ({ code, data: reason ? { reason } : undefined });
    expect(enterErrorKey(err("FORBIDDEN", "verified_watch"))).toBe("giveaways.card.reason.verifiedWatch");
    expect(enterErrorKey(err("FORBIDDEN", "giveaways_disabled"))).toBe("giveaways.card.error.disabled");
    expect(enterErrorKey(err("CONFLICT", "closed"))).toBe("giveaways.card.error.closed");
    expect(enterErrorKey(err("CONFLICT", "already_entered"))).toBe("giveaways.card.entered");
    expect(enterErrorKey(err("UNAUTHORIZED"))).toBe("giveaways.card.signIn");
    expect(enterErrorKey(new Error("boom"))).toBe("giveaways.card.error.failed");
  });
});

// ------------------------------------------------------------------ the card

describe("the viewer card", () => {
  it("states follow the giveaway and the viewer", () => {
    expect(giveawayCardState(giveaway(), true)).toBe("enter");
    expect(giveawayCardState(giveaway({ me: null }), false)).toBe("signIn");
    expect(
      giveawayCardState(
        giveaway({ me: { entered: false, pseudonym: null, eligible: false, reason: "follow_age", won: false } }),
        true,
      ),
    ).toBe("ineligible");
    const entered = { entered: true, pseudonym: "ab", eligible: true, reason: null, won: false };
    expect(giveawayCardState(giveaway({ me: entered }), true)).toBe("entered");
    expect(giveawayCardState(giveaway({ me: entered, status: "drawn" }), true)).toBe("drawn");
    expect(giveawayCardState(giveaway({ me: { ...entered, won: true }, status: "drawn" }), true)).toBe("won");
    expect(giveawayCardState(giveaway({ status: "closed" }), true)).toBe("closed");
  });

  it("enters with one click, then shows the viewer is in", async () => {
    const entered = giveaway({
      entries: 4,
      me: { entered: true, pseudonym: "ab", eligible: true, reason: null, won: false },
    });
    const giveawayEnter = vi.fn<InteractClient["giveawayEnter"]>(async () => entered);
    const onEntered = vi.fn<(g: GiveawayDto) => void>();
    const { rerender } = inRouter(
      <GiveawayCard
        channel="rivertide"
        giveaway={giveaway()}
        signedIn
        client={fakeInteract({ giveawayEnter })}
        onEntered={onEntered}
        rulesClient={rules}
      />,
    );
    const card = await screen.findByTestId("chat-giveaway");
    expect(card.getAttribute("data-giveaway-id")).toBe(GIVE);
    expect(card.getAttribute("data-status")).toBe("open");
    expect(card.getAttribute("data-entries")).toBe("3");
    expect(screen.getByTestId("chat-giveaway-no-purchase").textContent).toBe(t("giveaways.card.noPurchase"));
    expect(screen.getByTestId("chat-giveaway-verify-link").getAttribute("href")).toBe(`/rivertide/giveaways/${GIVE}`);
    expect(screen.getByText(t("giveaways.card.keyword", { keyword: "!enter" }))).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-giveaway-enter"));
    await waitFor(() => expect(onEntered).toHaveBeenCalledWith(entered));
    expect(giveawayEnter).toHaveBeenCalledWith({ id: GIVE });
    rerender(<></>);
  });

  it("shows why a viewer cannot enter, and a refusal from the server", async () => {
    inRouter(
      <GiveawayCard
        channel="rivertide"
        giveaway={giveaway({
          me: { entered: false, pseudonym: null, eligible: false, reason: "verified_watch", won: false },
        })}
        signedIn
        client={fakeInteract()}
        onEntered={vi.fn<(g: GiveawayDto) => void>()}
        rulesClient={rules}
      />,
    );
    const why = await screen.findByTestId("chat-giveaway-ineligible");
    expect(why.getAttribute("data-reason")).toBe("verified_watch");
    expect(why.textContent).toBe(t("giveaways.card.reason.verifiedWatch"));
    expect(screen.queryByTestId("chat-giveaway-enter")).toBeNull();
    cleanup();

    const giveawayEnter = vi.fn<InteractClient["giveawayEnter"]>(async () => {
      throw Object.assign(new Error("closed"), { code: "CONFLICT", data: { reason: "closed" } });
    });
    inRouter(
      <GiveawayCard
        channel="rivertide"
        giveaway={giveaway()}
        signedIn
        client={fakeInteract({ giveawayEnter })}
        onEntered={vi.fn<(g: GiveawayDto) => void>()}
        rulesClient={rules}
      />,
    );
    fireEvent.click(await screen.findByTestId("chat-giveaway-enter"));
    expect((await screen.findByRole("alert")).textContent).toBe(t("giveaways.card.error.closed"));
  });

  it("entered, won and signed-out states", async () => {
    const me = { entered: true, pseudonym: "ab", eligible: true, reason: null, won: false };
    const props = {
      channel: "rivertide",
      client: fakeInteract(),
      onEntered: vi.fn<(g: GiveawayDto) => void>(),
      rulesClient: rules,
    };
    inRouter(<GiveawayCard {...props} giveaway={giveaway({ me })} signedIn />);
    expect((await screen.findByTestId("chat-giveaway-entered")).textContent).toBe(t("giveaways.card.entered"));
    cleanup();
    inRouter(
      <GiveawayCard
        {...props}
        giveaway={giveaway({ status: "drawn", me: { ...me, won: true }, winners: [{ rank: 1, pseudonym: "ab" }] })}
        signedIn
      />,
    );
    expect(await screen.findByTestId("chat-giveaway-won")).toBeTruthy();
    cleanup();
    inRouter(<GiveawayCard {...props} giveaway={giveaway({ me: null })} signedIn={false} />);
    expect(await screen.findByText(t("giveaways.card.signIn"))).toBeTruthy();
    expect(screen.queryByTestId("chat-giveaway-enter")).toBeNull();
  });

  it("opens the official rules in a dialog, loaded on demand", async () => {
    inRouter(
      <GiveawayCard
        channel="rivertide"
        giveaway={giveaway()}
        signedIn
        client={fakeInteract()}
        onEntered={vi.fn<(g: GiveawayDto) => void>()}
        rulesClient={rules}
      />,
    );
    expect(rules.legal.get).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("chat-giveaway-rules-link"));
    expect(await screen.findByText("Giveaways: no purchase necessary.")).toBeTruthy();
    expect(rules.legal.get).toHaveBeenCalledWith({ kind: "terms" });
  });
});

// ------------------------------------------------------------------ the verify page

const pseudonyms = (n: number) =>
  Array.from({ length: n }, (_, i) => (i * 7919 + 13).toString(16).padStart(64, "0")).sort();

async function honest(over: { winnerCount?: number } = {}): Promise<GiveawayVerificationDto> {
  const seed = newSeed();
  const entries = pseudonyms(6);
  const order = await draw(seed, entries, entries.length);
  const winnerCount = over.winnerCount ?? 2;
  const picked = order.slice(0, winnerCount);
  return {
    id: GIVE,
    channelSlug: "rivertide",
    title: "Stickers",
    status: "drawn",
    seedCommitment: await commit(seed),
    seed,
    entries,
    winnerCount,
    winners: picked.map((index, i) => ({ rank: i + 1, index, pseudonym: entries[index] as string, username: null })),
    drawnAt: "2026-11-01T12:10:00.000Z",
  };
}

describe("the in-browser re-run", () => {
  it("matches an honest draw, with or without a passed-over winner", async () => {
    expect(await verifyDraw(await honest())).toEqual({ state: "checked", match: true, problem: null, skipped: 0 });
    // The first drawn entrant was banned before the draw: ranks go to the next two.
    const v = await honest();
    const order = await draw(v.seed as string, v.entries, v.entries.length);
    const passedOver = {
      ...v,
      winners: order.slice(1, 3).map((index, i) => ({
        rank: i + 1,
        index,
        pseudonym: v.entries[index] as string,
        username: null,
      })),
    };
    expect(await verifyDraw(passedOver)).toMatchObject({ match: true, skipped: 1 });
  });

  it("does not match a tampered winner, a wrong seed or an unsorted list", async () => {
    const v = await honest();
    const swapped = { ...v, winners: [...v.winners].reverse().map((w, i) => ({ ...w, rank: i + 1 })) };
    expect(await verifyDraw(swapped)).toMatchObject({ match: false, problem: "winners" });
    const renamed = { ...v, winners: v.winners.map((w) => ({ ...w, pseudonym: "f".repeat(64) })) };
    expect(await verifyDraw(renamed)).toMatchObject({ match: false, problem: "winners" });
    expect(await verifyDraw({ ...v, seed: newSeed() })).toMatchObject({ match: false, problem: "commitment" });
    expect(await verifyDraw({ ...v, entries: [...v.entries].reverse() })).toMatchObject({
      match: false,
      problem: "entries",
    });
  });

  it("waits for the draw, and says when it was cancelled", async () => {
    const v = await honest();
    expect(await verifyDraw({ ...v, status: "closed", seed: null, winners: [] })).toEqual({ state: "pending" });
    expect(await verifyDraw({ ...v, status: "cancelled", seed: null, winners: [] })).toEqual({ state: "cancelled" });
  });

  it("winnersFollowDraw: fewer winners than asked means everyone else was passed over", () => {
    expect(winnersFollowDraw([3, 1, 2, 0], [{ rank: 1, index: 2 }], 2)).toEqual({ match: true, skipped: 3 });
    expect(
      winnersFollowDraw(
        [3, 1, 2, 0],
        [
          { rank: 1, index: 3 },
          { rank: 2, index: 2 },
        ],
        2,
      ),
    ).toEqual({
      match: true,
      skipped: 1,
    });
    expect(winnersFollowDraw([3, 1, 2, 0], [{ rank: 1, index: 9 }], 1).match).toBe(false);
  });
});

function verifyClient(v: GiveawayVerificationDto | Error, opts: { enabled?: boolean; mine?: string | null } = {}) {
  return {
    instance: {
      info: vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
        features: { giveaways: opts.enabled ?? true },
      })),
    },
    interact: {
      giveaways: {
        verify: vi.fn<(...args: never[]) => Promise<unknown>>(async () => {
          if (v instanceof Error) throw v;
          return v;
        }),
        current: vi.fn<(...args: never[]) => Promise<unknown>>(async () =>
          giveaway({ me: { entered: true, pseudonym: opts.mine ?? null, eligible: true, reason: null, won: false } }),
        ),
      },
    },
  } as unknown as VerifyClient;
}

describe("the verify page", () => {
  it("re-runs the draw: matches, with the entrant's own pseudonym marked", async () => {
    const v = await honest();
    const mine = v.entries[2] as string;
    inRouter(<GiveawayVerifyPage channel="rivertide" giveawayId={GIVE} signedIn client={verifyClient(v, { mine })} />);
    const page = await screen.findByTestId("giveaway-verify-page");
    expect(page.getAttribute("data-status")).toBe("drawn");
    expect(screen.getByTestId("giveaway-verify-commitment").textContent).toBe(v.seedCommitment);
    expect(screen.getByTestId("giveaway-verify-seed").textContent).toBe(v.seed);
    const result = await screen.findByTestId("giveaway-verify-result");
    expect(result.getAttribute("data-match")).toBe("true");
    const entries = screen.getAllByTestId("giveaway-verify-entry");
    expect(entries).toHaveLength(6);
    expect(
      entries.filter((e) => e.getAttribute("data-mine") === "true").map((e) => e.getAttribute("data-index")),
    ).toEqual(["2"]);
    const winners = screen.getAllByTestId("giveaway-verify-winner");
    expect(winners.map((w) => [w.getAttribute("data-rank"), w.getAttribute("data-index")])).toEqual(
      v.winners.map((w) => [String(w.rank), String(w.index)]),
    );
  });

  it("does not match a tampered result", async () => {
    const v = await honest();
    const tampered = { ...v, winners: [...v.winners].reverse().map((w, i) => ({ ...w, rank: i + 1 })) };
    inRouter(
      <GiveawayVerifyPage channel="rivertide" giveawayId={GIVE} signedIn={false} client={verifyClient(tampered)} />,
    );
    const result = await screen.findByTestId("giveaway-verify-result");
    expect(result.getAttribute("data-match")).toBe("false");
    expect(result.textContent).toContain(t("giveaways.verify.mismatch"));
  });

  it("before the draw the seed is empty and nothing is checked; giveaways off is not found", async () => {
    const v = await honest();
    inRouter(
      <GiveawayVerifyPage
        channel="rivertide"
        giveawayId={GIVE}
        signedIn={false}
        client={verifyClient({ ...v, status: "open", seed: null, winners: [] })}
      />,
    );
    expect((await screen.findByTestId("giveaway-verify-seed")).textContent).toBe("");
    expect(await screen.findByText(t("giveaways.verify.pending"))).toBeTruthy();
    expect(screen.queryByTestId("giveaway-verify-result")).toBeNull();
    cleanup();
    const off = verifyClient(v, { enabled: false });
    inRouter(<GiveawayVerifyPage channel="rivertide" giveawayId={GIVE} signedIn={false} client={off} />);
    expect(await screen.findByText(t("page.notFound"))).toBeTruthy();
    expect(off.interact.giveaways.verify).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ the studio panel

function studioClient(initial: GiveawayDto | null, enabled = true) {
  const g = {
    current: vi.fn<(...args: never[]) => Promise<unknown>>(async () => initial),
    open: vi.fn<(...args: never[]) => Promise<unknown>>(async () => giveaway({ title: "Launch" })),
    close: vi.fn<(...args: never[]) => Promise<unknown>>(async () => giveaway({ status: "closed" })),
    draw: vi.fn<(...args: never[]) => Promise<unknown>>(async () =>
      giveaway({
        status: "drawn",
        winners: [{ rank: 1, pseudonym: "c".repeat(64) }],
        drawnAt: "2026-11-01T12:10:00.000Z",
      }),
    ),
    cancel: vi.fn<(...args: never[]) => Promise<unknown>>(async () => giveaway({ status: "cancelled" })),
  };
  const client = {
    instance: {
      info: vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({ features: { giveaways: enabled } })),
    },
    interact: { giveaways: g },
  } as unknown as GiveawayStudioApi;
  return { client, g };
}

describe("the studio panel", () => {
  it("renders nothing while giveaways are off", async () => {
    const { client, g } = studioClient(null, false);
    inRouter(<GiveawayPanel channel="rivertide" client={client} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId("giveaway-panel")).toBeNull();
    expect(g.current).not.toHaveBeenCalled();
  });

  it("opens a giveaway from the form", async () => {
    const { client, g } = studioClient(null);
    inRouter(<GiveawayPanel channel="rivertide" client={client} />);
    await screen.findByTestId("giveaway-form");
    const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });
    type("giveaway-title", "Launch");
    type("giveaway-prize", "A sticker pack");
    type("giveaway-winner-count", "2");
    type("giveaway-keyword", "!enter");
    type("giveaway-duration", "15");
    type("giveaway-min-account-age", "7");
    type("giveaway-min-follow-days", "");
    type("giveaway-min-watch", "60");
    fireEvent.click(screen.getByTestId("giveaway-open"));
    await waitFor(() =>
      expect(g.open).toHaveBeenCalledWith({
        channel: "rivertide",
        title: "Launch",
        prize: "A sticker pack",
        winnerCount: 2,
        keyword: "!enter",
        durationMinutes: 15,
        eligibility: { minAccountAgeDays: 7, minFollowDays: null, minVerifiedWatchSeconds: 60 },
      }),
    );
    expect((await screen.findByTestId("giveaway-live")).getAttribute("data-status")).toBe("open");
    expect(screen.queryByTestId("giveaway-form")).toBeNull();
  });

  it("shows the commitment, closes and draws", async () => {
    const { client, g } = studioClient(giveaway());
    inRouter(<GiveawayStudio channel="rivertide" initial={giveaway()} client={client} refreshMs={60_000} />);
    expect((await screen.findByTestId("giveaway-commitment")).textContent).toBe("a".repeat(64));
    fireEvent.click(screen.getByTestId("giveaway-close"));
    await waitFor(() => expect(screen.getByTestId("giveaway-live").getAttribute("data-status")).toBe("closed"));
    expect(g.close).toHaveBeenCalledWith({ channel: "rivertide", id: GIVE });
    fireEvent.click(screen.getByTestId("giveaway-draw"));
    await waitFor(() => expect(screen.getByTestId("giveaway-live").getAttribute("data-status")).toBe("drawn"));
    expect(screen.getByText(t("giveaways.verify.winnerRow", { rank: 1, pseudonym: "c".repeat(64) }))).toBeTruthy();
    // A drawn giveaway offers a new one.
    expect(screen.getByTestId("giveaway-form")).toBeTruthy();
  });

  it("cancels only after the confirm dialog", async () => {
    const { client, g } = studioClient(giveaway());
    inRouter(<GiveawayStudio channel="rivertide" initial={giveaway()} client={client} refreshMs={60_000} />);
    fireEvent.click(await screen.findByTestId("giveaway-cancel"));
    expect(g.cancel).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("giveaway-cancel-confirm");
    const confirm = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === t("giveaways.studio.cancelConfirm"),
    );
    fireEvent.click(confirm as HTMLButtonElement);
    await waitFor(() => expect(g.cancel).toHaveBeenCalledWith({ channel: "rivertide", id: GIVE }));
  });
});
