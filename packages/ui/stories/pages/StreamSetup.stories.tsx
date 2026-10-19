// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert01Icon, Add01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, StatusBadge } from "@commonair/ui";
import { Alert, AlertDescription, AlertTitle } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { ItemGroup } from "@commonair/ui/components/item";
import { Switch } from "@commonair/ui/components/switch";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { ActionRow, ChoiceToggle, CopyField, SwitchField } from "@commonair/ui/blocks/forms";
import {
  captions,
  ingest,
  latencies,
  protocols,
  recording,
  renditions,
  simulcastTargets,
  type Rendition,
} from "./fixtures/StreamSetup.ts";
import { SelectField } from "./select-field.tsx";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/StreamSetup", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function StreamSetupPage(): React.JSX.Element {
  const [protocol, setProtocol] = React.useState("rtmp");
  const [latency, setLatency] = React.useState("low");
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(
    Object.fromEntries(renditions.map((row) => [row.id, row.enabled])),
  );
  const [targets, setTargets] = React.useState<Record<string, boolean>>(
    Object.fromEntries(simulcastTargets.map((target) => [target.id, target.enabled])),
  );
  const columns: DataTableColumn<Rendition>[] = [
    { id: "name", header: "Rendition", accessorKey: "name" },
    { id: "resolution", header: "Resolution", accessorKey: "resolution" },
    { id: "bitrate", header: "Bitrate", accessorKey: "bitrate", align: "numeric" },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row }) => (
        <Switch
          aria-label={`${row.original.name} enabled`}
          checked={enabled[row.original.id] ?? false}
          onCheckedChange={(checked) => setEnabled((current) => ({ ...current, [row.original.id]: checked }))}
        />
      ),
    },
  ];
  return (
    <StudioPage current="setup">
      <PageContainer className="flex flex-col gap-6 py-6">
        <PageHeader title="Stream setup" description="Point OBS or any RTMP/WHIP encoder here. Nothing to install." />
        <Alert>
          <HugeiconsIcon icon={Alert01Icon} aria-hidden="true" />
          <AlertTitle>Your old key showed up in a public paste.</AlertTitle>
          <AlertDescription>
            <p>We revoked it automatically on Oct 14. The key below is new.</p>
            <a href="#leak-scanner">What the leak scanner checks</a>
          </AlertDescription>
        </Alert>
        <Card>
          <CardHeader>
            <CardTitle>Ingest</CardTitle>
            <CardDescription>Use the server closest to you; all of them feed the same origin.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ChoiceToggle label="Protocol" options={protocols} value={protocol} onValueChange={setProtocol} />
              <CopyField
                label="Server URL"
                value={ingest.serverUrl}
                copyLabel="Copy"
                copiedLabel="Server URL copied"
                copyFailedLabel="Could not copy the server URL"
              />
              <CopyField
                label="Stream key"
                value={ingest.streamKey}
                secret
                showLabel="Show"
                hideLabel="Hide"
                copyLabel="Copy"
                copiedLabel="Stream key copied"
                copyFailedLabel="Could not copy the stream key"
                hint={ingest.keyHint}
                actions={[
                  {
                    label: "Reset key",
                    destructive: true,
                    confirmTitle: "Reset the stream key?",
                    confirmDescription: "Your encoder stops streaming until you paste the new key.",
                    onAction: () => undefined,
                  },
                ]}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  id="setup-latency"
                  label="Latency"
                  value={latency}
                  options={latencies}
                  onValueChange={setLatency}
                />
                <Field>
                  <FieldLabel htmlFor="setup-encoder">Recommended encoder</FieldLabel>
                  <Input id="setup-encoder" value={ingest.encoder} readOnly />
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Quality options</CardTitle>
            <CardDescription>Transcoded renditions for viewers on slower connections.</CardDescription>
            <CardAction>
              <StatusBadge tone="success">Available to all channels</StatusBadge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <DataTable caption="Quality options" columns={columns} rows={renditions} getRowId={(row) => row.id} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Simulcast</CardTitle>
            <CardDescription>
              Restream to other platforms from our servers, so your upload stays the same.
            </CardDescription>
            <CardAction>
              <Button variant="outline" size="sm">
                <HugeiconsIcon icon={Add01Icon} aria-hidden="true" />
                Add target
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ItemGroup>
              {simulcastTargets.map((target) => (
                <ActionRow
                  key={target.id}
                  media={<ChannelAvatar name={target.initial} accent={target.accent} size="sm" decorative />}
                  title={target.name}
                  description={target.detail}
                  status={target.healthy ? { label: "Healthy", tone: "success" } : undefined}
                  trailingSwitch={{
                    label: target.enabled ? "Enabled" : "Disabled",
                    checked: targets[target.id] ?? false,
                    onCheckedChange: (checked) => setTargets((current) => ({ ...current, [target.id]: checked })),
                  }}
                />
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recording</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {recording.map((option) => (
                <SwitchField
                  key={option.id}
                  label={option.label}
                  description={option.description}
                  defaultChecked={option.checked}
                />
              ))}
              <SwitchField label={captions.label} comingLater={captions.later} />
            </FieldGroup>
          </CardContent>
        </Card>
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <StreamSetupPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
