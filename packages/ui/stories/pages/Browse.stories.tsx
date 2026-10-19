// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { FilterBar } from "@commonair/ui/blocks/data";
import { CategoryGrid } from "@commonair/ui/blocks/media";
import { categories, languages, sorts, tabs, tags } from "./fixtures/Browse.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/Browse", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function BrowsePage(): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [language, setLanguage] = React.useState("all");
  const [sort, setSort] = React.useState("viewers");
  const [selectedTags, setSelectedTags] = React.useState<string[]>(["all"]);
  const shown = categories.filter((category) => category.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <ViewerPage current="browse">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Browse"
          description="Every live channel, every category. Counts are verified viewers only."
          tabs={<PageTabs items={tabs} />}
        />
        <FilterBar
          searchLabel="Filter categories"
          searchValue={query}
          onSearchChange={setQuery}
          filters={[
            { id: "browse-language", label: "Language", value: language, options: languages, onValueChange: setLanguage },
            { id: "browse-sort", label: "Sort", value: sort, options: sorts, onValueChange: setSort },
          ]}
          toggleLabel="Popular tags"
          tags={tags}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
        />
        <CategoryGrid
          categories={shown}
          hrefFor={(category) => `#category/${category.id}`}
          liveLabel={(formatted) => `${formatted} live`}
          viewerLabel={(formatted) => `${formatted} viewers`}
        />
        <Button variant="outline" className="self-center">
          Load more categories
        </Button>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <BrowsePage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
