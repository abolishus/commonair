// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-dashboard: the board rebalanced for live work (D5.2). Live numbers and the title editor first
 * on wide screens, chat first on phones (CSS order), the preview's Hide toggle, stream info's save
 * hook and focus target, `renderTop` fed from the same channel poll, and Retry (never "reload the
 * page") when the preview's channel read or the stream setup fails.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ActivitySource } from "../src/components/studio/activity-feed.tsx";
import type { StreamInfo, StreamInfoClient } from "../src/components/studio/stream-info.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { PollEnv, StreamHealthDto } from "../src/lib/stream-health.ts";

vi.mock("../src/player/player.tsx", () => ({ Player: () => null }));
vi.mock("../src/chat/chat-panel.tsx", () => ({ ChatPanel: () => null }));
const ingest = vi.hoisted(() => ({ fail: true, calls: 0 }));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  return {
    ...actual,
    api: () => ({
      stream: {
        ingest: async () => {
          ingest.calls += 1;
          if (ingest.fail) throw Object.assign(new Error("down"), { status: 500 });
          return { rtmpUrl: "rtmp://ingest.test/live", activeKeyPrefix: null };
        },
      },
    }),
  };
});
// The checklist and recap have their own tests; here only where they sit matters.
vi.mock("../src/components/setup-checklist/checklist.tsx", () => ({
  GoLiveChecklist: () => <section data-testid="setup-checklist" />,
}));
vi.mock("../src/components/recap/stream-recap.tsx", () => ({
  StreamRecap: () => <section data-testid="stream-recap" />,
}));
vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => ({ config: { ingestRtmpUrl: "rtmp://cfg.test/live" } }),
}));

const { ControlRoom } = await import("../src/components/studio/control-room.tsx");
const { StreamManager } = await import("../src/components/studio/stream-manager.tsx");
const { StreamSetup } = await import("../src/components/studio/stream-setup.tsx");
const { DashboardTop } = await import("../src/components/studio/dashboard-top.tsx");
const { focusStreamInfoTitle, STREAM_INFO_TITLE_ID } = await import("../src/components/studio/stream-info.tsx");
type LiveChannel = import("../src/components/studio/control-room.tsx").LiveChannel;

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

const INFO: StreamInfo = { title: "Painting skies", category: { id: "c-art", name: "Art" }, tags: [], socials: [] };
const infoClient = (over: Partial<StreamInfoClient> = {}): StreamInfoClient => ({
  get: vi.fn<StreamInfoClient["get"]>(async () => INFO),
  update: vi.fn<StreamInfoClient["update"]>(async (_c, info) => info),
  categories: vi.fn<StreamInfoClient["categories"]>(async () => []),
  ...over,
});
const OFFLINE_HEALTH: StreamHealthDto = {
  live: false,
  broadcastId: null,
  ingestProtocol: null,
  transcodeActive: false,
  renditions: [],
  samples: [],
  simulcast: [],
  viewers: { verified: 0, pending: 0, excluded: 0 },
};
const quiet: ActivitySource = () => () => undefined;

function board(over: Partial<React.ComponentProps<typeof StreamManager>> = {}) {
  return (
    <StreamManager
      channel="aurora"
      startedAt={null}
      preview={<div data-testid="fake-player" />}
      chat={<div data-testid="fake-chat" />}
      infoClient={infoClient()}
      healthLoad={async () => OFFLINE_HEALTH}
      activitySource={quiet}
      {...over}
    />
  );
}

const orderOf = (el: Element | null) => /(?:^|\s)order-(\d)/.exec(el?.className ?? "")?.[1];

describe("the rebalanced board", () => {
  it("puts chat first on phones, then stream info, preview and health; numbers and the editor lead on wide screens", () => {
    wrap(board());
    const chat = screen.getByTestId("stream-chat");
    const info = document.querySelector('[data-slot="stream-info"]');
    const preview = screen.getByTestId("stream-preview");
    const health = document.querySelector('[data-slot="stream-health"]');
    expect(orderOf(chat)).toBe("1");
    expect(orderOf(chat.parentElement)).toBeUndefined();
    expect(chat.parentElement?.className).toContain("contents");
    expect([orderOf(info), orderOf(preview), orderOf(health)]).toEqual(["1", "2", "3"]);
    expect(info?.className).toContain("lg:order-2");
    expect(health?.className).toContain("lg:order-1");
    expect(preview.className).toContain("lg:order-3");
  });

  it("hides and shows the preview", () => {
    wrap(board());
    const toggle = screen.getByTestId("stream-preview-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe(t("d5Dashboard.preview.hide"));
    fireEvent.click(toggle);
    expect(screen.queryByTestId("fake-player")).toBeNull();
    expect(screen.getByTestId("stream-preview").getAttribute("data-shown")).toBe("false");
    expect(toggle.textContent).toBe(t("d5Dashboard.preview.show"));
    fireEvent.click(toggle);
    expect(screen.getByTestId("fake-player")).toBeTruthy();
  });

  it("tells the page when stream info saves, and the title input is the checklist's focus target", async () => {
    const onInfoSaved = vi.fn<() => void>();
    wrap(board({ onInfoSaved }));
    const title = await screen.findByTestId("stream-info-title");
    expect(title.id).toBe(STREAM_INFO_TITLE_ID);
    fireEvent.change(title, { target: { value: "Night skies" } });
    fireEvent.click(screen.getByTestId("stream-info-save"));
    await waitFor(() => expect(onInfoSaved).toHaveBeenCalledTimes(1));
    const scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
    title.scrollIntoView = scroll;
    expect(focusStreamInfoTitle()).toBe(true);
    expect(document.activeElement).toBe(title);
    expect(scroll).toHaveBeenCalled();
  });

  it("focusStreamInfoTitle is false off the page", () => {
    expect(focusStreamInfoTitle()).toBe(false);
  });
});

describe("ControlRoom", () => {
  const env: PollEnv = {
    isVisible: () => true,
    onVisibilityChange: () => () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };

  it("hands renderTop the channel from the same poll", async () => {
    const channel: LiveChannel = {
      id: "ch-1",
      displayName: "Aurora",
      live: null,
      lastLiveAt: "2026-11-10T19:50:00.000Z",
      vodEnabled: true,
      ownerCoop: { member: true, council: false },
    };
    const seen: (LiveChannel | null)[] = [];
    const load = vi.fn<(slug: string) => Promise<LiveChannel>>(async () => channel);
    wrap(
      <ControlRoom
        slug="aurora"
        username="aurora"
        load={load}
        pollEnv={env}
        renderPreview={() => <div data-testid="fake-player" />}
        renderChat={() => null}
        renderTop={(c) => {
          seen.push(c);
          return <div data-testid="top" data-last={c?.lastLiveAt ?? ""} />;
        }}
        infoClient={infoClient()}
        healthLoad={async () => OFFLINE_HEALTH}
        activitySource={quiet}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("top").getAttribute("data-last")).toBe(channel.lastLiveAt));
    expect(seen[0]).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a failed channel read shows Retry, which reads again", async () => {
    let fail = true;
    const load = vi.fn<(slug: string) => Promise<LiveChannel>>(async () => {
      if (fail) throw new Error("down");
      return { id: "ch-1", displayName: "Aurora", live: null };
    });
    wrap(
      <ControlRoom
        slug="aurora"
        username="aurora"
        load={load}
        pollEnv={env}
        renderPreview={() => <div data-testid="fake-player" />}
        renderChat={() => null}
        infoClient={infoClient()}
        healthLoad={async () => OFFLINE_HEALTH}
        activitySource={quiet}
      />,
    );
    expect(await screen.findByTestId("stream-preview-error")).toBeTruthy();
    expect(screen.getByTestId("stream-preview-error").textContent).not.toMatch(/reload/i);
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByTestId("stream-preview-retry"));
    });
    expect(await screen.findByTestId("fake-player")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("DashboardTop above the board", () => {
  const env: PollEnv = {
    isVisible: () => true,
    onVisibilityChange: () => () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  let answered = false;
  const room = (channel: LiveChannel) => {
    answered = false;
    return wrap(
      <ControlRoom
        slug="aurora"
        username="aurora"
        load={async () => channel}
        pollEnv={env}
        renderPreview={() => <div data-testid="fake-player" />}
        renderChat={() => null}
        renderTop={(c) => {
          if (c) answered = true;
          return (
            <DashboardTop
              channel={c}
              slug="aurora"
              publicUrl="https://example.test"
              refreshKey="0"
              onEditInfo={() => undefined}
            />
          );
        }}
        infoClient={infoClient()}
        healthLoad={async () => OFFLINE_HEALTH}
        activitySource={quiet}
      />,
    );
  };
  const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("offline: the recap and checklist sit above stream info and health", async () => {
    room({ id: "ch-1", displayName: "Aurora", live: null, lastLiveAt: "2026-11-10T19:50:00.000Z" });
    const checklist = await screen.findByTestId("setup-checklist");
    expect(screen.getByTestId("stream-recap")).toBeTruthy();
    const info = document.querySelector('[data-slot="stream-info"]');
    const health = document.querySelector('[data-slot="stream-health"]');
    expect(info && before(checklist, info)).toBe(true);
    expect(health && before(checklist, health)).toBe(true);
  });

  it("live: no checklist or recap, so stream info and health lead the page", async () => {
    room({ id: "ch-1", displayName: "Aurora", live: { startedAt: "2026-11-11T18:00:00.000Z" } });
    await waitFor(() => expect(answered).toBe(true));
    expect(document.querySelector('[data-slot="stream-info"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="stream-health"]')).toBeTruthy();
    expect(screen.queryByTestId("setup-checklist")).toBeNull();
    expect(screen.queryByTestId("stream-recap")).toBeNull();
  });

  it("waits for the first channel answer before showing the checklist", () => {
    wrap(
      <DashboardTop
        channel={null}
        slug="aurora"
        publicUrl="https://example.test"
        refreshKey="0"
        onEditInfo={() => undefined}
      />,
    );
    expect(screen.queryByTestId("setup-checklist")).toBeNull();
  });
});

describe("StreamSetup (stream settings)", () => {
  it("a failed load shows Retry, which loads the key state again", async () => {
    ingest.fail = true;
    ingest.calls = 0;
    wrap(<StreamSetup channel="aurora" />);
    expect(await screen.findByTestId("stream-setup-error")).toBeTruthy();
    // The configured server URL still shows while the API is down.
    expect(screen.getByTestId("stream-server-url").textContent).toBe("rtmp://cfg.test/live");
    ingest.fail = false;
    fireEvent.click(screen.getByTestId("stream-setup-retry"));
    await waitFor(() => expect(screen.queryByTestId("stream-setup-error")).toBeNull());
    expect(screen.getByTestId("stream-server-url").textContent).toBe("rtmp://ingest.test/live");
    expect(ingest.calls).toBe(2);
  });
});
