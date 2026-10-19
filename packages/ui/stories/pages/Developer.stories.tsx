// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, InformationCircleIcon, WebhookIcon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, ConfirmDialog, IconButton, StatusBadge } from "@commonair/ui";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Field, FieldTitle } from "@commonair/ui/components/field";
import { PageContainer, SectionNav } from "@commonair/ui/layouts";
import { PageTabs, Section } from "@commonair/ui/blocks/headers";
import { DataTable, FilterBar, type DataTableColumn } from "@commonair/ui/blocks/data";
import { CopyField } from "@commonair/ui/blocks/forms";
import { ChannelHeader } from "@commonair/ui/blocks/media";
import {
  app,
  apps,
  deliveries,
  statusFilters,
  subscriptions,
  tabs,
  type Delivery,
  type Subscription,
} from "./fixtures/Developer.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/Developer", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const subscriptionColumns: DataTableColumn<Subscription>[] = [
  { id: "event", header: "Event", cell: ({ row }) => <code>{row.original.event}</code> },
  { id: "transport", header: "Transport", cell: ({ row }) => <code>{row.original.transport}</code> },
  { id: "status", header: "Status", cell: ({ row }) => <StatusBadge tone={row.original.tone}>{row.original.status}</StatusBadge> },
  { id: "success", header: "Success (24 h)", accessorKey: "success", align: "numeric" },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: () => (
      <Button variant="outline" size="xs">
        Send test
      </Button>
    ),
  },
];

const deliveryColumns: DataTableColumn<Delivery>[] = [
  { id: "time", header: "Time", cell: ({ row }) => <span className="tabular-nums">{row.original.time}</span> },
  { id: "event", header: "Event", cell: ({ row }) => <code>{row.original.event}</code> },
  {
    id: "response",
    header: "Response",
    cell: ({ row }) => (
      <StatusBadge tone={row.original.code === "200" ? "success" : "danger"}>{row.original.code}</StatusBadge>
    ),
  },
  { id: "latency", header: "Latency", accessorKey: "latency", align: "numeric" },
  { id: "attempt", header: "Attempt", accessorKey: "attempt", align: "numeric" },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: () => (
      <Button variant="ghost" size="xs">
        Redeliver
      </Button>
    ),
  },
];

function DeveloperPage(): React.JSX.Element {
  const [status, setStatus] = React.useState("all");
  const shown = status === "failed" ? deliveries.filter((delivery) => delivery.code !== "200") : deliveries;
  return (
    <div data-accent="violet">
      <ViewerPage footer={false}>
        <PageContainer width="wide" className="py-6">
          <div className="flex min-w-0 flex-col gap-6 md:flex-row">
            <div className="flex shrink-0 flex-col gap-4 md:w-64">
              <SectionNav
                aria-label="Your applications"
                label="Applications"
                heading="Applications"
                action={<IconButton label="New application" icon={Add01Icon} variant="outline" size="icon-sm" />}
                items={apps.map((item) => ({
                  id: item.id,
                  label: `${item.name} · ${item.kind}`,
                  href: `#developer/${item.id}`,
                  current: item.current,
                  icon: <ChannelAvatar name={item.name} accent={item.accent} size="xs" decorative />,
                }))}
              />
              <Alert>
                <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
                <AlertDescription>
                  Every API route is in the OpenAPI spec. Existing Twitch IRC bots connect unchanged.
                </AlertDescription>
              </Alert>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <ChannelHeader
                headingLevel={1}
                variant="vod"
                name={app.name}
                accent={app.accent}
                meta={app.meta}
                actions={
                  <ConfirmDialog
                    trigger={
                      <Button variant="destructive" size="sm">
                        Delete app
                      </Button>
                    }
                    title={`Delete ${app.name}?`}
                    description="Its credentials stop working and every channel authorization is revoked."
                    confirmLabel="Delete app"
                    variant="destructive"
                    onConfirm={() => undefined}
                  />
                }
              />
              <PageTabs items={tabs} />
              <Card>
                <CardHeader>
                  <CardTitle>Credentials</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <CopyField
                    label="Client ID"
                    value={app.clientId}
                    copyLabel="Copy"
                    copiedLabel="Client ID copied"
                    copyFailedLabel="Could not copy the client ID"
                  />
                  <CopyField
                    label="Client secret"
                    value={app.clientSecret}
                    secret
                    showLabel="Show secret"
                    hideLabel="Hide secret"
                    copyLabel="Copy"
                    copiedLabel="Client secret copied"
                    copyFailedLabel="Could not copy the client secret"
                    actions={[
                      {
                        label: "Rotate",
                        destructive: true,
                        confirmTitle: "Rotate the client secret?",
                        confirmDescription: "The old secret stops working immediately.",
                        onAction: () => undefined,
                      },
                    ]}
                  />
                  <Field>
                    <FieldTitle>Scopes granted</FieldTitle>
                    <div className="flex flex-wrap gap-2">
                      {app.scopes.map((scope) => (
                        <Badge key={scope} variant="outline">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </Field>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Event subscriptions</CardTitle>
                  <CardDescription>
                    Signed HTTP webhooks (HMAC-SHA256) or a WebSocket session. Retries back off for 24 h.
                  </CardDescription>
                  <CardAction>
                    <Button size="sm">
                      <HugeiconsIcon icon={WebhookIcon} aria-hidden="true" />
                      Subscribe
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <DataTable caption="Event subscriptions" columns={subscriptionColumns} rows={subscriptions} getRowId={(row) => row.id} />
                </CardContent>
              </Card>
              <Section
                heading="Recent deliveries"
                action={
                  <FilterBar
                    filters={[{ id: "delivery-status", label: "Filter status", value: status, options: statusFilters, onValueChange: setStatus }]}
                  />
                }
              >
                <DataTable caption="Recent deliveries" columns={deliveryColumns} rows={shown} getRowId={(row) => row.id} />
              </Section>
            </div>
          </div>
        </PageContainer>
      </ViewerPage>
    </div>
  );
}

export const Default: Story = { render: () => <DeveloperPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
