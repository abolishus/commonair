// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ACCENTS } from "@commonair/contracts/shapes";
import { InboxIcon, Tv01Icon } from "@hugeicons/core-free-icons";
import { Arcs, CategoryArt, EmptyArt, MediaFallback, SignalBars } from "../../src/index.ts";

/** The art system on one page: every motif in both themes, so the set reads as one design. */
function Gallery() {
  return (
    <div className="flex max-w-5xl flex-col gap-10 p-4">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Arcs</h2>
        <div className="flex flex-wrap items-end gap-6">
          <Arcs className="size-6 text-foreground" />
          <Arcs className="size-12 text-muted-foreground" />
          <Arcs className="size-24 text-channel-accent" data-accent="violet" />
          <Arcs crossed className="size-24 text-muted-foreground" />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Signal bars</h2>
        <SignalBars className="h-12 max-w-md" />
        <SignalBars seed="music" className="h-12 max-w-md" />
        <SignalBars variant="band" />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Empty art</h2>
        <div className="flex flex-wrap items-end gap-6">
          {(["sm", "md", "lg"] as const).map((size) => (
            <EmptyArt key={`a-${size}`} size={size} />
          ))}
          <EmptyArt variant="bars" />
          <EmptyArt variant="glyph" icon={InboxIcon} />
          <EmptyArt variant="glyph" icon={Tv01Icon} data-accent="teal" />
          <EmptyArt variant="glyph" crossed />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Media fallback</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <span className="block aspect-video">
            <MediaFallback kind="offline" accent="pink" name="Mika Draws" label="Offline" />
          </span>
          <span className="block aspect-video">
            <MediaFallback kind="nothumb" accent="sky" name="Lumen Beats" />
          </span>
          <span className="block aspect-video">
            <MediaFallback kind="vod" accent="green" />
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ACCENTS.map((accent) => (
            <span key={accent} className="block aspect-video">
              <MediaFallback kind="offline" accent={accent} name={accent} />
            </span>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Category art</h2>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {["art", "music", "retro-games", "software", "cooking", "outdoors"].map((slug) => (
            <CategoryArt key={slug} slug={slug} shape="portrait" iconSize="lg" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CategoryArt slug="chess" shape="landscape" />
          <CategoryArt slug="talk" shape="landscape" accent="red" />
          <CategoryArt slug="music" shape="landscape" muted />
          <CategoryArt slug="hollow-depths" shape="landscape" muted />
        </div>
      </section>
    </div>
  );
}

const meta = {
  title: "Art/Gallery",
  component: Gallery,
} satisfies Meta<typeof Gallery>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const RightToLeft: Story = { globals: { dir: "rtl" } };
