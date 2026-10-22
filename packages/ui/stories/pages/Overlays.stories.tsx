// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageContainer, SectionNav, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { AlertPreview } from "@commonair/ui/blocks/media";
import {
  AlertConfigCard,
  OverlayTokenPanel,
  fillAlertTemplate,
  type AlertConfigDraft,
  type OverlayTokenStatusView,
} from "@commonair/ui/blocks/studio";
import { overlays } from "./fixtures/Overlays.ts";
import {
  alertConfigs,
  alertLabels,
  alertPreviewValues,
  alertTitles,
  alertVariables,
  overlayStatus,
  overlayTokenLabels,
  overlayUrl,
} from "../e6-fixtures.tsx";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Overlays", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const TYPES = ["tip", "follow", "subscription", "raid"] as const;

function OverlaysPage(): React.JSX.Element {
  const [configs, setConfigs] = React.useState<Record<string, AlertConfigDraft>>(alertConfigs);
  const [status, setStatus] = React.useState<OverlayTokenStatusView>(overlayStatus);
  const [createdUrl, setCreatedUrl] = React.useState<string | null>(null);
  return (
    <StudioPage current="overlays">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="Alerts & overlays" description="Add the overlay to OBS as a browser source." />
        <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
          <SectionNav label="Overlays" items={overlays} className="shrink-0 lg:w-56" />
          <SplitLayout
            className="flex-1"
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-4">
                {TYPES.map((type) => (
                  <AlertConfigCard
                    key={type}
                    type={type}
                    title={alertTitles[type]}
                    config={configs[type] as AlertConfigDraft}
                    variables={alertVariables[type] ?? []}
                    currency="USD"
                    labels={alertLabels}
                    note={type === "raid" ? "Raid alerts fire once raids are available." : undefined}
                    onSave={(draft) => setConfigs((current) => ({ ...current, [type]: draft }))}
                    onTest={() => undefined}
                    preview={
                      type === "tip"
                        ? (draft) => (
                            <AlertPreview
                              name={alertPreviewValues.user}
                              eventLabel={fillAlertTemplate(draft.message, alertPreviewValues)}
                              message={draft.showMessage ? alertPreviewValues.message : ""}
                              stageLabel="Alert preview"
                            />
                          )
                        : undefined
                    }
                  />
                ))}
              </div>
            }
            aside={
              <OverlayTokenPanel
                status={status}
                createdUrl={createdUrl}
                labels={overlayTokenLabels}
                onCreate={(expiresAt) => {
                  setStatus({ active: true, createdAt: new Date().toISOString(), expiresAt });
                  setCreatedUrl(overlayUrl);
                }}
                onRevoke={() => {
                  setStatus({ active: false, createdAt: null, expiresAt: null });
                  setCreatedUrl(null);
                }}
              />
            }
          />
        </div>
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <OverlaysPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
