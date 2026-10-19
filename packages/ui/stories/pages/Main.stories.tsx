// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { FavouriteIcon, VolumeMute01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, OverlayBadge, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { ChannelSidebar, PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Section } from "@commonair/ui/blocks/headers";
import { FilterBar, ProgressRow } from "@commonair/ui/blocks/data";
import { CategoryGrid, ChannelHeader, PlayerChrome, PlayerControl, StreamGrid } from "@commonair/ui/blocks/media";
import { categories, featured, liveNow, newLive, sidebarGroups, sortOptions } from "./fixtures/Main.ts";
import { channelHref } from "./fixtures/streams.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/Main", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const liveLabel = (formatted: string): string => `${formatted} live`;
const viewerLabel = (formatted: string): string => `${formatted} viewers`;

function MainPage(): React.JSX.Element {
  const [sort, setSort] = React.useState("fair");
  return (
    <ViewerPage
      current="home"
      sidebar={
        <ChannelSidebar
          label="Channels"
          groups={sidebarGroups}
          callout={
            <>
              Viewer counts are verified. Discovery rotates small channels into every page.{" "}
              <a href="#transparency">How it works</a>
            </>
          }
        />
      }
    >
      <PageContainer width="wide" className="flex flex-col gap-8 py-6">
        <h1 className="sr-only">Home</h1>
        <section aria-label="Featured" data-accent={featured.accent}>
          <SplitLayout
            asideWidth="lg"
            main={
              <PlayerChrome
                variant="live"
                viewerCount={featured.viewers}
                stage={<ChannelAvatar name={featured.name} accent={featured.accent} size="xl" decorative />}
                controls={
                  <>
                    <PlayerControl label="Unmute" icon={VolumeMute01Icon} />
                    <OverlayBadge className="ms-auto">Muted preview</OverlayBadge>
                  </>
                }
              >
                {null}
              </PlayerChrome>
            }
            aside={
              <div className="flex flex-col gap-3">
                <ChannelHeader
                  variant="compact"
                  headingLevel={2}
                  name={featured.name}
                  accent={featured.accent}
                  live
                  category={featured.category}
                  title={featured.title}
                  badges={<StatusBadge tone="accent">Spotlight</StatusBadge>}
                  tags={featured.tags}
                />
                <p>{featured.note}</p>
                <div className="flex flex-wrap gap-2">
                  <Button render={<a href="#channel/rivertide" aria-label="Watch" />} nativeButton={false}>
                    Watch
                  </Button>
                  <Button variant="outline">
                    <HugeiconsIcon icon={FavouriteIcon} aria-hidden="true" />
                    Follow
                  </Button>
                </div>
                <ProgressRow
                  label="Spotlight rotation"
                  value={(featured.rotation.index / featured.rotation.total) * 100}
                  valueText={`${featured.rotation.index} / ${featured.rotation.total}`}
                />
              </div>
            }
          />
        </section>
        <Section
          heading="New and live"
          action={
            <Button variant="ghost" size="xs" render={<a href="#browse" aria-label="Show all" />} nativeButton={false}>
              Show all
            </Button>
          }
        >
          <StreamGrid streams={newLive} hrefFor={channelHref} columns="default" />
        </Section>
        <Section
          heading="Categories with live channels"
          action={
            <Button
              variant="ghost"
              size="xs"
              render={<a href="#browse" aria-label="Browse all" />}
              nativeButton={false}
            >
              Browse all
            </Button>
          }
        >
          <CategoryGrid
            categories={categories}
            hrefFor={(category) => `#category/${category.id}`}
            liveLabel={liveLabel}
            viewerLabel={viewerLabel}
          />
        </Section>
        <Section
          heading="Live now"
          action={
            <FilterBar toggleLabel="Sort" toggleValue={sort} toggleOptions={sortOptions} onToggleChange={setSort} />
          }
        >
          <StreamGrid
            streams={liveNow}
            hrefFor={channelHref}
            footer={
              <Button variant="outline" className="self-center">
                Show more
              </Button>
            }
          />
        </Section>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <MainPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
