// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { OverlayTokenPanel, type OverlayTokenStatusView } from "../../src/blocks/studio/index.ts";
import { overlayStatus, overlayTokenLabels, overlayUrl } from "../e6-fixtures.tsx";

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
  const [createdUrl, setCreatedUrl] = React.useState(url);
  return (
    <OverlayTokenPanel
      status={status}
      createdUrl={createdUrl}
      labels={overlayTokenLabels}
      onCreate={(expiresAt) => {
        setStatus({ active: true, createdAt: new Date().toISOString(), expiresAt });
        setCreatedUrl(overlayUrl);
      }}
      onRevoke={() => {
        setStatus(inactive);
        setCreatedUrl(null);
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
