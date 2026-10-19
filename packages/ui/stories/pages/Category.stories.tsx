// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { FavouriteIcon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Breadcrumbs, PageTabs } from "@commonair/ui/blocks/headers";
import { FilterBar } from "@commonair/ui/blocks/data";
import { CategoryHeader, StreamGrid } from "@commonair/ui/blocks/media";
import { breadcrumbs, category, languages, sorts, streams, tabs } from "./fixtures/Category.ts";
import { channelHref } from "./fixtures/streams.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/Category", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function CategoryPage(): React.JSX.Element {
  const [tag, setTag] = React.useState("");
  const [language, setLanguage] = React.useState("all");
  const [hideMature, setHideMature] = React.useState(false);
  const [sort, setSort] = React.useState("fair");
  const shown = streams.filter(
    (stream) =>
      (!hideMature || !stream.broadcast.mature) &&
      (tag === "" || stream.tags.some((t) => t.toLowerCase().includes(tag.toLowerCase()))),
  );
  return (
    <ViewerPage current="browse">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <Breadcrumbs label="Breadcrumb" items={breadcrumbs} />
        <div className="flex flex-col gap-3">
          <CategoryHeader
            name={category.name}
            accent={category.accent}
            headingLevel={1}
            variant="vod"
            meta={category.meta}
            tags={category.tags}
            actions={
              <>
                <Button>
                  <HugeiconsIcon icon={FavouriteIcon} aria-hidden="true" />
                  Follow category
                </Button>
                <IconButton label="More" icon={MoreHorizontalIcon} variant="outline" />
              </>
            }
          />
          <p className="max-w-prose">{category.description}</p>
        </div>
        <PageTabs items={tabs} />
        <FilterBar
          searchLabel="Filter by tag"
          searchValue={tag}
          onSearchChange={setTag}
          filters={[
            {
              id: "category-language",
              label: "Language",
              value: language,
              options: languages,
              onValueChange: setLanguage,
            },
          ]}
          switchLabel="Hide mature"
          switchChecked={hideMature}
          onSwitchChange={setHideMature}
          toggleLabel="Sort"
          toggleValue={sort}
          toggleOptions={sorts}
          onToggleChange={setSort}
        />
        <StreamGrid
          streams={shown}
          hrefFor={channelHref}
          footer={
            <Button variant="outline" className="self-center">
              Show more
            </Button>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <CategoryPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
