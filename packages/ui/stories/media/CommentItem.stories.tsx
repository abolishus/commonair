// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommentItem, CommentList } from "../../src/blocks/media/index.ts";

const meta = {
  title: "Blocks/Media/CommentItem",
  component: CommentItem,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CommentItem>;
export default meta;
type Story = StoryObj;

const Thread = () => (
  <CommentList label="Comments">
    <CommentItem
      author="Wren & Ash"
      accent="amber"
      badge="Streamer member"
      time="2 h ago"
      actions={[
        { id: "helpful", label: "Helpful · 38", pressed: true },
        { id: "reply", label: "Reply" },
      ]}
    >
      <p>Second region first, then revisit the share in a year. The outage in August cost us more than 6 points.</p>
    </CommentItem>
    <CommentItem
      author="kanjikat"
      accent="red"
      badge="Viewer member"
      time="1 h ago"
      actions={[
        { id: "helpful", label: "Helpful · 4" },
        { id: "reply", label: "Reply" },
      ]}
    >
      <p>Can the treasury publish the relay savings first?</p>
    </CommentItem>
    <CommentItem author="a_very_long_member_name_that_should_wrap_on_phones" time="just now">
      <p>Agreed.</p>
    </CommentItem>
  </CommentList>
);

export const Default: Story = { render: () => <Thread /> };
export const Light: Story = { render: () => <Thread />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Thread />, globals: { viewport: { value: "mobile320" } } };
