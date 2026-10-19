// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlayIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { PlayerChrome, PlayerControl, PlayerScrubber } from "../../src/blocks/media/player-chrome.tsx";
const meta = {
  title: "Blocks/Media/PlayerChrome",
  component: PlayerChrome,
  args: {
    variant: "live",
    children: (
      <video aria-label="Stream preview">
        <track kind="captions" />
      </video>
    ),
    topEnd: <span>1080p</span>,
    controls: (
      <>
        <PlayerControl label="Play" icon={PlayIcon} />
        <PlayerControl label="Volume" icon={VolumeHighIcon} />
      </>
    ),
    scrubber: <PlayerScrubber value={35} max={100} label="Seek" valueText="35 seconds" />,
    timeLabel: "LIVE",
  },
} satisfies Meta<typeof PlayerChrome>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Offline: Story = { args: { variant: "offline", stage: <p>Stream is offline</p> } };
