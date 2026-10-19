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
    .map(async (file) => [file.replace(".stories.tsx", ""), (await import(join(pagesDir, file))) as BoardModule] as const),
);

/** happy-dom does not know the HTML `<search>` landmark (HeaderSearch); real browsers do. */
const isHappyDomGap = (args: unknown[]): boolean => args[0] === "The tag <%s> is unrecognized in this browser. If you meant to render a React component, start its name with an uppercase letter." && args[1] === "search";

const BOARDS = [
  "Main", "Browse", "Category", "Search", "Following", "SignIn", "Settings",
  "Channel", "ChannelAbout", "Vod", "Clip", "Support", "Mobile",
  "StreamManager", "StreamSetup", "Analytics", "Revenue", "Community", "ChatBot", "Content", "Overlays",
  "Coop", "Proposal", "Transparency",
  "Developer", "TrustSafety", "Status", "Finances", "Expenses",
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
    if (name === "Support") expect(screen.getByRole("dialog")).toBeTruthy();
    else expect(screen.getAllByRole("main").length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
