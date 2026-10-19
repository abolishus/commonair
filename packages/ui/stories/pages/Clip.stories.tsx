// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle01Icon, Download01Icon, PlayIcon, Scissor01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, OverlayBadge } from "@commonair/ui";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Field, FieldGroup, FieldTitle } from "@commonair/ui/components/field";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Section } from "@commonair/ui/blocks/headers";
import { CharacterCountField, CodeBlock, CopyField } from "@commonair/ui/blocks/forms";
import { ClipTrimmer, MediaCard, PlayerChrome, PlayerControl } from "@commonair/ui/blocks/media";
import { clip, formatDuration, formatOffset, more, published } from "./fixtures/Clip.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Channel/Clip", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function ClipPage(): React.JSX.Element {
  const [range, setRange] = React.useState<[number, number]>(clip.range);
  const [title, setTitle] = React.useState(clip.title);
  return (
    <div data-accent={clip.accent}>
      <ViewerPage footer={false}>
        <PageContainer width="wide" className="py-6">
          <SplitLayout
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-4">
                <h1 className="sr-only">Create a clip</h1>
                <PlayerChrome
                  variant="clip"
                  topStart={<OverlayBadge>{clip.preview}</OverlayBadge>}
                  stage={<ChannelAvatar name={clip.channel} accent={clip.accent} size="xl" decorative />}
                  timeLabel={clip.previewTime}
                  controls={<PlayerControl label="Play preview" icon={PlayIcon} />}
                >
                  {null}
                </PlayerChrome>
                <Card>
                  <CardHeader>
                    <CardTitle>Trim</CardTitle>
                    <CardDescription>Drag the handles. Clips are 5–60 seconds.</CardDescription>
                    <CardAction>
                      <Badge variant="secondary">{formatDuration(range[1] - range[0])}</Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup>
                      <ClipTrimmer
                        value={range}
                        onValueChange={setRange}
                        duration={clip.window}
                        minDuration={clip.minDuration}
                        maxDuration={clip.maxDuration}
                        startLabel="Start"
                        endLabel="End"
                        durationLabel="Clip range"
                        formatTime={formatOffset}
                      />
                      <CharacterCountField label="Title" maxLength={100} value={title} onValueChange={setTitle} />
                    </FieldGroup>
                  </CardContent>
                  <CardFooter className="justify-between gap-2">
                    <Button variant="ghost" size="sm">
                      Discard
                    </Button>
                    <Button size="sm">
                      <HugeiconsIcon icon={Scissor01Icon} aria-hidden="true" />
                      Publish clip
                    </Button>
                  </CardFooter>
                </Card>
              </div>
            }
            aside={
              <div className="flex flex-col gap-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <HugeiconsIcon icon={CheckmarkCircle01Icon} aria-hidden="true" />
                      Clip published
                    </CardTitle>
                    <CardDescription>{published.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup>
                      <CopyField
                        label="Link"
                        value={published.link}
                        copyLabel="Copy"
                        copiedLabel="Link copied"
                        copyFailedLabel="Could not copy the link"
                      />
                      <Field>
                        <FieldTitle>Embed</FieldTitle>
                        <CodeBlock
                          value={published.embed}
                          label="Copy embed code"
                          copiedLabel="Embed code copied"
                          copyFailedLabel="Could not copy the embed code"
                        />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm">
                          Share to fediverse
                        </Button>
                        <Button variant="outline" size="sm">
                          <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
                          Download
                        </Button>
                      </div>
                    </FieldGroup>
                  </CardContent>
                </Card>
                <Section heading="More from rivertide">
                  <div className="flex flex-col gap-3">
                    {more.map((item) => (
                      <MediaCard key={item.id} media={item} layout="compact" variant="clip" href={`#clip/${item.id}`} />
                    ))}
                  </div>
                </Section>
              </div>
            }
          />
        </PageContainer>
      </ViewerPage>
    </div>
  );
}

export const Default: Story = { render: () => <ClipPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
