// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  Edit02Icon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { IconButton, StatusBadge } from "@commonair/ui";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { DataTable, FilterBar, type DataTableColumn } from "@commonair/ui/blocks/data";
import { MediaCard } from "@commonair/ui/blocks/media";
import { notes, tabs, videos, visibilities, type VideoRow } from "./fixtures/Content.ts";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Content", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const columns: DataTableColumn<VideoRow>[] = [
  {
    id: "video",
    header: "Video",
    cell: ({ row }) => (
      <MediaCard
        layout="compact"
        media={{
          id: row.original.id,
          title: row.original.title,
          accent: "violet",
          duration: row.original.duration,
          views: `${row.original.date} · ${row.original.category}`,
        }}
      />
    ),
  },
  {
    id: "visibility",
    header: "Visibility",
    cell: ({ row }) => <StatusBadge tone={row.original.tone}>{row.original.visibility}</StatusBadge>,
  },
  { id: "views", header: "Views", accessorKey: "views", align: "numeric" },
  { id: "expires", header: "Expires", accessorKey: "expires" },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => (
      <div className="flex gap-1">
        <IconButton label={`Edit ${row.original.title}`} icon={Edit02Icon} size="icon-sm" />
        <IconButton label={`More for ${row.original.title}`} icon={MoreHorizontalIcon} size="icon-sm" />
      </div>
    ),
  },
];

function ContentPage(): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [visibility, setVisibility] = React.useState("all");
  const shown = videos.filter((video) => video.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <StudioPage current="content">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Videos & clips"
          actions={
            <Button variant="outline" size="sm">
              <HugeiconsIcon icon={Upload01Icon} aria-hidden="true" />
              Upload video
            </Button>
          }
          tabs={<PageTabs items={tabs} />}
        />
        <FilterBar
          searchLabel="Search videos"
          searchValue={query}
          onSearchChange={setQuery}
          filters={[
            {
              id: "content-visibility",
              label: "Visibility",
              value: visibility,
              options: visibilities,
              onValueChange: setVisibility,
            },
          ]}
        />
        <DataTable
          caption="Videos"
          columns={columns}
          rows={shown}
          getRowId={(row) => row.id}
          selectable
          selectionLabel="Select video"
          selectionToolbar={(selected, clear) => (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span>{selected.length} selected</span>
              <Button variant="outline" size="sm" onClick={clear}>
                Highlight
              </Button>
              <Button variant="destructive" size="sm" onClick={clear}>
                Delete
              </Button>
            </div>
          )}
        />
        <ResponsiveGrid cols={2}>
          <Alert>
            <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
            <AlertDescription>{notes.retention}</AlertDescription>
          </Alert>
          <Alert>
            <HugeiconsIcon icon={Alert01Icon} aria-hidden="true" />
            <AlertDescription>
              <p>
                {notes.claim} <a href="#claims">Review or counter-notice</a>.
              </p>
            </AlertDescription>
          </Alert>
        </ResponsiveGrid>
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <ContentPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
