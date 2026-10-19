// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChartHistogramIcon,
  Rocket01Icon,
  Scissor01Icon,
  Shield01Icon,
  Target02Icon,
  Timer01Icon,
} from "@hugeicons/core-free-icons";
import { ChannelAvatar, OverlayBadge, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, ResponsiveGrid, SplitLayout } from "@commonair/ui/layouts";
import { KeyValueList, ListPanel, StatCard, StatGrid, TrendChart } from "@commonair/ui/blocks/data";
import { CharacterCountField, FormSection, SwitchField, TagsField } from "@commonair/ui/blocks/forms";
import { PlayerChrome } from "@commonair/ui/blocks/media";
import {
  bitrate,
  categoryOptions,
  feed,
  health,
  languageOptions,
  quickActions,
  simulcast,
  stats,
  streamInfo,
  tagSuggestions,
} from "./fixtures/StreamManager.ts";
import { SelectField } from "./select-field.tsx";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/StreamManager", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const quickIcons = {
  Poll: ChartHistogramIcon,
  Prediction: Target02Icon,
  Raid: Rocket01Icon,
  Clip: Scissor01Icon,
  "Slow mode": Timer01Icon,
  "Shield mode": Shield01Icon,
} as const;

function StreamManagerPage(): React.JSX.Element {
  const [title, setTitle] = React.useState(streamInfo.title);
  const [category, setCategory] = React.useState(streamInfo.category);
  const [language, setLanguage] = React.useState(streamInfo.language);
  const [tags, setTags] = React.useState<string[]>(streamInfo.tags);
  const [mature, setMature] = React.useState(false);
  return (
    <StudioPage current="manager">
      <PageContainer width="wide" className="py-6">
        <h1 className="sr-only">Stream manager</h1>
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <StatGrid cols={4}>
                {stats.map((stat) => (
                  <StatCard
                    key={stat.label}
                    label={stat.label}
                    value={stat.value}
                    hint={stat.hint}
                    delta={stat.delta ? { direction: "up", label: stat.delta, sentiment: "positive" } : undefined}
                  />
                ))}
              </StatGrid>
              <ResponsiveGrid cols={2}>
                <PlayerChrome
                  variant="preview"
                  topStart={<OverlayBadge>Preview · muted</OverlayBadge>}
                  stage={<ChannelAvatar name="mira" accent="violet" size="xl" decorative />}
                >
                  {null}
                </PlayerChrome>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Stream health</CardTitle>
                    <CardAction>
                      <StatusBadge tone="success">Excellent</StatusBadge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <KeyValueList
                      dense
                      rows={[
                        ...health.map((row) => ({ term: row.term, value: row.value })),
                        { term: "Simulcast", value: <StatusBadge tone="success">{simulcast}</StatusBadge> },
                      ]}
                    />
                    <TrendChart
                      type="bar"
                      compact
                      data={bitrate}
                      xKey="t"
                      series={[{ key: "kbps", label: "Bitrate (kbps)", color: "--chart-2" }]}
                      ariaLabel="Bitrate, last 10 minutes"
                    />
                  </CardContent>
                </Card>
              </ResponsiveGrid>
              <FormSection
                title="Stream info"
                action={<StatusBadge tone="neutral">Changes apply live</StatusBadge>}
                onSubmit={(event) => event.preventDefault()}
                actions={{ saveLabel: "Update" }}
              >
                <CharacterCountField label="Title" maxLength={140} value={title} onValueChange={setTitle} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField id="sm-category" label="Category" value={category} options={categoryOptions} onValueChange={setCategory} />
                  <SelectField id="sm-language" label="Language" value={language} options={languageOptions} onValueChange={setLanguage} />
                </div>
                <TagsField
                  label="Tags"
                  values={tags}
                  onValuesChange={setTags}
                  options={tagSuggestions}
                  max={10}
                  addTagLabel={(value) => `Add “${value}”`}
                />
                <SwitchField label="Mature content (18+)" checked={mature} onCheckedChange={setMature} />
              </FormSection>
            </div>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Quick actions</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {quickActions.map((action) => (
                    <Button key={action} variant="outline">
                      <HugeiconsIcon icon={quickIcons[action]} aria-hidden="true" />
                      {action}
                    </Button>
                  ))}
                </CardContent>
              </Card>
              <ListPanel
                title="Activity"
                action={
                  <Button variant="ghost" size="xs">
                    Filter
                  </Button>
                }
                items={feed.map((event) => ({
                  id: event.id,
                  media: <StatusBadge tone={event.tone}>{event.kind}</StatusBadge>,
                  title: (
                    <span>
                      <strong>{event.who}</strong> {event.what}
                    </span>
                  ),
                  meta: event.ago,
                  actions: (
                    <Button variant="ghost" size="xs">
                      Replay
                    </Button>
                  ),
                }))}
              />
            </div>
          }
        />
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <StreamManagerPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
