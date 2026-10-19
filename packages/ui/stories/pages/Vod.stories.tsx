// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert01Icon,
  FullScreenIcon,
  GoBackward10SecIcon,
  PlayIcon,
  Scissor01Icon,
  Settings02Icon,
  Share08Icon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { ChannelAvatar, IconButton, OverlayBadge, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { ListPanel } from "@commonair/ui/blocks/data";
import {
  ChatMessage,
  ChatPanel,
  ChatReplayFooter,
  PlayerChrome,
  PlayerControl,
  PlayerScrubber,
} from "@commonair/ui/blocks/media";
import { chapters, replay, video } from "./fixtures/Vod.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Channel/Vod", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function VodPage(): React.JSX.Element {
  const [position, setPosition] = React.useState(video.position);
  return (
    <div data-accent={video.accent}>
      <ViewerPage footer={false}>
        <PageContainer width="wide" className="py-4">
          <SplitLayout
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-4">
                <PlayerChrome
                  variant="vod"
                  topStart={
                    <>
                      <OverlayBadge>Past broadcast</OverlayBadge>
                      <OverlayBadge>{video.chapter}</OverlayBadge>
                    </>
                  }
                  stage={<ChannelAvatar name={video.channel} accent={video.accent} size="xl" decorative />}
                  scrubber={
                    <PlayerScrubber
                      value={position}
                      max={video.duration}
                      label="Seek"
                      valueText={`${video.positionLabel} of ${video.durationLabel}`}
                      onValueChange={(next) => setPosition(Array.isArray(next) ? (next[0] ?? 0) : next)}
                    />
                  }
                  timeLabel={`${video.positionLabel} / ${video.durationLabel}`}
                  controls={
                    <>
                      <PlayerControl label="Play" icon={PlayIcon} />
                      <PlayerControl label="Back 10 seconds" icon={GoBackward10SecIcon} />
                      <PlayerControl label="Mute" icon={VolumeHighIcon} />
                      <Button variant="ghost" size="xs" aria-label="Playback speed">
                        1×
                      </Button>
                      <PlayerControl label="Create clip" icon={Scissor01Icon} />
                      <PlayerControl label="Settings" icon={Settings02Icon} />
                      <PlayerControl label="Fullscreen" icon={FullScreenIcon} />
                    </>
                  }
                >
                  {null}
                </PlayerChrome>
                <PageHeader
                  size="compact"
                  title={video.title}
                  meta={
                    <span className="flex flex-wrap items-center gap-2">
                      <ChannelAvatar name={video.channel} accent={video.accent} size="xs" decorative />
                      <a href="#channel/synthesist_ana">{video.channel}</a>
                      <span>· {video.meta}</span>
                    </span>
                  }
                  actions={
                    <>
                      <Button variant="secondary">Following</Button>
                      <IconButton label="Share at current time" icon={Share08Icon} />
                      <IconButton label="Report" icon={Alert01Icon} />
                    </>
                  }
                />
                <ListPanel
                  title="Chapters"
                  items={chapters.map((chapter) => ({
                    id: chapter.id,
                    media: <span className="tabular-nums">{chapter.time}</span>,
                    title: chapter.title,
                    highlighted: chapter.playing,
                    actions: chapter.playing ? <StatusBadge tone="accent">Playing</StatusBadge> : undefined,
                  }))}
                />
              </div>
            }
            aside={
              <ChatPanel
                aria-label="Chat replay"
                variant="replay"
                title="Chat replay"
                logLabel="Chat replay messages"
                newMessagesLabel="Latest"
                viewersAction={<StatusBadge tone="neutral">synced to {video.positionLabel}</StatusBadge>}
                footer={<ChatReplayFooter>Chat is read-only on past broadcasts.</ChatReplayFooter>}
              >
                {replay.map((message) => (
                  <ChatMessage
                    key={message.id}
                    timestamp={message.timestamp}
                    author={message.author}
                    colorIndex={message.colorIndex}
                    body={message.body}
                  />
                ))}
              </ChatPanel>
            }
          />
        </PageContainer>
      </ViewerPage>
    </div>
  );
}

export const Default: Story = { render: () => <VodPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
