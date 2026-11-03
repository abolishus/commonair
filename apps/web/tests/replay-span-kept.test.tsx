// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The replay panel's `replay-span-kept` marker (batch 8, B8-web; docs/testing/b8-selectors.md):
 * absent until a deep seek keeps the first span, then present in the panel's root with
 * `data-spans`, hidden from everyone but the harness.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ReplayFetchInput, ReplayItem, ReplayPage } from "../src/chat/replay/model.ts";
import { ReplayPanel } from "../src/chat/replay/replay-panel.tsx";
import { isoToMicros } from "../src/chat/replay/time.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const LINES: ReplayItem[] = Array.from(
  { length: 200 },
  (_, i) =>
    ({
      id: `01900000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
      channelId: "01900000-0000-7000-8000-00000000c001",
      user: {
        id: "01900000-0000-7000-8000-0000000000a1",
        username: "fan",
        displayName: "Fan",
        color: null,
        badges: [],
        accountType: "human",
      },
      body: `line ${i}`,
      emotes: [],
      isAction: false,
      replyTo: null,
      mediaTs: at(i * 60),
      createdAt: at(i * 60),
      at: at(i * 60),
      catchingUp: false,
    }) as ReplayItem,
);

async function fetchPage(input: ReplayFetchInput): Promise<ReplayPage> {
  let start = 0;
  if (input.cursor !== undefined) start = Number(input.cursor);
  else if (input.from !== undefined) {
    const from = isoToMicros(input.from);
    start = Math.max(
      0,
      LINES.findIndex((l) => isoToMicros(l.at) >= from),
    );
  }
  const items = LINES.slice(start, start + 5);
  return { items, nextCursor: start + 5 < LINES.length ? String(start + 5) : null, retained: true };
}

const noBlocks = {
  ids: async () => ({ userIds: [] }),
  add: async () => ({ user: { id: "", username: "", displayName: "" } }),
  remove: async () => ({}),
};

function panel(playheadSec: number): React.ReactNode {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <ReplayPanel
          fetch={fetchPage}
          viewer={null}
          playheadMicros={(T0 + playheadSec * 1000) * 1000}
          originMicros={T0 * 1000}
          onSeek={() => {}}
          blocksClient={noBlocks}
        />
      </TooltipProvider>
    </LocaleProvider>
  );
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

describe("replay-span-kept", () => {
  it("appears with data-spans once a deep seek keeps the first span", async () => {
    const view = render(panel(60));
    await flush();
    expect(screen.queryByTestId("replay-span-kept")).toBeNull();
    view.rerender(panel(120 * 60));
    await flush();
    const marker = screen.getByTestId("replay-span-kept");
    expect(marker.dataset.spans).toBe("2");
    expect(marker.hidden).toBe(true);
    expect(marker.closest('[data-testid="replay-panel"]')).not.toBeNull();
  });
});
