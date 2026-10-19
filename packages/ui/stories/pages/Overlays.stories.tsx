// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { PageContainer, SectionNav, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { FilterBar, ProgressRow } from "@commonair/ui/blocks/data";
import { AmountField, ChoiceToggle, CopyField, FormSection, SwitchField } from "@commonair/ui/blocks/forms";
import { AlertPreview } from "@commonair/ui/blocks/media";
import { overlays, preview, previewKinds, sourceUrl, tipAlert } from "./fixtures/Overlays.ts";
import { SelectField } from "./select-field.tsx";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Overlays", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function OverlaysPage(): React.JSX.Element {
  const [kind, setKind] = React.useState("tip");
  const [minimum, setMinimum] = React.useState(tipAlert.minimumCents);
  const [duration, setDuration] = React.useState("6");
  const [sound, setSound] = React.useState("chime");
  const [layout, setLayout] = React.useState("stacked");
  return (
    <StudioPage current="overlays">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="Alerts & overlays" description="Add each one to OBS as a browser source." />
        <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
          <SectionNav label="Overlays" items={overlays} className="shrink-0 lg:w-56" />
          <SplitLayout
            className="flex-1"
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-4">
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Preview</CardTitle>
                    <CardAction>
                      <FilterBar
                        toggleLabel="Alert to preview"
                        toggleValue={kind}
                        toggleOptions={previewKinds}
                        onToggleChange={setKind}
                      />
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <AlertPreview
                      name={preview.name}
                      eventLabel={preview.event}
                      amount={{ cents: preview.cents, currency: "USD" }}
                      message={preview.message}
                      stageLabel="Alert preview"
                      goal={
                        <ProgressRow
                          label={preview.goal.label}
                          value={(preview.goal.current / preview.goal.target) * 100}
                          valueText={`${preview.goal.current} / ${preview.goal.target}`}
                          tone="accent"
                        />
                      }
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Browser source URL</CardTitle>
                    <CardDescription>Anyone with this link can see your alerts. Keep it out of screenshots.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CopyField
                      label="Overlay URL"
                      value={sourceUrl}
                      secret
                      showLabel="Show URL"
                      hideLabel="Hide URL"
                      copyLabel="Copy"
                      copiedLabel="Overlay URL copied"
                      copyFailedLabel="Could not copy the overlay URL"
                      actions={[
                        {
                          label: "Regenerate",
                          confirmTitle: "Regenerate the overlay URL?",
                          confirmDescription: "The old URL stops working in OBS until you paste the new one.",
                          onAction: () => undefined,
                        },
                        { label: "Send test alert", onAction: () => undefined },
                      ]}
                    />
                  </CardContent>
                </Card>
              </div>
            }
            aside={
              <FormSection
                title="Tip alert"
                onSubmit={(event) => event.preventDefault()}
                actions={{ saveLabel: "Save" }}
              >
                <Field>
                  <FieldLabel htmlFor="tip-message">Message</FieldLabel>
                  <Input id="tip-message" defaultValue={tipAlert.message} />
                </Field>
                <AmountField
                  label="Minimum amount"
                  currency="USD"
                  value={minimum}
                  onValueChange={setMinimum}
                  min={100}
                  rangeError="The minimum is $1.00."
                />
                <SelectField id="tip-duration" label="Duration" value={duration} options={tipAlert.durations} onValueChange={setDuration} />
                <SelectField id="tip-sound" label="Sound" value={sound} options={tipAlert.sounds} onValueChange={setSound} />
                {tipAlert.switches.map((option) => (
                  <SwitchField key={option.id} label={option.label} defaultChecked={option.checked} />
                ))}
                <ChoiceToggle label="Layout" options={tipAlert.layouts} value={layout} onValueChange={setLayout} />
              </FormSection>
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
