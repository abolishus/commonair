// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Smoke test for the page stories: every board's `Default` story renders under the providers the
 * Storybook decorator uses, exposes its `main` landmark (the dialog for Support) and logs no errors.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { LocaleProvider } from "../src/lib/locale.tsx";
import { TooltipProvider } from "../src/components/tooltip.tsx";

interface BoardModule {
  default: { title: string };
  Default: { render: () => React.ReactElement };
  Light: { globals?: Record<string, unknown> };
  Mobile320: { globals?: Record<string, unknown> };
}

const pagesDir = join(import.meta.dirname, "..", "stories", "pages");
const boards = await Promise.all(
  readdirSync(pagesDir)
    .filter((file) => file.endsWith(".stories.tsx"))
    .map(
      async (file) => [file.replace(".stories.tsx", ""), (await import(join(pagesDir, file))) as BoardModule] as const,
    ),
);

/** happy-dom does not know the HTML `<search>` landmark (HeaderSearch); real browsers do. */
const isHappyDomGap = (args: unknown[]): boolean =>
  args[0] ===
    "The tag <%s> is unrecognized in this browser. If you meant to render a React component, start its name with an uppercase letter." &&
  args[1] === "search";

const BOARDS = [
  "Main",
  "Browse",
  "Category",
  "Search",
  "Following",
  "SignIn",
  "Settings",
  "Channel",
  "ChannelAbout",
  "Vod",
  "Clip",
  "Support",
  "Mobile",
  "StreamManager",
  "StreamSetup",
  "Analytics",
  "Revenue",
  "Community",
  "ChatBot",
  "Content",
  "Overlays",
  "Coop",
  "Proposal",
  "Transparency",
  "Developer",
  "TrustSafety",
  "Status",
  "Finances",
  "Expenses",
];

beforeAll(() => {
  // Recharts measures its container; happy-dom has no layout engine.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("page stories", () => {
  test("there is one story file per mockup board", () => {
    expect(boards.map(([name]) => name).sort()).toEqual([...BOARDS].sort());
  });

  test.each(boards)("%s exports Default, Light and Mobile320 under Pages/", (name, mod) => {
    expect(mod.default.title).toMatch(new RegExp(`^Pages/(Viewer|Channel|Creator studio|Co-op|Platform)/${name}$`));
    expect(mod.Light.globals).toEqual({ theme: "light" });
    expect(mod.Mobile320.globals).toEqual({ viewport: { value: "mobile320", isRotated: false } });
  });

  test.each(boards)("%s renders its landmark without console errors", (name, mod) => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (!isHappyDomGap(args)) errors.push(args);
    });
    render(
      <LocaleProvider locale="en">
        <TooltipProvider>{mod.Default.render()}</TooltipProvider>
      </LocaleProvider>,
    );
    const landmarks = name === "Support" ? screen.getAllByRole("dialog") : screen.getAllByRole("main");
    expect(landmarks.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

describe("Support board matches the shipped dialog (manual adapter)", () => {
  const support = boards.find(([name]) => name === "Support")?.[1] as unknown as Record<
    string,
    { render: () => React.ReactElement } | undefined
  >;
  const show = (story: string) =>
    render(
      <LocaleProvider locale="en">
        <TooltipProvider>{support[story]?.render()}</TooltipProvider>
      </LocaleProvider>,
    );

  test("the form splits between creator and co-op only and has no card picker", () => {
    show("Default");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-accent")).toBe("teal");
    expect(screen.getByRole("tablist", { name: "Ways to support" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "90% to the creator, 10% to the co-op" })).toBeTruthy();
    expect(dialog.textContent).toContain("Creator$4.50 · 90%Co-op$0.49 · 10%");
    expect(dialog.textContent).not.toMatch(/processing|Pay with|Card ending/i);
    expect(screen.getByRole("button", { name: "Subscribe for $4.99 / month" })).toBeTruthy();
  });

  test("the instructions step shows the CA- reference and amount instead of the form", () => {
    show("Instructions");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/CA-[0-9A-HJKMNP-TV-Z]{8}/);
    expect(screen.getByRole("button", { name: "Copy reference" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  test("without tiers, sub and gift are disabled and described by the reason", () => {
    show("NoTiers");
    const reason = screen.getByText(/has not set up subscriptions/);
    for (const name of ["Subscribe", "Gift subs"]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.getAttribute("aria-describedby")).toBe(reason.id);
      expect(tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true").toBe(true);
    }
    expect(screen.getByRole("tab", { name: "Tip" }).getAttribute("aria-selected")).toBe("true");
  });
});
