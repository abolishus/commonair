// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ClosedCaptionIcon,
  FullScreenIcon,
  PauseIcon,
  PictureInPictureOnIcon,
  PlayIcon,
  RectangularIcon,
  Settings02Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import * as React from "react";
import {
  PlayerChrome,
  PlayerControl,
  PlayerScrubber,
  type PlayerChromeProps,
} from "../../src/blocks/media/player-chrome.tsx";
import { Button } from "../../src/components/button.tsx";
import { OverlayBadge } from "../../src/primitives/overlay-badge.tsx";

/** The settings menu's content, as the web app fills it (quality, data saver). */
function Menu({ long = false }: { long?: boolean }) {
  return (
    <>
      <p className="text-sm font-medium">Quality</p>
      <ul className="flex flex-col gap-1">
        {["Auto", "1080p60", "720p", "480p", "Audio only"].map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
      <p className="text-sm font-medium">Data saver</p>
      <p className="text-muted-foreground">
        {long
          ? "Set a budget and the player picks the best quality that fits it, down to audio only. Sharing with other viewers stays off while this is on. Your choice is kept on this device, and a change applies from the next segment without restarting the stream."
          : "Set a budget and the player picks the best quality that fits it."}
      </p>
    </>
  );
}

function Volume(): NonNullable<PlayerChromeProps["volume"]> {
  return {
    muted: false,
    level: 0.6,
    onToggleMute: () => {},
    onLevelChange: () => {},
    muteLabel: "Mute",
    unmuteLabel: "Unmute",
    sliderLabel: "Volume",
    valueText: "60%",
    muteIcon: VolumeHighIcon,
    unmuteIcon: VolumeOffIcon,
    shortcut: "M",
  };
}

const settings = (badge?: React.ReactNode, long = false): NonNullable<PlayerChromeProps["settings"]> => ({
  label: "Settings",
  closeLabel: "Close settings",
  icon: Settings02Icon,
  badge,
  children: <Menu long={long} />,
});

const end = (
  <>
    <PlayerControl label="Picture in picture" icon={PictureInPictureOnIcon} />
    <PlayerControl label="Theatre mode" icon={RectangularIcon} className="hidden md:inline-flex" />
    <PlayerControl label="Fullscreen" icon={FullScreenIcon} />
  </>
);

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
    controlsVisible: true,
    volume: Volume(),
    controls: (
      <>
        <PlayerControl label="Pause" icon={PauseIcon} shortcut="K" />
        <PlayerControl label="Turn captions on" icon={ClosedCaptionIcon} />
      </>
    ),
    settings: settings(),
    controlsEnd: end,
  },
} satisfies Meta<typeof PlayerChrome>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Live at the edge: play, volume, captions, settings, PiP, theatre, fullscreen. */
export const Live: Story = {};
export const LiveLight: Story = { globals: { theme: "light" } };
export const Live320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Live320Light: Story = { globals: { viewport: { value: "mobile320" }, theme: "light" } };

/** Watching behind live: the scrubber over the window, back to live and the distance. */
export const Dvr: Story = {
  args: {
    scrubber: <PlayerScrubber value={1500} max={1800} label="Rewind the live stream" valueText="5:00 behind live" />,
    controls: (
      <>
        <PlayerControl label="Pause" icon={PauseIcon} />
        <Button variant="secondary" size="sm">
          Back to live
        </Button>
        <OverlayBadge>5:00 behind live</OverlayBadge>
      </>
    ),
  },
};
export const DvrLight: Story = { ...Dvr, globals: { theme: "light" } };
export const Dvr320: Story = { ...Dvr, globals: { viewport: { value: "mobile320" } } };

/** A video: elapsed / total and the seek bar; no live badge. */
export const Vod: Story = {
  args: {
    variant: "vod",
    scrubber: <PlayerScrubber value={35} max={600} label="Position in the video" valueText="0:35" />,
    timeLabel: "0:35 / 10:00",
    controls: <PlayerControl label="Play" icon={PlayIcon} />,
  },
};
export const VodLight: Story = { ...Vod, globals: { theme: "light" } };
export const Vod320: Story = { ...Vod, globals: { viewport: { value: "mobile320" } } };

/** Data saver on: the chip before the gear. */
export const DataSaverChip: Story = {
  args: { settings: settings(<OverlayBadge>Data saver · Low</OverlayBadge>) },
};
export const DataSaverChipLight: Story = { ...DataSaverChip, globals: { theme: "light" } };
export const DataSaverChip320: Story = { ...DataSaverChip, globals: { viewport: { value: "mobile320" } } };

/** The menu open, with long text: it scrolls inside the player (over the whole picture at 320 px). */
export const SettingsOpen: Story = {
  args: { settings: { ...settings(undefined, true), open: true } },
};
export const SettingsOpen320: Story = { ...SettingsOpen, globals: { viewport: { value: "mobile320" } } };

/** The one-time hint on the gear. */
export const SettingsHint: Story = {
  args: {
    settings: {
      ...settings(),
      hint: {
        open: true,
        children: (
          <>
            <p className="text-sm font-medium">Quality and Data saver moved</p>
            <p className="text-muted-foreground">They are in the settings menu now, behind this button.</p>
          </>
        ),
      },
    },
  },
};

/** Loading: the stage covers the picture; the gear stays reachable. */
export const Loading: Story = {
  args: { stage: <p>Loading stream…</p>, controls: undefined, volume: undefined, controlsEnd: undefined },
};

/** Hidden after 3 s of playback (the bar's opacity; hover or keyboard focus brings it back). */
export const BarHidden: Story = { args: { controlsVisible: false } };

export const Offline: Story = {
  args: {
    variant: "offline",
    stage: <p>Stream is offline</p>,
    controls: undefined,
    volume: undefined,
    settings: undefined,
    controlsEnd: undefined,
  },
};
