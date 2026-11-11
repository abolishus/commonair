// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { OverlayTokenPanel, type OverlayTokenStatusView } from "../../src/blocks/studio/index.ts";
import { overlayStatus, overlayTokenLabels, overlayUrl, overlayUrls } from "../e6-fixtures.tsx";

const meta = { title: "Blocks/Studio/OverlayTokenPanel" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const inactive: OverlayTokenStatusView = { active: false, createdAt: null, expiresAt: null };

function Example({
  initial = overlayStatus,
  url = null,
}: {
  initial?: OverlayTokenStatusView | null;
  url?: string | null;
}): React.JSX.Element {
  const [status, setStatus] = React.useState(initial);
  const [createdUrls, setCreatedUrls] = React.useState(url ? overlayUrls : null);
  return (
    <OverlayTokenPanel
      status={status}
      createdUrls={createdUrls}
      labels={overlayTokenLabels}
      onCreate={(expiresAt) => {
        setStatus({ active: true, createdAt: new Date().toISOString(), expiresAt });
        setCreatedUrls(overlayUrls);
      }}
      onRevoke={() => {
        setStatus(inactive);
        setCreatedUrls(null);
      }}
    />
  );
}

export const Default: Story = { render: () => <Example /> };
export const Light: Story = { render: () => <Example />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Example />, globals: { viewport: { value: "mobile320" } } };
export const NoToken: Story = { render: () => <Example initial={inactive} /> };
export const JustCreated: Story = {
  render: () => <Example initial={{ ...overlayStatus, expiresAt: null }} url={overlayUrl} />,
};
export const Loading: Story = { render: () => <Example initial={null} /> };
