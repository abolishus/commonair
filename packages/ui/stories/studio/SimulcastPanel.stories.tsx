// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SimulcastPanel, type SimulcastTargetRow } from "../../src/blocks/studio/index.ts";
import { simulcastLabels, simulcastPlatforms, simulcastTargets } from "../e6-fixtures.tsx";

const meta = { title: "Blocks/Studio/SimulcastPanel" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({
  initial = simulcastTargets,
  error = null,
}: {
  initial?: SimulcastTargetRow[] | null;
  error?: { reason: string; message: string } | null;
}): React.JSX.Element {
  const [targets, setTargets] = React.useState(initial);
  return (
    <SimulcastPanel
      targets={targets}
      platforms={simulcastPlatforms}
      labels={simulcastLabels}
      error={error}
      onAdd={(values) =>
        setTargets((current) => [
          ...(current ?? []),
          {
            id: `t${(current?.length ?? 0) + 1}`,
            name: values.name,
            platform: values.platform,
            platformLabel: simulcastPlatforms.find((p) => p.value === values.platform)?.label ?? values.platform,
            rtmpUrl: values.rtmpUrl,
            enabled: true,
            status: "idle",
            statusLabel: "Idle",
            lastError: null,
          },
        ])
      }
      onToggle={(id, enabled) =>
        setTargets((current) => current?.map((t) => (t.id === id ? { ...t, enabled } : t)) ?? null)
      }
      onRemove={(id) => setTargets((current) => current?.filter((t) => t.id !== id) ?? null)}
    />
  );
}

const full: SimulcastTargetRow[] = Array.from({ length: 5 }, (_, i) => ({
  ...(simulcastTargets[0] as SimulcastTargetRow),
  id: `full-${i}`,
  name: `Target ${i + 1}`,
}));

export const Default: Story = { render: () => <Example /> };
export const Light: Story = { render: () => <Example />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Example />, globals: { viewport: { value: "mobile320" } } };
export const Empty: Story = { render: () => <Example initial={[]} /> };
export const Loading: Story = { render: () => <Example initial={null} /> };
export const AtLimit: Story = { render: () => <Example initial={full} /> };
export const UrlRefused: Story = {
  render: () => <Example error={{ reason: "private_address", message: "That address is on a private network." }} />,
};
