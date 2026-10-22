// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../../src/components/button.tsx";
import { OverlayAlertsView, useAlertQueue, type OverlayAlertItem } from "../../src/blocks/overlay/index.ts";
import { overlayAlerts } from "../e6-fixtures.tsx";

const meta = { title: "Blocks/Overlay/OverlayAlerts", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A stand-in stream frame behind the transparent overlay, so the outline can be judged. */
function Stage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="bg-linear-to-br from-chart-1 via-muted to-chart-4">{children}</div>;
}

function Queue({ reducedMotion }: { reducedMotion?: boolean }): React.JSX.Element {
  const queue = useAlertQueue();
  const [count, setCount] = React.useState(0);
  const push = (): void => {
    const base = overlayAlerts[count % overlayAlerts.length] as OverlayAlertItem;
    queue.enqueue({ ...base, id: `${base.id}-${count}` });
    setCount((n) => n + 1);
  };
  const { enqueue } = queue;
  React.useEffect(() => {
    enqueue(overlayAlerts[0] as OverlayAlertItem);
  }, [enqueue]);
  return (
    <Stage>
      <div className="fixed top-4 left-4 z-10">
        <Button type="button" size="sm" onClick={push}>
          Queue another · {queue.pending} waiting
        </Button>
      </div>
      <OverlayAlertsView state="live" alert={queue.current} reducedMotion={reducedMotion} />
    </Stage>
  );
}

const still = overlayAlerts[0] as OverlayAlertItem;

export const Default: Story = { render: () => <Queue /> };
export const Light: Story = { render: () => <Queue />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Queue />, globals: { viewport: { value: "mobile320" } } };
export const ReducedMotion: Story = { render: () => <Queue reducedMotion /> };
export const Still: Story = {
  render: () => (
    <Stage>
      <OverlayAlertsView state="live" alert={still} reducedMotion />
    </Stage>
  ),
};
export const Refused: Story = {
  render: () => (
    <Stage>
      <OverlayAlertsView state="refused" alert={still} />
    </Stage>
  ),
};
