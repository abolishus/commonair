// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FullScreenIcon, PauseIcon, Settings02Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { AccentButton, ChannelAvatar, IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { AppShell, PageContainer } from "@commonair/ui/layouts";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { ChannelHeader, ChatComposer, ChatMessage, ChatPanel, MediaGrid, PlayerChrome, PlayerControl } from "@commonair/ui/blocks/media";
import { phoneMessages } from "./fixtures/Channel.ts";
import { channel, videos } from "./fixtures/Mobile.ts";
import { PhoneHeader, light, mobile320, pageParameters, phone390 } from "./shell.tsx";

const meta = { title: "Pages/Channel/Mobile", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function MobilePage(): React.JSX.Element {
  const [tab, setTab] = React.useState("chat");
  const [draft, setDraft] = React.useState("");
  return (
    <div data-accent={channel.accent}>
      <AppShell header={<PhoneHeader />} footer={null} skipLabel="Skip to content">
        <PlayerChrome
          variant="live"
          viewerCount={channel.viewers}
          stage={<ChannelAvatar name={channel.name} accent={channel.accent} size="lg" decorative />}
          controls={
            <>
              <PlayerControl label="Pause" icon={PauseIcon} />
              <PlayerControl label="Settings" icon={Settings02Icon} />
              <PlayerControl label="Fullscreen" icon={FullScreenIcon} />
            </>
          }
        >
          {null}
        </PlayerChrome>
        <PageContainer className="flex flex-col gap-3 py-3">
          <ChannelHeader
            variant="compact"
            name={channel.name}
            accent={channel.accent}
            live
            title={channel.title}
            actions={
              <AccentButton accent={channel.accent} size="lg">
                Follow
              </AccentButton>
            }
          />
          <div className="flex gap-2">
            <Button variant="outline" size="lg" className="grow" render={<a href="#support" />} nativeButton={false}>
              Subscribe
            </Button>
            <Button variant="outline" size="lg" className="grow" render={<a href="#support" />} nativeButton={false}>
              Tip
            </Button>
            <IconButton label="Share" icon={Share08Icon} size="icon-lg" />
          </div>
          <PageTabs
            value={tab}
            onValueChange={setTab}
            items={[
              {
                id: "chat",
                label: "Chat",
                content: (
                  <ChatPanel
                    variant="mobile"
                    title="Chat"
                    logLabel="Chat messages"
                    newMessagesLabel="New messages"
                    footer={
                      <ChatComposer
                        value={draft}
                        onValueChange={setDraft}
                        onSubmit={() => setDraft("")}
                        placeholder="Send a message"
                        sendLabel="Send"
                      />
                    }
                  >
                    {phoneMessages.map((message) => (
                      <ChatMessage
                        key={message.id}
                        author={message.author}
                        colorIndex={message.colorIndex}
                        body={message.body}
                        badges={message.badges}
                        highlight={message.highlight}
                      />
                    ))}
                  </ChatPanel>
                ),
              },
              { id: "about", label: "About", content: <p>{channel.about}</p> },
              { id: "videos", label: "Videos", content: <MediaGrid media={videos} hrefFor={(video) => `#clip/${video.id}`} /> },
            ]}
          />
        </PageContainer>
      </AppShell>
    </div>
  );
}

export const Default: Story = { render: () => <MobilePage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
export const Phone390: Story = { ...Default, ...phone390 };
