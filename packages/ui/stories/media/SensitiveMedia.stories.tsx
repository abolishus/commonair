// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../../src/components/button.tsx";
import { FrameTile, SensitiveMedia } from "../../src/blocks/media/index.ts";
import { thumbnail } from "../fixtures.ts";

const meta = {
  title: "Blocks/Media/SensitiveMedia",
  component: SensitiveMedia,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SensitiveMedia>;
export default meta;
type Story = StoryObj;

/** Synthetic pattern images only: a flagged frame in review is shown blurred until revealed. */
function Frames(): React.JSX.Element {
  const [revealed, setRevealed] = React.useState<string | null>(null);
  return (
    <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
      {(["teal", "violet"] as const).map((accent) => (
        <FrameTile
          key={accent}
          src={thumbnail(accent)}
          alt={`Flagged frame (${accent} pattern)`}
          revealed={revealed === accent}
          onReveal={() => setRevealed(accent)}
          revealLabel="Reveal frame"
          notice="Blurred: flagged by the classifier"
          caption="sexual 0.99 · nsfwjs 2.4.2"
        />
      ))}
      <FrameTile src={null} alt="" revealed={false} revealLabel="Reveal frame" caption="Loading" />
    </div>
  );
}

function Restricted(): React.JSX.Element {
  const [obscured, setObscured] = React.useState(true);
  return (
    <SensitiveMedia
      obscured={obscured}
      className="max-w-2xl"
      overlay={
        <>
          <p className="font-medium">This stream is under review</p>
          <Button size="sm" variant="outline" onClick={() => setObscured(false)}>
            Show anyway
          </Button>
        </>
      }
    >
      <img src={thumbnail("amber")} alt="Stream (amber pattern)" className="aspect-video w-full object-cover" />
    </SensitiveMedia>
  );
}

export const Default: Story = { render: () => <Frames /> };
export const Light: Story = { render: () => <Frames />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Frames />, globals: { viewport: { value: "mobile320" } } };
export const StreamUnderReview: Story = { render: () => <Restricted /> };
