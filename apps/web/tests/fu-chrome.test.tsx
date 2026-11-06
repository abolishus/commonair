// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Chrome follow-ups in the real header: the account avatar's initial comes from the display name
 * (F38), and the phone sheet opens with the search first and closes when a link in it navigates.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThemeContext } from "../src/lib/theme-context.ts";
import { MEMBER, boot, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({ directory: { home: () => new Promise(() => {}) } }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/components/notifications/bell.tsx", () => ({ NotificationBell: () => null }));

const { AppHeader } = await import("../src/components/site-chrome.tsx");
const { resetHomeFeed } = await import("../src/components/discovery/feed.ts");

const header = (
  <ThemeContext.Provider value={{ theme: "dark", setTheme: () => {} }}>
    <AppHeader />
  </ThemeContext.Provider>
);

beforeEach(() => {
  fake.boot = boot();
  resetHomeFeed();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("the account avatar (F38)", () => {
  it("shows the display name's initial, not the username's", async () => {
    fake.boot = boot({ me: { ...MEMBER, username: "demo_streamer1", displayName: "Aurora Pixel" } });
    await renderInRouter(header, "/");
    const trigger = screen.getByTestId("nav-user");
    expect(trigger.dataset.username).toBe("demo_streamer1");
    expect(trigger.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("A");
  });
});

describe("the phone sheet", () => {
  async function openSheet() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    });
    return screen.findByRole("dialog");
  }

  it("has the search first, above the nav", async () => {
    await renderInRouter(header, "/");
    const dialog = await openSheet();
    const search = dialog.querySelector('[data-testid="header-search"]');
    const nav = dialog.querySelector("nav");
    expect(search).not.toBeNull();
    expect(nav).not.toBeNull();
    expect((search as Node).compareDocumentPosition(nav as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes when a link in it navigates", async () => {
    const { router } = await renderInRouter(header, "/");
    const dialog = await openSheet();
    const browse = dialog.querySelector('[data-testid="nav-directory"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(browse);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/directory"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the route changes some other way", async () => {
    const { router } = await renderInRouter(header, "/");
    await openSheet();
    await act(async () => {
      await router.navigate({ to: "/search" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
