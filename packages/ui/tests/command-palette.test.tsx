// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { CommandPalette, matchesQuery, type CommandPaletteGroup } from "../src/index.ts";

type Spies = Record<"home" | "settings" | "theme" | "cafe", () => void>;

function setup(groupsOverride?: (spies: Spies) => CommandPaletteGroup[]) {
  const spies = {
    home: vi.fn<() => void>(),
    settings: vi.fn<() => void>(),
    theme: vi.fn<() => void>(),
    cafe: vi.fn<() => void>(),
  };
  const groups: CommandPaletteGroup[] = groupsOverride?.(spies) ?? [
    {
      id: "pages",
      label: "Pages",
      items: [
        { id: "home", label: "Home", onSelect: spies.home },
        { id: "settings", label: "Settings", keywords: ["preferences", "account"], onSelect: spies.settings },
        { id: "cafe", label: "Café corner", onSelect: spies.cafe },
      ],
    },
    {
      id: "actions",
      label: "Actions",
      items: [{ id: "theme", label: "Toggle theme", shortcut: ["mod", "j"], onSelect: spies.theme }],
    },
    { id: "empty", label: "Empty group", items: [] },
  ];
  const onOpenChange = vi.fn<(open: boolean) => void>();
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return (
      <CommandPalette
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        groups={groups}
        hotkey="k"
      />
    );
  }
  render(<Harness />);
  return { spies, onOpenChange };
}

describe("matchesQuery", () => {
  const item = { id: "x", label: "Café corner", keywords: ["Coffee"], onSelect: () => {} };
  test("is case- and accent-insensitive and searches keywords", () => {
    expect(matchesQuery(item, "", "en")).toBe(true);
    expect(matchesQuery(item, "cafe", "en")).toBe(true);
    expect(matchesQuery(item, "CORN", "en")).toBe(true);
    expect(matchesQuery(item, "coffee", "en")).toBe(true);
    expect(matchesQuery(item, "tea", "en")).toBe(false);
  });
});

describe("CommandPalette", () => {
  test("opens with mod+K, filters as you type and runs the highlighted item with Enter", async () => {
    const user = userEvent.setup();
    const { spies, onOpenChange } = setup();

    await user.keyboard("{Control>}k{/Control}");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Pages")).toBeTruthy();
    expect(screen.queryByText("Empty group")).toBeNull();

    const input = screen.getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.type(input, "prefer");
    await waitFor(() => expect(screen.queryByText("Home")).toBeNull());
    expect(screen.getByRole("option", { name: "Settings" })).toBeTruthy();

    await user.keyboard("{Enter}");
    expect(spies.settings).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("arrow keys move the highlight across groups", async () => {
    const user = userEvent.setup();
    const { spies } = setup();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(spies.theme).toHaveBeenCalledOnce();
    expect(spies.home).not.toHaveBeenCalled();
  });

  test("shows the empty text when nothing matches, and clicking an item selects it", async () => {
    const user = userEvent.setup();
    const { spies } = setup();
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "zzz");
    expect(await screen.findByText("No results found.")).toBeTruthy();
    await user.clear(input);
    await user.click(await screen.findByRole("option", { name: "Home" }));
    expect(spies.home).toHaveBeenCalledOnce();
  });

  test("disabled items cannot be run", async () => {
    const user = userEvent.setup();
    const { spies } = setup((s) => [
      { id: "g", label: "Group", items: [{ id: "a", label: "Archived", disabled: true, onSelect: s.home }] },
    ]);
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: "Archived" }));
    expect(spies.home).not.toHaveBeenCalled();
  });
});
