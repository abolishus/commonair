// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sidebar keeps its open state in memory only: upstream's `sidebar_state` cookie is a
 * Preferences cookie nothing reads, and the cookie policy allows none before consent.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger } from "../src/components/sidebar.tsx";

afterEach(() => {
  cleanup();
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
});

function Shell() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>Menu</SidebarContent>
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

describe("sidebar storage", () => {
  test("toggling writes no cookie and still collapses and expands", async () => {
    const user = userEvent.setup();
    const { container } = render(<Shell />);
    const state = () => container.querySelector("[data-state]")?.getAttribute("data-state");
    expect(state()).toBe("expanded");

    const trigger = screen.getByRole("button", { name: "Toggle sidebar" });
    await user.click(trigger);
    expect(state()).toBe("collapsed");
    await user.click(trigger);
    expect(state()).toBe("expanded");

    expect(document.cookie).not.toContain("sidebar_state");
    expect(document.cookie).toBe("");
  });

  test("the keyboard shortcut writes no cookie either", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.keyboard("{Control>}b{/Control}");
    expect(document.cookie).not.toContain("sidebar_state");
  });
});
