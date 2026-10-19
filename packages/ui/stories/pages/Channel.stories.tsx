// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Coins01Icon,
  Dollar01Icon,
  FavouriteIcon,
  FullScreenIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PictureInPictureOnIcon,
  Scissor01Icon,
  Settings02Icon,
  Share08Icon,
  SmileIcon,
  StarIcon,
  Tv01Icon,
  UserGroupIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { AccentButton, ChannelAvatar, IconButton, OverlayBadge, StatusBadge } from "@commonair/ui";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Slider } from "@commonair/ui/components/slider";
import { PageContainer, ResponsiveGrid, SplitLayout } from "@commonair/ui/layouts";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { PollCard, ProgressRow } from "@commonair/ui/blocks/data";
import {
  ChannelHeader,
  ChatComposer,
  ChatMessage,
  ChatPanel,
  PlayerChrome,
  PlayerControl,
} from "@commonair/ui/blocks/media";
import { channel, chat, messages, panels, pinned, poll, tabs } from "./fixtures/Channel.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Channel/Channel", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function ChannelPage(): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  return (
    <div data-accent={channel.accent}>
      <ViewerPage footer={false}>
        <PageContainer width="wide" className="py-4">
          <SplitLayout
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-4">
                <PlayerChrome
                  variant="live"
                  topStart={<OverlayBadge>{channel.quality}</OverlayBadge>}
                  topEnd={<OverlayBadge>CC</OverlayBadge>}
                  stage={<ChannelAvatar name={channel.name} accent={channel.accent} size="xl" decorative />}
                  timeLabel={channel.time}
                  controls={
                    <>
                      <PlayerControl label="Pause" icon={PauseIcon} />
                      <PlayerControl label="Mute" icon={VolumeHighIcon} />
                      <Slider aria-label="Volume" defaultValue={[70]} max={100} className="max-w-20" />
                      <PlayerControl label="Create clip" icon={Scissor01Icon} />
                      <PlayerControl label="Settings" icon={Settings02Icon} />
                      <PlayerControl label="Picture in picture" icon={PictureInPictureOnIcon} />
                      <PlayerControl label="Theatre mode" icon={Tv01Icon} />
                      <PlayerControl label="Fullscreen" icon={FullScreenIcon} />
                    </>
                  }
                >
                  {null}
                </PlayerChrome>
                <ChannelHeader
                  aria-label="Stream info"
                  name={channel.name}
                  accent={channel.accent}
                  live
                  title={channel.title}
                  badges={<Badge variant="secondary">Co-op member</Badge>}
                  category={<a href="#category/science">{channel.category}</a>}
                  tags={channel.tags}
                  viewerCount={channel.viewers}
                  followers={<span>{channel.followers}</span>}
                  actions={
                    <>
                      <AccentButton accent={channel.accent}>
                        <HugeiconsIcon icon={FavouriteIcon} aria-hidden="true" />
                        Follow
                      </AccentButton>
                      <Button variant="outline" render={<a href="#support" />} nativeButton={false}>
                        <HugeiconsIcon icon={StarIcon} aria-hidden="true" />
                        Subscribe
                      </Button>
                      <Button variant="outline" render={<a href="#support" />} nativeButton={false}>
                        <HugeiconsIcon icon={Dollar01Icon} aria-hidden="true" />
                        Tip
                      </Button>
                      <IconButton label="Share" icon={Share08Icon} />
                      <IconButton label="More actions" icon={MoreHorizontalIcon} />
                    </>
                  }
                />
                <PageTabs items={tabs} />
                <ResponsiveGrid cols={3}>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>{panels.about.title}</CardTitle>
                      <CardDescription>{panels.about.text}</CardDescription>
                    </CardHeader>
                  </Card>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>{panels.goal.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ProgressRow
                        label={panels.goal.label}
                        value={(panels.goal.current / panels.goal.target) * 100}
                        valueText={`${panels.goal.current} / ${panels.goal.target}`}
                        tone="accent"
                      />
                    </CardContent>
                  </Card>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>{panels.gear.title}</CardTitle>
                      <CardDescription>{panels.gear.text}</CardDescription>
                    </CardHeader>
                  </Card>
                </ResponsiveGrid>
              </div>
            }
            aside={
              <ChatPanel
                aria-label="Stream chat"
                title="Stream chat"
                logLabel="Chat messages"
                newMessagesLabel="New messages"
                collapseAction={<IconButton label="Collapse chat" icon={ArrowRight01Icon} size="icon-xs" />}
                viewersAction={<IconButton label="Viewer list" icon={UserGroupIcon} size="icon-xs" />}
                pinned={
                  <div className="flex flex-col gap-2">
                    <ChatMessage author={pinned.author} colorIndex={pinned.colorIndex} body={pinned.body} />
                    <PollCard
                      question={poll.question}
                      timeLeft={poll.timeLeft}
                      totalVotes={poll.totalVotes}
                      options={poll.options}
                    />
                  </div>
                }
                footer={
                  <ChatComposer
                    value={draft}
                    onValueChange={setDraft}
                    onSubmit={() => setDraft("")}
                    placeholder="Send a message"
                    sendLabel="Chat"
                    emoteAction={<IconButton label="Emotes" icon={SmileIcon} size="icon-xs" />}
                    pointsAction={
                      <Button variant="ghost" size="xs" aria-label={`Channel points: ${chat.points}`}>
                        <HugeiconsIcon icon={Coins01Icon} aria-hidden="true" />
                        {chat.points}
                      </Button>
                    }
                    modeNote={
                      <div className="flex items-center gap-2">
                        <IconButton label="Chat settings" icon={Settings02Icon} size="icon-xs" />
                        <StatusBadge tone="neutral">{chat.slowMode}</StatusBadge>
                      </div>
                    }
                  />
                }
              >
                {messages.map((message) => (
                  <ChatMessage
                    key={message.id}
                    author={message.author}
                    colorIndex={message.colorIndex}
                    body={message.body}
                    badges={message.badges}
                    notice={message.notice}
                    highlight={message.highlight}
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

export const Default: Story = { render: () => <ChannelPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
