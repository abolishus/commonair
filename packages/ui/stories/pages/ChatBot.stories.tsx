// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, InformationCircleIcon, Upload01Icon } from "@hugeicons/core-free-icons";
import { IconButton, StatusBadge } from "@commonair/ui";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { FieldGroup } from "@commonair/ui/components/field";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@commonair/ui/components/item";
import { Switch } from "@commonair/ui/components/switch";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { DataTable, FilterBar, type DataTableColumn } from "@commonair/ui/blocks/data";
import { SwitchField } from "@commonair/ui/blocks/forms";
import { EmoteGrid } from "@commonair/ui/blocks/media";
import { commands, emotes, modes, rewards, tabs, variables, type Command } from "./fixtures/ChatBot.ts";
import { StudioPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Creator studio/ChatBot", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function ChatBotPage(): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(
    Object.fromEntries(commands.map((command) => [command.id, command.enabled])),
  );
  const [modeValues, setModeValues] = React.useState<Record<string, string>>(
    Object.fromEntries(modes.flatMap((mode) => (mode.select ? [[mode.id, mode.select.value]] : []))),
  );
  const columns: DataTableColumn<Command>[] = [
    { id: "command", header: "Command", cell: ({ row }) => <code>{row.original.command}</code> },
    { id: "response", header: "Response", accessorKey: "response" },
    { id: "who", header: "Who", cell: ({ row }) => <Badge variant="outline">{row.original.who}</Badge> },
    { id: "cooldown", header: "Cooldown", accessorKey: "cooldown", align: "numeric" },
    { id: "uses", header: "Uses", accessorKey: "uses", align: "numeric" },
    {
      id: "enabled",
      header: () => <span className="sr-only">Enabled</span>,
      cell: ({ row }) => (
        <Switch
          aria-label={`${row.original.command} enabled`}
          checked={enabled[row.original.id] ?? false}
          onCheckedChange={(checked) => setEnabled((current) => ({ ...current, [row.original.id]: checked }))}
        />
      ),
    },
  ];
  const shown = commands.filter((command) => command.command.includes(query.toLowerCase()));
  return (
    <StudioPage current="chat">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Chat & bot"
          actions={<StatusBadge tone="success">Channel bot connected as mira_bot</StatusBadge>}
          tabs={<PageTabs items={tabs} />}
        />
        <SplitLayout
          asideWidth="lg"
          main={
            <Section
              heading="Commands"
              action={
                <FilterBar
                  searchLabel="Search commands"
                  searchValue={query}
                  onSearchChange={setQuery}
                  actions={
                    <Button size="sm">
                      <HugeiconsIcon icon={Add01Icon} aria-hidden="true" />
                      New command
                    </Button>
                  }
                />
              }
            >
              <DataTable caption="Commands" columns={columns} rows={shown} getRowId={(row) => row.id} />
              <Alert>
                <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
                <AlertDescription>
                  <p>
                    Variables:{" "}
                    {variables.map((variable) => (
                      <React.Fragment key={variable}>
                        <code>{variable}</code>{" "}
                      </React.Fragment>
                    ))}
                    . Bots built on tmi.js work unchanged through the IRC gateway.
                  </p>
                </AlertDescription>
              </Alert>
            </Section>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Chat modes</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    {modes.map((mode) => (
                      <SwitchField
                        key={mode.id}
                        label={mode.label}
                        defaultChecked={mode.checked}
                        trailing={
                          mode.select ? (
                            <FilterBar
                              filters={[
                                {
                                  id: `mode-${mode.id}`,
                                  label: mode.select.label,
                                  value: modeValues[mode.id] ?? mode.select.value,
                                  options: mode.select.options,
                                  onValueChange: (value) =>
                                    setModeValues((current) => ({ ...current, [mode.id]: value })),
                                },
                              ]}
                            />
                          ) : undefined
                        }
                      />
                    ))}
                  </FieldGroup>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Channel point rewards</CardTitle>
                  <CardAction>
                    <Button variant="ghost" size="xs">
                      Manage
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <ItemGroup>
                    {rewards.map((reward) => (
                      <Item key={reward.id} variant="outline" size="sm">
                        <ItemMedia>
                          <StatusBadge tone="accent">{reward.cost}</StatusBadge>
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{reward.title}</ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          {reward.note ? <span>{reward.note}</span> : null}
                          {reward.off ? <Badge variant="outline">Off</Badge> : null}
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Emotes</CardTitle>
                  <CardAction>
                    <span className="tabular-nums">6 / 25 slots</span>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <EmoteGrid
                    emotes={emotes}
                    uploadLabel="Upload emote"
                    uploadAction={<IconButton label="Upload emote" icon={Upload01Icon} variant="outline" />}
                  />
                </CardContent>
              </Card>
            </div>
          }
        />
      </PageContainer>
    </StudioPage>
  );
}

export const Default: Story = { render: () => <ChatBotPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
