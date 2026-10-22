// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { ContentBoard } from "@commonair/ui/blocks/studio";
import { notes } from "./fixtures/Content.ts";
import { clips as sampleClips, contentLabels, vods as sampleVods } from "../e6-fixtures.tsx";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Content", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function ContentPage(): React.JSX.Element {
  const [vods, setVods] = React.useState(sampleVods);
  const [clips, setClips] = React.useState(sampleClips);
  return (
    <StudioPage current="content">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="Videos & clips" description="Rename, change who can watch, or delete." />
        <ContentBoard
          vods={vods}
          clips={clips}
          labels={contentLabels}
          onSaveVod={(id, update) =>
            setVods((current) => current.map((vod) => (vod.id === id ? { ...vod, ...update } : vod)))
          }
          onDeleteVod={(id) => setVods((current) => current.filter((vod) => vod.id !== id))}
          onDeleteClip={(id) => setClips((current) => current.filter((clip) => clip.id !== id))}
        />
        <ResponsiveGrid cols={2}>
          <AlertCallout description={notes.retention} />
          <AlertCallout tone="warning" description={notes.claim} />
        </ResponsiveGrid>
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <ContentPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
