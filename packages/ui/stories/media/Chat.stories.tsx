// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatComposer, ChatMessage, ChatPanel, ChatReplayFooter } from "../../src/blocks/media/chat.tsx";
const meta = {
  title: "Blocks/Media/Chat",
  component: ChatPanel,
  args: {
    title: "Stream chat",
    logLabel: "Messages",
    newMessagesLabel: "Jump to latest",
    children: (
      <>
        <ChatMessage
          author="Fernsby"
          colorIndex={5}
          body="Hello!"
          timestamp="10:42"
          badges={[{ kind: "broadcaster", label: "Broadcaster" }]}
        />
        <ChatMessage author="Viewer" colorIndex={2} action body="waves" highlight />
      </>
    ),
    footer: (
      <ChatComposer
        value=""
        onValueChange={() => {}}
        onSubmit={() => {}}
        placeholder="Send a message"
        sendLabel="Send"
        modeNote="Slow mode: 3 seconds"
      />
    ),
  },
} satisfies Meta<typeof ChatPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Replay: Story = { args: { variant: "replay", footer: <ChatReplayFooter>Chat replay</ChatReplayFooter> } };
