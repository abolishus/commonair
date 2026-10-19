// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChannelAvatar, StatusBadge } from "@commonair/ui";
import { Badge } from "@commonair/ui/components/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@commonair/ui/components/item";
import { Textarea } from "@commonair/ui/components/textarea";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { FilterBar } from "@commonair/ui/blocks/data";
import { ChoiceToggle, FormSection } from "@commonair/ui/blocks/forms";
import { ChatMessage } from "@commonair/ui/blocks/media";
import { decisions, detail, durations, filters, reports, templates } from "./fixtures/TrustSafety.ts";
import { SelectField } from "./select-field.tsx";
import { AdminPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/TrustSafety", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function TrustSafetyPage(): React.JSX.Element {
  const [filter, setFilter] = React.useState("severity");
  const [decision, setDecision] = React.useState("chat");
  const [duration, setDuration] = React.useState("7");
  const [template, setTemplate] = React.useState("harassment-1");
  return (
    <AdminPage>
      <PageContainer width="wide" className="flex flex-col gap-8 py-6">
        <div className="flex flex-col gap-4">
          <PageHeader
            size="compact"
            title="Report queue"
            actions={<FilterBar filters={[{ id: "report-filter", label: "Filter", value: filter, options: filters, onValueChange: setFilter }]} />}
          />
          <ItemGroup>
            {reports.map((report) => (
              <Item
                key={report.id}
                variant={report.selected ? "muted" : "outline"}
                size="sm"
                render={<a href={`#reports/${report.id}`} aria-current={report.selected ? "page" : undefined} />}
              >
                <ItemMedia>
                  <StatusBadge tone={report.tone}>{report.severity}</StatusBadge>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{report.category}</ItemTitle>
                  <ItemDescription>{report.target}</ItemDescription>
                </ItemContent>
                <ItemActions className="flex-col items-end gap-0">
                  <span>{report.age}</span>
                  <span className="tabular-nums">{report.count} reports</span>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </div>
        <Section
          heading={detail.title}
          description={detail.opened}
          action={<StatusBadge tone="danger">High</StatusBadge>}
        >
          <ResponsiveGrid cols={2}>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Reported account</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Item size="xs">
                  <ItemMedia>
                    <ChannelAvatar name={detail.account.name} accent={detail.account.accent} size="sm" decorative />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{detail.account.name}</ItemTitle>
                    <ItemDescription>{detail.account.meta}</ItemDescription>
                  </ItemContent>
                </Item>
                <div className="flex flex-wrap gap-2">
                  {detail.account.badges.map((badge) => (
                    <Badge key={badge} variant="outline">
                      {badge}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Reporters</CardTitle>
                <CardDescription>{detail.reporters}</CardDescription>
              </CardHeader>
            </Card>
          </ResponsiveGrid>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Evidence · chat context</CardTitle>
              <CardAction>retained 90 days</CardAction>
            </CardHeader>
            <CardContent>
              {detail.evidence.map((line) => (
                <ChatMessage
                  key={line.id}
                  timestamp={line.time}
                  author={line.author}
                  colorIndex={line.colorIndex}
                  body={line.notice ? `${line.time} ${line.body}` : line.body}
                  notice={line.notice}
                />
              ))}
            </CardContent>
          </Card>
          <FormSection
            title="Action"
            description={detail.policy}
            onSubmit={(event) => event.preventDefault()}
            actions={{ cancelLabel: "Escalate", onCancel: () => undefined, saveLabel: "Apply action" }}
          >
            <ChoiceToggle label="Decision" options={decisions} value={decision} onValueChange={setDecision} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField id="ts-duration" label="Duration" value={duration} options={durations} onValueChange={setDuration} />
              <SelectField id="ts-template" label="Message to user" value={template} options={templates} onValueChange={setTemplate} />
            </div>
            <Field>
              <FieldLabel htmlFor="ts-note">Internal note (audit log; no personal data)</FieldLabel>
              <Textarea id="ts-note" placeholder="Reason for the decision" />
              <FieldDescription>{detail.appeal}</FieldDescription>
            </Field>
          </FormSection>
        </Section>
      </PageContainer>
    </AdminPage>
  );
}

export const Default: Story = { render: () => <TrustSafetyPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
