// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChannelAvatar, LiveBadge } from "@commonair/ui";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { ListPanel } from "@commonair/ui/blocks/data";
import { CategoryTile, MediaGrid } from "@commonair/ui/blocks/media";
import { categories, channels, tabs, videos } from "./fixtures/Search.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/Search", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function SearchPage(): React.JSX.Element {
  return (
    <ViewerPage>
      <PageContainer width="narrow" className="flex flex-col gap-8 py-6">
        <PageHeader
          size="compact"
          title="Results for “synth”"
          description="5 channels · 2 categories · 14 videos"
          tabs={<PageTabs variant="default" items={tabs} />}
        />
        <ListPanel
          variant="bare"
          title="Channels"
          items={channels.map((channel) => ({
            id: channel.name,
            media: (
              <ChannelAvatar name={channel.name} accent={channel.accent} size="md" live={channel.live} decorative />
            ),
            title: (
              <span className="flex flex-wrap items-center gap-2">
                <a href={`#channel/${channel.name}`}>{channel.name}</a>
                {channel.live ? <LiveBadge size="sm" /> : null}
                {channel.member ? <Badge variant="secondary">Co-op member</Badge> : null}
              </span>
            ),
            description: channel.sub,
            actions: (
              <>
                <span>{channel.followers} followers</span>
                <Button variant="outline" size="sm">
                  Follow
                </Button>
              </>
            ),
          }))}
        />
        <Section heading="Categories">
          <div className="flex flex-wrap gap-4">
            {categories.map((category) => (
              <CategoryTile
                key={category.id}
                layout="chip"
                category={category}
                href={`#category/${category.id}`}
                liveLabel={(formatted) => `${formatted} live`}
                viewerLabel={(formatted) => `${formatted} viewers · ${category.note}`}
              />
            ))}
          </div>
        </Section>
        <Section
          heading="Videos"
          action={
            <Button
              variant="ghost"
              size="xs"
              render={<a href="#search?q=synth&type=videos" aria-label="All 14 videos" />}
              nativeButton={false}
            >
              All 14 videos
            </Button>
          }
        >
          <MediaGrid media={videos} hrefFor={(video) => `#video/${video.id}`} />
        </Section>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <SearchPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
