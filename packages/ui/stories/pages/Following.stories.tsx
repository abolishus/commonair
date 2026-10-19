// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon, Notification01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, IconButton } from "@commonair/ui";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@commonair/ui/components/item";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { FilterBar } from "@commonair/ui/blocks/data";
import { CategoryGrid, StreamGrid } from "@commonair/ui/blocks/media";
import { followedCategories, live, offline, offlineSorts, tabs } from "./fixtures/Following.ts";
import { channelHref } from "./fixtures/streams.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/Following", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function FollowingPage(): React.JSX.Element {
  const [sort, setSort] = React.useState("recent");
  return (
    <ViewerPage current="following">
      <PageContainer width="wide" className="flex flex-col gap-8 py-6">
        <PageHeader title="Following" tabs={<PageTabs items={tabs} />} />
        <Section heading="Live now">
          <StreamGrid streams={live} hrefFor={channelHref} />
        </Section>
        <SplitLayout
          asideWidth="lg"
          main={
            <Section
              heading="Offline"
              description="33 channels"
              action={
                <FilterBar
                  filters={[
                    { id: "offline-sort", label: "Sort offline channels", value: sort, options: offlineSorts, onValueChange: setSort },
                  ]}
                />
              }
            >
              <ItemGroup>
                {offline.map((channel) => (
                  <Item key={channel.name} variant="outline" size="sm">
                    <ItemMedia>
                      <ChannelAvatar name={channel.name} accent={channel.accent} size="sm" decorative />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        <a href={`#channel/${channel.name}`}>{channel.name}</a>
                      </ItemTitle>
                      <ItemDescription>{channel.last}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <HugeiconsIcon icon={Clock01Icon} aria-hidden="true" />
                      <span>{channel.next}</span>
                      <IconButton label={`Notifications for ${channel.name}`} icon={Notification01Icon} size="icon-sm" />
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </Section>
          }
          aside={
            <Section heading="Followed categories">
              <CategoryGrid
                columns={2}
                categories={followedCategories}
                hrefFor={(category) => `#category/${category.id}`}
                liveLabel={(formatted) => `${formatted} live`}
                viewerLabel={(formatted) => formatted}
              />
              <Alert>
                <HugeiconsIcon icon={Notification01Icon} aria-hidden="true" />
                <AlertDescription className="flex flex-col items-start gap-2">
                  <p>Get go-live notifications by email or web push.</p>
                  <Button variant="outline" size="xs" render={<a href="#settings" />} nativeButton={false}>
                    Notification settings
                  </Button>
                </AlertDescription>
              </Alert>
            </Section>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <FollowingPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
