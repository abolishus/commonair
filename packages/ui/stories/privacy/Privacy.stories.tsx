// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  DeletionPanel,
  ExportPanel,
  type DeletionRequestView,
  type ExportRowData,
} from "../../src/blocks/privacy/index.ts";
import {
  deletionLabels,
  deletionScheduled,
  exportCooldown,
  exportKinds,
  exportLabels,
  exportRows,
} from "../e6-fixtures.tsx";

const meta = { title: "Blocks/Privacy/Privacy panels" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({
  rows = exportRows,
  cooldown = exportCooldown,
  deletion = null,
}: {
  rows?: ExportRowData[] | null;
  cooldown?: string | null;
  deletion?: DeletionRequestView | null;
}): React.JSX.Element {
  const [request, setRequest] = React.useState(deletion);
  return (
    <div className="flex flex-col gap-6">
      <ExportPanel kinds={exportKinds(cooldown)} exports={rows} labels={exportLabels} onRequest={() => undefined} />
      <DeletionPanel
        request={request}
        labels={deletionLabels}
        username="fernsby"
        onRequest={() => setRequest(deletionScheduled)}
        onCancel={() =>
          setRequest((current) => (current ? { ...current, status: "canceled", statusLabel: "Canceled" } : null))
        }
      />
    </div>
  );
}

export const Default: Story = { render: () => <Example /> };
export const Light: Story = { render: () => <Example />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Example />, globals: { viewport: { value: "mobile320" } } };
export const Empty: Story = { render: () => <Example rows={[]} cooldown={null} /> };
export const Loading: Story = { render: () => <Example rows={null} /> };
export const DeletionScheduled: Story = { render: () => <Example deletion={deletionScheduled} /> };
