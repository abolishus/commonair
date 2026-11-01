// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The crew propose form's preview while the instance's cut is still loading: CI run 41345495956
 * read "0" for the recipient because the page priced the example with a placeholder share of 0
 * until `money.support` answered.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CrewProposeForm } from "../src/components/money/crew.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function form(streamerShare: number | null) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <CrewProposeForm currency="USD" streamerShare={streamerShare} onPropose={async () => {}} />
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

function fill(username: string, bps: string) {
  fireEvent.change(screen.getByTestId("crew-recipient"), { target: { value: username } });
  fireEvent.change(screen.getByTestId("crew-bps"), { target: { value: bps } });
}

const preview = () => screen.getByTestId("crew-preview");
const submit = () => screen.getByTestId("crew-propose-submit") as HTMLButtonElement;

describe("CrewProposeForm preview", () => {
  it("does not price the example until the instance's cut is known, and can still be proposed", () => {
    form(null);
    fill("crewmate", "2000");
    expect(preview().getAttribute("data-recipient-cents")).toBe("");
    expect(preview().textContent).toContain(t("splits.preview.loading"));
    expect(submit().disabled).toBe(false);
  });

  it("prices the example once the cut is known", () => {
    form(0.9);
    fill("crewmate", "2000");
    expect(preview().getAttribute("data-recipient-cents")).toBe("180");
    expect(submit().disabled).toBe(false);
  });

  it("explains an incomplete split whether or not the cut is known", () => {
    for (const share of [null, 0.9]) {
      form(share);
      fill("", "2000");
      expect(preview().getAttribute("data-recipient-cents")).toBe("");
      expect(preview().textContent).toContain(t("splits.preview.invalid"));
      expect(submit().disabled).toBe(true);
      cleanup();
    }
  });
});
