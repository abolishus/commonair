// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * "How we count" states that the creator's own viewing never counts (ADR 0014 amendment
 * 2026-11-11), in English and Spanish, and no longer says the creator's own player still counts.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HowWeCount } from "../src/components/transparency-v2/how-we-count.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import en from "../src/i18n/locales/en/w5-viewers.json" with { type: "json" };
import es from "../src/i18n/locales/es/w5-viewers.json" with { type: "json" };

afterEach(cleanup);

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/transparency"] }),
});

describe("HowWeCount: the creator's own viewing", () => {
  it("says the owner's player is left out of live and settled figures", () => {
    render(
      <RouterContextProvider router={router}>
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>
            <HowWeCount />
          </TooltipProvider>
        </LocaleProvider>
      </RouterContextProvider>,
    );
    const owner = screen.getByTestId("transparency-how-we-count").querySelector('[data-part="owner"] dd');
    expect(owner?.textContent).toBe(t("w5Viewers.how.owner"));
    expect(owner?.textContent).toContain("never one of their viewers");
    expect(owner?.textContent).not.toContain("can still include");
  });

  it("has the same keys in English and Spanish", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(es["w5Viewers.how.owner"]).not.toBe(en["w5Viewers.how.owner"]);
  });
});
