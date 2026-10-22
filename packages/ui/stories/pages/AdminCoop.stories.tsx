// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { AppointWorkerForm, SeatList, type AppointWorkerFormValues } from "@commonair/ui/blocks/coop";
import { AdminPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/AdminCoop", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const workers = [
  {
    userId: "0192d6f5-0000-7000-8000-0000000000w1",
    name: "treasury-wg",
    accent: "zinc" as const,
    memberClass: "worker",
    description: "Appointed Sep 2 · minute BM-2026-11",
  },
  {
    userId: "0192d6f5-0000-7000-8000-0000000000w2",
    name: "wren",
    accent: "sky" as const,
    memberClass: "worker",
    description: "Appointed Jun 18 · minute BM-2026-07",
  },
];

function AdminCoopPage({ error }: { error?: string }): React.JSX.Element {
  const [values, setValues] = React.useState<AppointWorkerFormValues>({ username: "", minute: "" });
  return (
    <AdminPage current="coop">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6" data-testid="admin-coop">
        <PageHeader
          size="compact"
          title="Co-op administration"
          description="Record board decisions. Every appointment is audited with its board minute."
        />
        <SplitLayout
          asideWidth="lg"
          main={
            <AppointWorkerForm
              title="Appoint a worker member"
              description="Workers join by board decision, not by activity. The user must exist and not already be a worker member."
              labels={{
                username: "Username",
                usernameHint: "The account's username, without @.",
                minute: "Board minute reference",
                minuteHint: "E.g. BM-2026-14. Stored in the audit log.",
                submit: "Appoint",
              }}
              values={values}
              onValuesChange={setValues}
              onSubmit={() => undefined}
              error={error}
              usernameProps={{ "data-testid": "appoint-worker-username" }}
              minuteProps={{ "data-testid": "appoint-worker-minute" }}
              submitProps={{ "data-testid": "appoint-worker-submit" }}
            />
          }
          aside={
            <div className="flex flex-col gap-4">
              <Section heading="Worker members" headingLevel={2}>
                <SeatList label="Worker members" items={workers} />
              </Section>
              <AlertCallout
                tone="info"
                description="Exits and lapses are the member's own; this page only records appointments."
              />
            </div>
          }
        />
      </PageContainer>
    </AdminPage>
  );
}

export const Default: Story = { render: () => <AdminCoopPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** The user is already a worker member (`CONFLICT`). */
export const AlreadyWorker: Story = {
  render: () => <AdminCoopPage error="This user already has an active worker membership." />,
};
