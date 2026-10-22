// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { StatusBadge } from "@commonair/ui";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Switch } from "@commonair/ui/components/switch";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { ChoiceToggle, CopyField, SelectField, SwitchField } from "@commonair/ui/blocks/forms";
import { SimulcastPanel, type SimulcastTargetRow } from "@commonair/ui/blocks/studio";
import {
  captions,
  ingest,
  latencies,
  protocols,
  recording,
  renditions,
  type Rendition,
} from "./fixtures/StreamSetup.ts";
import { simulcastLabels, simulcastPlatforms, simulcastTargets } from "../e6-fixtures.tsx";
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
  const [targets, setTargets] = React.useState<SimulcastTargetRow[]>(simulcastTargets);
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
        <AlertCallout
          tone="warning"
          title="Your old key showed up in a public paste."
          description="We revoked it automatically on Oct 14. The key below is new."
          action={<a href="#leak-scanner">What the leak scanner checks</a>}
        />
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
        <SimulcastPanel
          targets={targets}
          platforms={simulcastPlatforms}
          labels={simulcastLabels}
          onAdd={(values) =>
            setTargets((current) => [
              ...current,
              {
                id: `t${current.length + 1}`,
                name: values.name,
                platform: values.platform,
                platformLabel: simulcastPlatforms.find((p) => p.value === values.platform)?.label ?? values.platform,
                rtmpUrl: values.rtmpUrl,
                enabled: true,
                status: "idle",
                statusLabel: "Idle",
                lastError: null,
              },
            ])
          }
          onToggle={(id, enabled) =>
            setTargets((current) => current.map((target) => (target.id === id ? { ...target, enabled } : target)))
          }
          onRemove={(id) => setTargets((current) => current.filter((target) => target.id !== id))}
        />
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
