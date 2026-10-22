// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertPreview } from "../../src/blocks/media/index.ts";
import { AlertConfigCard, fillAlertTemplate, type AlertConfigDraft } from "../../src/blocks/studio/index.ts";
import { alertConfigs, alertLabels, alertPreviewValues, alertTitles, alertVariables } from "../e6-fixtures.tsx";

const meta = { title: "Blocks/Studio/AlertConfigCard" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({ type = "tip" }: { type?: string }): React.JSX.Element {
  const [config, setConfig] = React.useState<AlertConfigDraft>(alertConfigs[type] as AlertConfigDraft);
  return (
    <AlertConfigCard
      type={type}
      title={alertTitles[type]}
      config={config}
      variables={alertVariables[type] ?? []}
      currency="USD"
      labels={alertLabels}
      note={type === "raid" ? "Raid alerts fire once raids are available." : undefined}
      onSave={setConfig}
      onTest={() => undefined}
      preview={(draft) => (
        <AlertPreview
          name={alertPreviewValues.user}
          message={draft.showMessage ? alertPreviewValues.message : ""}
          eventLabel={fillAlertTemplate(draft.message, alertPreviewValues)}
          stageLabel="Alert preview"
        />
      )}
    />
  );
}

export const Default: Story = { render: () => <Example /> };
export const Light: Story = { render: () => <Example />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Example />, globals: { viewport: { value: "mobile320" } } };
export const Follow: Story = { render: () => <Example type="follow" /> };
export const Raid: Story = { render: () => <Example type="raid" /> };
