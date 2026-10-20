// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { GiftIcon, MoneyBag02Icon, StarIcon } from "@hugeicons/core-free-icons";
import { ChatEvent, ChatMessage, ChatPanel } from "../../src/blocks/media/index.ts";

const meta = { title: "Blocks/Media/ChatEvent" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Sample events among chat messages; all names and amounts are fixture data. */
const Log = () => (
  <div data-accent="teal" className="max-w-sm">
    <ChatPanel title="Stream chat" logLabel="Chat messages" newMessagesLabel="New messages" className="h-96">
      <ChatMessage author="fernsby" colorIndex={5} body="that solder joint is beautiful" />
      <ChatEvent icon={StarIcon} text="mothwing subscribed at Tier 2" />
      <ChatEvent icon={GiftIcon} text="kanjikat gifted 5 Tier 1 subs to the community" />
      <ChatEvent
        icon={MoneyBag02Icon}
        text="Someone tipped"
        amount={{ cents: 500, currency: "USD" }}
        locale="en-US"
        message="For the new microphone. Keep it up!"
      />
      <ChatMessage author="wren" colorIndex={2} body="hype" />
    </ChatPanel>
  </div>
);

export const Default: Story = { render: () => <Log /> };
export const Light: Story = { render: () => <Log />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Log />, globals: { viewport: { value: "mobile320" } } };
export const Tones: Story = {
  render: () => (
    <div data-accent="violet" className="flex max-w-sm flex-col gap-1 text-xs">
      <ChatEvent icon={StarIcon} text="Accent (default)" />
      <ChatEvent icon={StarIcon} tone="success" text="Success" />
      <ChatEvent icon={StarIcon} tone="info" text="Info" />
      <ChatEvent icon={StarIcon} tone="warning" text="Warning" />
    </div>
  ),
};
export const LongText: Story = {
  render: () => (
    <div className="max-w-xs text-xs">
      <ChatEvent
        icon={MoneyBag02Icon}
        text="averyveryverylongusernamewithoutanybreaks tipped"
        amount={{ cents: 1_000_000, currency: "USD" }}
        locale="en-US"
        message={"Supercalifragilisticexpialidocious".repeat(4)}
      />
    </div>
  ),
};
