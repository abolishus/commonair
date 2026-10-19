// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, FingerPrintIcon, Key01Icon, SquareLock01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, type Accent } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@commonair/ui/components/input-group";
import { ItemGroup } from "@commonair/ui/components/item";
import { PageContainer, SectionNav } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import {
  AccentPicker,
  ActionRow,
  CharacterCountField,
  FormSection,
  SwitchMatrix,
  type SwitchMatrixRow,
} from "@commonair/ui/blocks/forms";
import {
  accentLabels,
  notificationColumns,
  notificationRows,
  profile,
  sections,
  signInMethods,
} from "./fixtures/Settings.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/Settings", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const methodIcons = { password: Key01Icon, passkeys: FingerPrintIcon, totp: SquareLock01Icon } as const;

function SettingsPage(): React.JSX.Element {
  const [bio, setBio] = React.useState(profile.bio);
  const [accent, setAccent] = React.useState<Accent>(profile.accent);
  const [rows, setRows] = React.useState<SwitchMatrixRow[]>(notificationRows);
  return (
    <ViewerPage>
      <PageContainer className="flex flex-col gap-6 py-6">
        <PageHeader title="Settings" />
        <div className="flex min-w-0 flex-col gap-6 md:flex-row">
          <SectionNav label="Settings sections" items={sections} className="shrink-0 md:w-56" />
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <FormSection
              title="Profile"
              description="Shown on your channel and in chat."
              onSubmit={(event) => event.preventDefault()}
              actions={{ cancelLabel: "Cancel", saveLabel: "Save changes", onCancel: () => undefined }}
            >
              <Field orientation="horizontal" data-accent={accent}>
                <ChannelAvatar name={profile.displayName} accent={accent} size="xl" decorative />
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm">
                      Upload picture
                    </Button>
                    <Button type="button" variant="ghost" size="sm">
                      Remove
                    </Button>
                  </div>
                  <FieldDescription>{profile.pictureHint}</FieldDescription>
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="settings-display-name">Display name</FieldLabel>
                  <Input id="settings-display-name" defaultValue={profile.displayName} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-username">Username</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>/</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput id="settings-username" defaultValue={profile.username} />
                  </InputGroup>
                </Field>
              </div>
              <CharacterCountField label="Bio" multiline maxLength={300} value={bio} onValueChange={setBio} />
              <Field>
                <AccentPicker label="Channel accent" value={accent} onValueChange={setAccent} labels={accentLabels} />
                <FieldDescription>{profile.accentHint}</FieldDescription>
              </Field>
            </FormSection>
            <Card>
              <CardHeader>
                <CardTitle>Sign-in methods</CardTitle>
                <CardDescription>Two-factor is required to stream or moderate.</CardDescription>
              </CardHeader>
              <CardContent>
                <ItemGroup>
                  {signInMethods.map((method) => (
                    <ActionRow
                      key={method.id}
                      icon={
                        <HugeiconsIcon icon={methodIcons[method.id as keyof typeof methodIcons]} aria-hidden="true" />
                      }
                      title={method.title}
                      description={method.description}
                      status={method.status ? { label: method.status, tone: "success" } : undefined}
                      actions={[{ label: method.action, onAction: () => undefined }]}
                    />
                  ))}
                </ItemGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Notifications</CardTitle>
              </CardHeader>
              <CardContent>
                <SwitchMatrix
                  label="Event"
                  columns={notificationColumns}
                  rows={rows}
                  onValueChange={(rowId, columnId, checked) =>
                    setRows((current) =>
                      current.map((row) =>
                        row.id === rowId ? { ...row, values: { ...row.values, [columnId]: checked } } : row,
                      ),
                    )
                  }
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Your data</CardTitle>
                <CardDescription>Everything we hold about you, in a portable archive.</CardDescription>
              </CardHeader>
              <CardContent>
                <ItemGroup>
                  <ActionRow
                    icon={<HugeiconsIcon icon={Download01Icon} aria-hidden="true" />}
                    title="Export my data"
                    description="JSON + media, ready within 24 hours. Last export: never."
                    actions={[{ label: "Request export", onAction: () => undefined }]}
                  />
                  <ActionRow
                    tone="destructive"
                    title="Delete account"
                    description="Profile, messages and media are removed. Ledger and vote history stay, pseudonymized."
                    actions={[{ label: "Delete account…", onAction: () => undefined }]}
                  />
                </ItemGroup>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <SettingsPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
