// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChannelAvatar, ConfirmDialog, EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader } from "@commonair/ui/components/card";
import { Field, FieldGroup, FieldLabel, FieldTitle } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { ListPanel, StatCard, StatGrid } from "@commonair/ui/blocks/data";
import { ChannelHeader, ChatMessage } from "@commonair/ui/blocks/media";
import { QueueItemCard } from "@commonair/ui/blocks/feedback";
import { actions, queue, tabs, user } from "./fixtures/Community.ts";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/Community", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function CommunityPage(): React.JSX.Element {
  return (
    <StudioPage current="moderation">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="Moderation" tabs={<PageTabs items={tabs} />} />
        <SplitLayout
          asideWidth="lg"
          main={
            <section aria-label="Queue" className="flex flex-col gap-3">
              {queue.map((item) => (
                <QueueItemCard
                  key={item.id}
                  kind={item.kind}
                  tone={item.tone}
                  reason={item.reason}
                  time={item.ago}
                  actions={[
                    { id: "primary", label: item.primary, variant: "default" },
                    { id: "secondary", label: item.secondary },
                    { id: "timeout", label: "Timeout 10 min" },
                    { id: "ban", label: "Ban", variant: "destructive" },
                  ]}
                  trailingAction={{ id: "escalate", label: "Escalate to platform", variant: "ghost" }}
                >
                  <ChatMessage author={item.who} colorIndex={item.colorIndex} body={item.text} />
                </QueueItemCard>
              ))}
              <EmptyState
                title="That’s everything."
                description="Held messages expire after 5 minutes if nobody acts."
              />
            </section>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card data-accent={user.accent}>
                <CardHeader>
                  <ChannelHeader
                    variant="compact"
                    headingLevel={2}
                    name={user.name}
                    accent={user.accent}
                    meta={user.meta}
                  />
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <StatGrid cols={3}>
                      {user.stats.map((stat) => (
                        <StatCard key={stat.label} size="sm" label={stat.label} value={stat.value} />
                      ))}
                    </StatGrid>
                    <Field>
                      <FieldTitle>Recent messages</FieldTitle>
                      <div className="flex flex-col">
                        {user.recent.map((message) => (
                          <ChatMessage
                            key={message.id}
                            timestamp={message.time}
                            author={user.name}
                            colorIndex={2}
                            body={message.text}
                          />
                        ))}
                      </div>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mod-note">Mod note (only mods see this)</FieldLabel>
                      <Textarea id="mod-note" placeholder="Add context for other moderators" />
                    </Field>
                  </FieldGroup>
                </CardContent>
                <CardFooter className="justify-between gap-2">
                  <Button variant="outline" size="sm">
                    Timeout…
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button variant="destructive" size="sm">
                        Ban from channel
                      </Button>
                    }
                    title={`Ban ${user.name} from your channel?`}
                    description="They can no longer chat or follow. The ban is logged in the mod log."
                    confirmLabel="Ban"
                    variant="destructive"
                    onConfirm={() => undefined}
                  />
                </CardFooter>
              </Card>
              <ListPanel
                title="Recent actions"
                items={actions.map((action) => ({
                  id: action.id,
                  media: <ChannelAvatar name={action.who} accent={action.accent} size="xs" decorative />,
                  title: (
                    <span>
                      <strong>{action.who}</strong> {action.action}
                    </span>
                  ),
                  actions: <span>{action.ago}</span>,
                }))}
              />
            </div>
          }
        />
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <CommunityPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
