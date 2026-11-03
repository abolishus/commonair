// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Giveaway CR9 (batch 8, B8-web; `giveaway-verify-mine`): the verify page marks the signed-in
 * caller's own pseudonym from `verify.me` on any giveaway, not only the channel's current one; not
 * signed out, not for a pseudonym outside the published list; never a username (decision (n));
 * and the rules axe would flag on the page.
 */
import { commit, draw, newSeed } from "@commonair/draw";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { GiveawayVerificationDto } from "../src/components/giveaways/logic.ts";
import { GiveawayVerifyPage, type VerifyClient } from "../src/components/giveaways/verify-page.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const OLD = UUID(3);
const CURRENT = UUID(4);

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

const pseudonyms = (n: number) =>
  Array.from({ length: n }, (_, i) => (i * 7919 + 13).toString(16).padStart(64, "0")).sort();

async function drawn(me: GiveawayVerificationDto["me"]): Promise<GiveawayVerificationDto> {
  const seed = newSeed();
  const entries = pseudonyms(5);
  const order = await draw(seed, entries, 1);
  const index = order[0] as number;
  return {
    id: OLD,
    channelSlug: "rivertide",
    title: "Last week's stickers",
    status: "drawn",
    seedCommitment: await commit(seed),
    seed,
    entries,
    winnerCount: 1,
    winners: [{ rank: 1, index, pseudonym: entries[index] as string, username: null }],
    drawnAt: "2026-11-01T12:10:00.000Z",
    me,
  };
}

/** `current` is another, newer giveaway: the old fallback could not mark this one. */
function client(v: GiveawayVerificationDto) {
  const current = vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
    id: CURRENT,
    me: { entered: true, pseudonym: "f".repeat(64), eligible: true, reason: null, won: false },
  }));
  return {
    current,
    client: {
      instance: {
        info: vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({ features: { giveaways: true } })),
      },
      interact: { giveaways: { verify: vi.fn<(...args: never[]) => Promise<unknown>>(async () => v), current } },
    } as unknown as VerifyClient,
  };
}

describe("the verify page marks your entry on any giveaway", () => {
  it("marks verify.me's pseudonym on a giveaway that is not the current one", async () => {
    const v = await drawn(null);
    const mine = v.entries[3] as string;
    const c = client({ ...v, me: { pseudonym: mine } });
    const { container } = inRouter(
      <GiveawayVerifyPage channel="rivertide" giveawayId={OLD} signedIn client={c.client} />,
    );
    const mark = await screen.findByTestId("giveaway-verify-mine");
    expect(mark.dataset.pseudonym).toBe(mine);
    expect(mark.textContent).toBe(t("giveaways.verify.you"));
    expect(mark.closest('[data-testid="giveaway-verify-entry"]')?.getAttribute("data-index")).toBe("3");
    expect(screen.getAllByTestId("giveaway-verify-mine")).toHaveLength(1);
    // `verify.me` answered: no second request for `current`.
    expect(c.current).not.toHaveBeenCalled();
    // Pseudonyms only, never a name (decision (n)).
    expect(container.textContent).not.toMatch(/@|username/i);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of container.querySelectorAll("[aria-labelledby]"))
      expect(document.getElementById(el.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
  });

  it("marks nothing for a non-entrant or a signed-out visitor", async () => {
    const v = await drawn(null);
    inRouter(<GiveawayVerifyPage channel="rivertide" giveawayId={OLD} signedIn client={client(v).client} />);
    await screen.findByTestId("giveaway-verify-page");
    expect(screen.queryByTestId("giveaway-verify-mine")).toBeNull();
    cleanup();
    const signedOut = client({ ...v, me: { pseudonym: v.entries[1] as string } });
    inRouter(<GiveawayVerifyPage channel="rivertide" giveawayId={OLD} signedIn={false} client={signedOut.client} />);
    await screen.findByTestId("giveaway-verify-page");
    expect(screen.queryByTestId("giveaway-verify-mine")).toBeNull();
    expect(signedOut.current).not.toHaveBeenCalled();
  });

  it("marks nothing for a pseudonym that is not in the published list", async () => {
    const v = await drawn({ pseudonym: "0".repeat(64) });
    inRouter(<GiveawayVerifyPage channel="rivertide" giveawayId={OLD} signedIn client={client(v).client} />);
    await screen.findByTestId("giveaway-verify-page");
    expect(screen.queryByTestId("giveaway-verify-mine")).toBeNull();
  });
});
