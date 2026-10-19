// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FilterBar } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/FilterBar", component: FilterBar, parameters: { layout: "padded" } } satisfies Meta<
  typeof FilterBar
>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <FilterBar
      searchLabel="Search streams"
      onSearchChange={() => {}}
      filters={[
        {
          id: "category",
          label: "Category",
          value: "all",
          options: [
            { value: "all", label: "All categories" },
            { value: "music", label: "Music" },
          ],
          onValueChange: () => {},
        },
      ]}
      toggleLabel="Sort"
      toggleValue="popular"
      toggleOptions={[
        { value: "popular", label: "Popular" },
        { value: "recent", label: "Recent" },
      ]}
      onToggleChange={() => {}}
      switchLabel="Hide mature"
      onSwitchChange={() => {}}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
