// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every primitive must server-render and hydrate without mismatches: render to
 * a string, put it in the DOM, hydrate the same tree and fail on any React
 * warning or recoverable error.
 */
import { act } from "@testing-library/react";
import type * as React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { InboxIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { Line, LineChart } from "recharts";
import { Button } from "../src/components/button.tsx";
import { ChartContainer } from "../src/components/chart.tsx";
import { AccentButton } from "../src/primitives/accent-button.tsx";
import { OverlayBadge } from "../src/primitives/overlay-badge.tsx";
import { StatusBadge } from "../src/primitives/status-badge.tsx";
import { Gallery } from "../stories/Components.stories.tsx";
import {
  ChannelAvatar,
  CommandPalette,
  ConfirmDialog,
  EmptyState,
  IconButton,
  LiveBadge,
  LocaleProvider,
  MoneyAmount,
  NowProvider,
  RelativeTime,
  Shortcut,
  SkeletonGroup,
  SkeletonText,
  StreamCard,
  StreamCardSkeleton,
  ThemeToggle,
  ViewerCount,
} from "../src/index.ts";

const REQUEST_TIME = "2026-06-15T12:00:00Z";

const stream: StreamCardData = {
  channel: {
    id: "0190a8a0-0000-7000-8000-000000000001",
    slug: "pp",
    displayName: "Pixel Pioneer",
    avatarUrl: null,
    accent: "teal",
  },
  broadcast: {
    id: "0190a8a0-0000-7000-8000-000000000002",
    title: "Speedrunning",
    category: { id: "0190a8a0-0000-7000-8000-000000000003", slug: "retro", name: "Retro" },
    startedAt: "2026-06-15T10:00:00Z",
    mature: true,
    viewerCount: 15_300,
    thumbnailUrl: null,
  },
  tags: ["speedrun"],
  language: "en",
  reason: "spotlight",
};

const CASES: [string, React.ReactElement][] = [
  ["all shadcn components in the gallery", <Gallery key="gallery" />],
  ["StreamCard", <StreamCard key="x" stream={stream} href="/pp" />],
  ["StreamCardSkeleton", <StreamCardSkeleton key="x" />],
  ["ChannelAvatar", <ChannelAvatar key="x" name="émile" accent="violet" live />],
  ["LiveBadge", <LiveBadge key="x" pulse />],
  ["ViewerCount", <ViewerCount key="x" count={1234} />],
  ["RelativeTime", <RelativeTime key="x" date="2026-06-15T11:55:00Z" />],
  ["RelativeTime (future skew)", <RelativeTime key="x" date="2026-06-15T12:00:03Z" />],
  ["MoneyAmount", <MoneyAmount key="x" value={{ cents: 123456, currency: "HUF" }} />],
  [
    "EmptyState",
    <EmptyState key="x" icon={InboxIcon} title="Empty" description="Nothing here" action={<Button>Go</Button>} />,
  ],
  [
    "Skeletons",
    <SkeletonGroup key="x">
      <SkeletonText />
    </SkeletonGroup>,
  ],
  ["IconButton", <IconButton key="x" label="Settings" icon={Settings01Icon} />],
  ["ConfirmDialog", <ConfirmDialog key="x" trigger={<Button>Delete</Button>} title="Sure?" onConfirm={() => {}} />],
  ["Shortcut", <Shortcut key="x" keys={["mod", "k"]} />],
  ["CommandPalette", <CommandPalette key="x" open={false} onOpenChange={() => {}} groups={[]} />],
  ["ThemeToggle", <ThemeToggle key="x" value="system" onValueChange={() => {}} />],
  [
    "AccentButton",
    <AccentButton key="x" accent="teal">
      Follow
    </AccentButton>,
  ],
  ["OverlayBadge", <OverlayBadge key="x">2:34</OverlayBadge>],
  [
    "StatusBadge",
    <StatusBadge key="x" tone="success">
      Approved
    </StatusBadge>,
  ],
  [
    "ChartContainer with Recharts ResponsiveContainer",
    <ChartContainer key="x" config={{ viewers: { label: "Viewers", color: "var(--chart-1)" } }}>
      <LineChart data={[{ month: "Jan", viewers: 12 }]}>
        <Line dataKey="viewers" type="monotone" />
      </LineChart>
    </ChartContainer>,
  ],
];

function wrap(node: React.ReactElement): React.ReactElement {
  return (
    <LocaleProvider locale="en">
      <NowProvider now={REQUEST_TIME}>{node}</NowProvider>
    </LocaleProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("server rendering and hydration", () => {
  test.each(CASES)("%s hydrates without warnings", async (_name, node) => {
    const html = renderToString(wrap(node));
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);

    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    // Hydrate at a later wall-clock time than the server render, as in production.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 7_000);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, wrap(node), {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    expect(errors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    act(() => root?.unmount());
  });

  test("RelativeTime renders the request time on the server and switches to the live clock after mount", async () => {
    const node = <RelativeTime date="2026-06-15T11:59:00Z" tooltip={false} />;
    const html = renderToString(wrap(node));
    expect(html).toContain("1 minute ago");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-06-15T12:10:00Z").getTime());
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, wrap(node));
    });
    expect(container.textContent).toBe("11 minutes ago");
    act(() => root?.unmount());
  });

  test("a future time within the skew window reads now", () => {
    expect(renderToString(wrap(<RelativeTime date="2026-06-15T12:00:05Z" tooltip={false} />))).toContain(">now<");
    expect(renderToString(wrap(<RelativeTime date="2026-06-15T12:00:30Z" tooltip={false} />))).toContain(
      "in 30 seconds",
    );
  });
});
