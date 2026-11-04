// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-studio F21: the stream manager as a control room. The grid's panels (preview and chat slots,
 * live stats and health, stream info, quick actions, activity), "Edit stream info" saving
 * optimistically and rolling back on error, the health numbers from the newest sample, and the
 * activity feed from platform event frames (follows and giveaways too, once they are forwarded).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { StreamHealthCard, latestSample } from "../src/components/stream-health-card.tsx";
import { activityFromEvent, pushActivity } from "../src/components/studio/activity.ts";
import type { ActivitySource } from "../src/components/studio/activity-feed.tsx";
import { StreamManager } from "../src/components/studio/stream-manager.tsx";
import { streamInfoError, type StreamInfo, type StreamInfoClient } from "../src/components/studio/stream-info.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { StreamHealthDto } from "../src/lib/stream-health.ts";

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

const sample = (at: string, over: Partial<StreamHealthDto["samples"][number]> = {}) => ({
  at,
  bitrateKbps: 6000,
  fps: 60,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  keyframeIntervalMs: 2000,
  droppedFrames: 12,
  warnings: [],
  ...over,
});

const liveHealth: StreamHealthDto = {
  live: true,
  broadcastId: "01900000-0000-7000-8000-0000000000b1",
  ingestProtocol: "rtmp",
  transcodeActive: true,
  renditions: [],
  // The newer sample is listed first: the card must not rely on the order.
  samples: [
    sample("2026-11-04T10:01:00.000Z", { bitrateKbps: 5800, droppedFrames: 3 }),
    sample("2026-11-04T10:00:00.000Z"),
  ],
  simulcast: [],
  viewers: { verified: 42, pending: 3, excluded: 7 },
};

const INFO: StreamInfo = { title: "Painting skies", category: { id: "c-art", name: "Art" }, tags: ["chill"] };

function infoClient(update: StreamInfoClient["update"]): StreamInfoClient {
  return {
    get: vi.fn<StreamInfoClient["get"]>(async () => INFO),
    update: vi.fn<StreamInfoClient["update"]>(update),
    categories: vi.fn<StreamInfoClient["categories"]>(async () => [
      { id: "c-art", name: "Art" },
      { id: "c-music", name: "Music" },
    ]),
  };
}

const quietSource: ActivitySource = () => () => undefined;

function manager(over: Partial<React.ComponentProps<typeof StreamManager>> = {}) {
  return (
    <StreamManager
      channel="aurora"
      startedAt="2026-11-04T09:00:00.000Z"
      preview={<div data-testid="fake-player">player</div>}
      chat={<div data-testid="fake-chat">chat</div>}
      infoClient={infoClient(async (_c, info) => info)}
      healthLoad={async () => liveHealth}
      activitySource={quietSource}
      {...over}
    />
  );
}

describe("the control room grid", () => {
  it("has the preview, chat, live stats, stream info, quick actions and activity", async () => {
    wrap(manager());
    for (const id of [
      "stream-manager",
      "stream-preview",
      "fake-player",
      "stream-chat",
      "fake-chat",
      "stream-health",
      "stream-info",
      "stream-quick-actions",
      "stream-activity",
    ])
      expect(screen.getByTestId(id), id).toBeTruthy();
    // Quick actions: a poll or prediction, rehearsal, and the stream's settings.
    const hrefs = ["stream-quick-poll", "stream-quick-rehearse", "stream-quick-settings"].map((id) =>
      screen.getByTestId(id).getAttribute("href"),
    );
    expect(hrefs).toEqual(["/interact", "/rehearse", "/dashboard/settings"]);
    await waitFor(() => expect(screen.getByTestId("stream-info-shown")).toBeTruthy());
  });

  it("the activity feed starts empty and says so", () => {
    wrap(manager());
    expect(screen.getByTestId("stream-activity-empty")).toBeTruthy();
    expect(screen.getByTestId("stream-activity").getAttribute("data-count")).toBe("0");
  });
});

describe("Edit stream info", () => {
  it("shows the new info at once and keeps it when the save succeeds", async () => {
    let resolve: (info: StreamInfo) => void = () => undefined;
    const client = infoClient(
      (_c, info) =>
        new Promise<StreamInfo>((r) => {
          resolve = () => r(info);
        }),
    );
    wrap(manager({ infoClient: client }));
    const title = await screen.findByTestId("stream-info-title");
    expect((title as HTMLInputElement).value).toBe("Painting skies");
    fireEvent.change(title, { target: { value: "Night skies" } });
    fireEvent.click(screen.getByTestId("stream-info-save"));
    // Optimistic: before the server answers.
    expect(screen.getByTestId("stream-info-shown").getAttribute("data-title")).toBe("Night skies");
    expect(screen.getByTestId("stream-info-save").getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve(INFO));
    await waitFor(() => expect(screen.getByTestId("stream-info-save").hasAttribute("aria-busy")).toBe(false));
    expect(screen.getByTestId("stream-info-shown").getAttribute("data-title")).toBe("Night skies");
    expect(client.update).toHaveBeenCalledWith("aurora", { ...INFO, title: "Night skies" });
  });

  it("rolls back what viewers see when the save fails, and keeps the draft", async () => {
    let reject: (err: unknown) => void = () => undefined;
    const client = infoClient(
      () =>
        new Promise<StreamInfo>((_r, j) => {
          reject = j;
        }),
    );
    wrap(manager({ infoClient: client }));
    const title = await screen.findByTestId("stream-info-title");
    fireEvent.change(title, { target: { value: "Broken save" } });
    fireEvent.click(screen.getByTestId("stream-info-save"));
    expect(screen.getByTestId("stream-info-shown").getAttribute("data-title")).toBe("Broken save");
    await act(async () => reject(Object.assign(new Error("nope"), { code: "INTERNAL_SERVER_ERROR" })));
    await waitFor(() =>
      expect(screen.getByTestId("stream-info-shown").getAttribute("data-title")).toBe("Painting skies"),
    );
    expect(screen.getByTestId("stream-info-shown").getAttribute("data-category")).toBe("c-art");
    expect((screen.getByTestId("stream-info-title") as HTMLInputElement).value).toBe("Broken save");
  });

  it("refuses tags the API would refuse, only after a save attempt", async () => {
    expect(streamInfoError(INFO)).toBeNull();
    expect(streamInfoError({ ...INFO, tags: ["no spaces"] })).toBe(
      "Tags use letters, numbers and dashes only, up to 25 characters each.",
    );
    expect(streamInfoError({ ...INFO, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toBe(
      "You can add at most 10 tags.",
    );
    expect(streamInfoError({ ...INFO, tags: ["x".repeat(26)] })).not.toBeNull();
    expect(streamInfoError({ ...INFO, tags: ["café-2"] })).toBeNull();
  });
});

describe("health numbers", () => {
  it("shows viewers, uptime, bitrate, fps, dropped frames and resolution from the newest sample", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T10:30:00.000Z"));
    try {
      wrap(<StreamHealthCard channel="aurora" startedAt="2026-11-04T09:00:00.000Z" load={async () => liveHealth} />);
      await waitFor(() => expect(screen.getByTestId("stream-health-numbers")).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
    const value = (metric: string) =>
      document
        .querySelector(`[data-testid="stream-health-number"][data-metric="${metric}"]`)
        ?.getAttribute("data-value");
    expect(value("viewers")).toBe("42");
    expect(value("uptime")).toBe(String(90 * 60));
    expect(value("bitrate")).toBe("5800");
    expect(value("fps")).toBe("60");
    expect(value("dropped")).toBe("3");
    expect(value("resolution")).toBe("1920x1080");
    expect(screen.getByTestId("stream-health-numbers").textContent).toContain("1:30:00");
  });

  it("leaves out what the sample does not carry, and shows no numbers offline", async () => {
    const partial = { ...liveHealth, samples: [sample("2026-11-04T10:00:00.000Z", { fps: null, width: null })] };
    wrap(<StreamHealthCard channel="aurora" load={async () => partial} />);
    await waitFor(() => expect(screen.getByTestId("stream-health-numbers")).toBeTruthy());
    const metrics = [...document.querySelectorAll('[data-testid="stream-health-number"]')].map((n) =>
      n.getAttribute("data-metric"),
    );
    expect(metrics).toEqual(["viewers", "bitrate", "dropped"]);
    cleanup();
    wrap(<StreamHealthCard channel="aurora" load={async () => ({ ...liveHealth, live: false })} />);
    await waitFor(() => expect(document.querySelector('[data-state="offline"]')).toBeTruthy());
    expect(screen.queryByTestId("stream-health-numbers")).toBeNull();
    expect(screen.getByTestId("empty-state-action").getAttribute("href")).toBe("/dashboard/settings");
  });

  it("picks the newest sample whatever the order, and none while offline", () => {
    expect(latestSample(liveHealth)?.at).toBe("2026-11-04T10:01:00.000Z");
    expect(latestSample({ ...liveHealth, live: false })).toBeNull();
    expect(latestSample({ ...liveHealth, samples: [] })).toBeNull();
  });
});

describe("activity", () => {
  const broadcaster = {
    broadcaster_user_id: "01900000-0000-7000-8000-000000000001",
    broadcaster_user_login: "aurora",
    broadcaster_user_name: "Aurora",
  };

  it("lists events newest first as they arrive", async () => {
    let emit: (type: string, data: unknown) => void = () => undefined;
    const source: ActivitySource = (_channel, onEvent) => {
      emit = onEvent;
      return () => undefined;
    };
    wrap(manager({ activitySource: source }));
    act(() =>
      emit("channel.raid", {
        ...broadcaster,
        from_broadcaster_user_id: "01900000-0000-7000-8000-000000000002",
        from_broadcaster_user_login: "lumen",
        from_broadcaster_user_name: "Lumen",
        to_broadcaster_user_id: broadcaster.broadcaster_user_id,
        to_broadcaster_user_login: "aurora",
        to_broadcaster_user_name: "Aurora",
        viewers: 12,
      }),
    );
    act(() => emit("channel.chat.message", { nope: true }));
    act(() =>
      emit("channel.follow", {
        ...broadcaster,
        user_id: "01900000-0000-7000-8000-000000000003",
        user_login: "pip",
        user_name: "Pip",
        followed_at: "2026-11-04T10:00:00.000Z",
      }),
    );
    const items = await screen.findAllByTestId("stream-activity-item");
    expect(items.map((i) => i.getAttribute("data-kind"))).toEqual(["follow", "raid"]);
    expect(items[0]?.textContent).toContain("Pip followed");
  });

  it("parses giveaway results and drops what does not validate", () => {
    const end = activityFromEvent(
      "channel.giveaway.end",
      {
        ...broadcaster,
        id: "01900000-0000-7000-8000-0000000000g1",
        title: "Prints",
        status: "drawn",
        entries: 40,
        winners: 2,
        seed: "abc",
        started_at: "2026-11-04T09:00:00.000Z",
        ended_at: "2026-11-04T09:30:00.000Z",
      },
      "2026-11-04T10:00:00.000Z",
      0,
    );
    expect(end).toMatchObject({
      kind: "giveaway",
      title: "Prints",
      count: 2,
      drawn: true,
      at: "2026-11-04T09:30:00.000Z",
    });
    expect(activityFromEvent("channel.follow", { user_login: "x" }, "", 0)).toBeNull();
    expect(activityFromEvent("channel.poll.begin", {}, "", 0)).toBeNull();
  });

  it("keeps the newest items and ignores a repeated id", () => {
    const item = (id: string) =>
      ({
        id,
        kind: "follow",
        name: id,
        tier: null,
        count: null,
        amount: null,
        viewers: null,
        title: null,
        drawn: null,
        at: "",
      }) as const;
    let list = pushActivity([], item("a"), 2);
    list = pushActivity(list, item("b"), 2);
    list = pushActivity(list, item("c"), 2);
    expect(list.map((i) => i.id)).toEqual(["c", "b"]);
    expect(pushActivity(list, item("b"), 2).map((i) => i.id)).toEqual(["c", "b"]);
  });
});
