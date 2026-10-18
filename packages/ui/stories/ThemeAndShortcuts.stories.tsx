// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { Kbd, LocaleProvider, Shortcut, ThemeToggle, applyTheme, type Theme } from "../src/index.ts";

function ThemeDemo() {
  const [theme, setTheme] = React.useState<Theme>("dark");
  return (
    <ThemeToggle
      value={theme}
      onValueChange={(next) => {
        // A real app persists the choice here (account setting or cookie).
        setTheme(next);
        applyTheme(next);
      }}
    />
  );
}

const meta = { title: "Primitives/ThemeToggle and Shortcut", component: ThemeDemo } satisfies Meta<typeof ThemeDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Toggle: Story = {};
export const ToggleTranslated: Story = {
  render: () => (
    <LocaleProvider
      locale="de"
      messages={{ theme: { label: "Design", dark: "Dunkel", light: "Hell", system: "System" } }}
    >
      <ThemeDemo />
    </LocaleProvider>
  ),
};

export const Shortcuts: Story = {
  render: () => (
    <dl className="grid grid-cols-[auto_auto_auto] items-center gap-x-6 gap-y-2 text-sm">
      {[["mod", "k"], ["shift", "?"], ["alt", "arrowup"], ["mod", "shift", "enter"], ["escape"]].map((keys) => (
        <React.Fragment key={keys.join("+")}>
          <dt className="text-muted-foreground">{keys.join(" + ")}</dt>
          <dd>
            <Shortcut keys={keys} platform="mac" />
          </dd>
          <dd>
            <Shortcut keys={keys} platform="other" />
          </dd>
        </React.Fragment>
      ))}
      <dt className="text-muted-foreground">single key</dt>
      <dd>
        <Kbd>F</Kbd>
      </dd>
      <dd />
    </dl>
  ),
};

export const ShortcutsLight: Story = { ...Shortcuts, globals: { theme: "light" } };
