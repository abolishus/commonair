// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { Home01Icon, Moon02Icon, Settings01Icon, Tv01Icon } from "@hugeicons/core-free-icons";
import { Button } from "../src/components/button.tsx";
import { CommandPalette, Shortcut, type CommandPaletteGroup } from "../src/index.ts";
import { toast } from "../src/toast.tsx";
import { LONG_TITLE } from "./fixtures.ts";

const run = (what: string) => () => toast.info(what);

const GROUPS: CommandPaletteGroup[] = [
  {
    id: "pages",
    label: "Go to",
    items: [
      { id: "home", label: "Home", icon: Home01Icon, shortcut: ["g", "h"], onSelect: run("Home") },
      { id: "following", label: "Following", icon: Tv01Icon, onSelect: run("Following") },
      {
        id: "settings",
        label: "Settings",
        icon: Settings01Icon,
        keywords: ["preferences", "account"],
        onSelect: run("Settings"),
      },
      { id: "long", label: LONG_TITLE, onSelect: run("Long") },
    ],
  },
  {
    id: "actions",
    label: "Actions",
    items: [
      { id: "theme", label: "Toggle theme", icon: Moon02Icon, shortcut: ["mod", "j"], onSelect: run("Theme") },
      { id: "archived", label: "Archived action", disabled: true, onSelect: run("never") },
    ],
  },
];

function Demo({ groups = GROUPS, initiallyOpen = true }: { groups?: CommandPaletteGroup[]; initiallyOpen?: boolean }) {
  const [open, setOpen] = React.useState(initiallyOpen);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Search <Shortcut keys={["mod", "k"]} />
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} groups={groups} hotkey="k" />
    </>
  );
}

const meta = { title: "Primitives/CommandPalette", component: Demo } satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
export const Closed: Story = { args: { initiallyOpen: false } };
export const Empty: Story = { args: { groups: [] } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const RightToLeft: Story = { globals: { dir: "rtl" } };
