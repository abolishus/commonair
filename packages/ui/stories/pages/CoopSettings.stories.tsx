// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { GovernanceSettingsList } from "@commonair/ui/blocks/coop";
import { coopTabs } from "./fixtures/CoopNav.ts";
import { settings } from "./fixtures/CoopSettings.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

/** `/coop/settings`. The file is CoopSettings because the viewer `Settings` board already exists. */
const meta = { title: "Pages/Co-op/Settings", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function CoopSettingsPage(): React.JSX.Element {
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="default" className="flex flex-col gap-6 py-6" data-testid="settings">
        <PageHeader
          title="Governance settings"
          description="The rules the platform runs on. Only a passed proposal can change them; each shows the decision that last did."
          tabs={<PageTabs variant="default" items={coopTabs("settings")} aria-label="Co-op" />}
        />
        <AlertCallout
          tone="info"
          title="Protected settings"
          description="Changing a protected setting needs two thirds of members and a majority of the streamer class. The database enforces it."
        />
        <GovernanceSettingsList
          itemProps={{ "data-testid": "setting-row" }}
          labels={{ protected: "Protected", seeded: "Seeded at launch", setBy: "Set by" }}
          items={settings.map((setting) => ({
            key: setting.key,
            description: setting.description,
            value: setting.value,
            protected: setting.protected,
            updatedAt: setting.updatedAt,
            updatedBy: setting.updatedBy
              ? {
                  proposalId: setting.updatedBy.proposalId,
                  label: `proposal #${setting.updatedBy.number}`,
                  link: { href: `#coop/proposals/${setting.updatedBy.proposalId}` },
                }
              : null,
          }))}
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <CoopSettingsPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
