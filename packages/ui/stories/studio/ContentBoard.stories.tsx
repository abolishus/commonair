// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../../src/components/button.tsx";
import { ContentBoard, type ClipRowData, type VodRowData } from "../../src/blocks/studio/index.ts";
import { clips as sampleClips, contentLabels, vods as sampleVods } from "../e6-fixtures.tsx";

const meta = { title: "Blocks/Studio/ContentBoard" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({
  initialVods = sampleVods,
  initialClips = sampleClips,
  withActions = false,
}: {
  initialVods?: VodRowData[] | null;
  initialClips?: ClipRowData[] | null;
  withActions?: boolean;
}): React.JSX.Element {
  const [vods, setVods] = React.useState(initialVods);
  const [clips, setClips] = React.useState(initialClips);
  return (
    <ContentBoard
      vods={vods}
      clips={clips}
      labels={contentLabels}
      onSaveVod={(id, update) =>
        setVods((current) => current?.map((v) => (v.id === id ? { ...v, ...update } : v)) ?? null)
      }
      onDeleteVod={(id) => setVods((current) => current?.filter((v) => v.id !== id) ?? null)}
      onDeleteClip={(id) => setClips((current) => current?.filter((c) => c.id !== id) ?? null)}
      emptyActions={
        withActions
          ? {
              vods: <Button size="sm">Turn on recording</Button>,
              clips: <Button size="sm">Open stream manager</Button>,
            }
          : undefined
      }
    />
  );
}

export const Default: Story = { render: () => <Example /> };
export const Light: Story = { render: () => <Example />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Example />, globals: { viewport: { value: "mobile320" } } };
export const Empty: Story = { render: () => <Example initialVods={[]} initialClips={[]} /> };
export const Loading: Story = { render: () => <Example initialVods={null} initialClips={null} /> };
/** F25: each empty list offers the action that fills it. */
export const EmptyWithActions: Story = { render: () => <Example initialVods={[]} initialClips={[]} withActions /> };
export const EmptyWithActionsLight: Story = { ...EmptyWithActions, globals: { theme: "light" } };
export const EmptyWithActions320: Story = { ...EmptyWithActions, globals: { viewport: { value: "mobile320" } } };
