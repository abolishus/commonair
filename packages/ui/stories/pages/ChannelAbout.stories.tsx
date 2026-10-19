// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar01Icon,
  MoreHorizontalIcon,
  Notification01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { AccentButton, IconButton, OverlayBadge, StatusBadge } from "@commonair/ui";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageTabs, Section } from "@commonair/ui/blocks/headers";
import { ListPanel } from "@commonair/ui/blocks/data";
import { ChannelHeader, MediaGrid, PlayerChrome } from "@commonair/ui/blocks/media";
import { about, channel, clips, offline, rules, schedule, supporters, tabs, vods } from "./fixtures/ChannelAbout.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Channel/ChannelAbout", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const allLink = (label: string, href: string): React.JSX.Element => (
  <Button variant="ghost" size="xs" render={<a href={href} />} nativeButton={false}>
    {label}
  </Button>
);

function ChannelAboutPage(): React.JSX.Element {
  return (
    <div data-accent={channel.accent}>
      <ViewerPage>
        <PageContainer width="wide" className="flex flex-col gap-6 py-6">
          <ChannelHeader
            name={channel.name}
            accent={channel.accent}
            variant="offline"
            offlineLabel="Offline"
            badges={<Badge variant="secondary">Co-op member</Badge>}
            meta={channel.meta}
            actions={
              <>
                <Button variant="secondary">
                  <HugeiconsIcon icon={Tick01Icon} aria-hidden="true" />
                  Following
                </Button>
                <IconButton label="Go-live notifications on" icon={Notification01Icon} />
                <Button variant="outline" render={<a href="#support" />} nativeButton={false}>
                  Subscribe
                </Button>
                <IconButton label="More actions" icon={MoreHorizontalIcon} />
              </>
            }
          />
          <PageTabs items={tabs} />
          <SplitLayout
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-8">
                <PlayerChrome
                  variant="offline"
                  stage={
                    <div className="flex flex-col items-center gap-2">
                      <OverlayBadge>Offline</OverlayBadge>
                      <p>{offline.next}</p>
                      <p>{offline.show}</p>
                      <Button size="sm" render={<a href="#vod" />} nativeButton={false}>
                        Watch latest broadcast
                      </Button>
                    </div>
                  }
                >
                  {null}
                </PlayerChrome>
                <Section heading="Recent broadcasts" action={allLink("All videos", "#videos")}>
                  <MediaGrid media={vods} hrefFor={(video) => `#vod/${video.id}`} />
                </Section>
                <Section heading="Popular clips" action={allLink("All clips", "#clips")}>
                  <MediaGrid media={clips} hrefFor={(clip) => `#clip/${clip.id}`} />
                </Section>
              </div>
            }
            aside={
              <div className="flex flex-col gap-4">
                <ListPanel
                  title={
                    <span className="flex items-center gap-2">
                      <HugeiconsIcon icon={Calendar01Icon} aria-hidden="true" />
                      Schedule
                    </span>
                  }
                  action={<StatusBadge tone="neutral">UTC</StatusBadge>}
                  items={schedule.map((slot) => ({
                    id: slot.id,
                    media: (
                      <span className="flex flex-col">
                        <span>{slot.day}</span>
                        <span>{slot.date}</span>
                      </span>
                    ),
                    title: slot.title,
                    description: slot.time,
                    actions: slot.next ? <StatusBadge tone="accent">Next</StatusBadge> : undefined,
                  }))}
                  footer={
                    <Button variant="outline" size="sm">
                      <HugeiconsIcon icon={Calendar01Icon} aria-hidden="true" />
                      Add to calendar (.ics)
                    </Button>
                  }
                />
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>About</CardTitle>
                    <CardDescription>{about.text}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {about.links.map((link) => (
                      <Badge key={link} variant="outline" render={<a href={`#${link.toLowerCase()}`} />}>
                        {link}
                      </Badge>
                    ))}
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Chat rules</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ol className="flex flex-col gap-1">
                      {rules.map((rule, index) => (
                        <li key={rule}>
                          {index + 1}. {rule}
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Supporters</CardTitle>
                    <CardDescription>{supporters}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <AccentButton accent={channel.accent} size="sm" render={<a href="#support" />} nativeButton={false}>
                      Support {channel.name}
                    </AccentButton>
                  </CardContent>
                </Card>
              </div>
            }
          />
        </PageContainer>
      </ViewerPage>
    </div>
  );
}

export const Default: Story = { render: () => <ChannelAboutPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
