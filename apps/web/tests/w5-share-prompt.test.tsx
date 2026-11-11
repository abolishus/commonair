// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * w5-studio (J2-e): the first stream's share prompt in the LiveStatusBar's slot. It shows only while
 * a channel that never finished a stream is live, Copy link copies the channel's address, Share
 * uses the Web Share API only where the browser has one (no fallback beyond Copy link), and
 * dismissing is remembered per channel even when storage throws.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderInRouter } from "./d1-fixtures.tsx";

const track = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => {
    track.calls.push(`${surface}|${action}|${step}`);
  },
}));
const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (m: string) => toasts.success.push(m),
    error: (m: string) => toasts.error.push(m),
  },
}));

const { StudioLiveStatusBar } = await import("../src/components/studio-shell/live-status.tsx");
const { SharePrompt } = await import("../src/components/share-prompt/share-prompt.tsx");
const model = await import("../src/components/share-prompt/model.ts");
const { t } = await import("../src/i18n/index.ts");

type StatusChannel = import("../src/components/studio-shell/model.ts").StatusChannel;
type StatusHealth = import("../src/components/studio-shell/model.ts").StatusHealth;
type StatusPollEnv = import("../src/components/studio-shell/use-live-status.ts").StatusPollEnv;
type ShareFn = import("../src/components/share-prompt/model.ts").ShareFn;

const LIVE = { startedAt: "2026-11-11T11:00:00.000Z", viewerCount: 3, title: "First stream" };
const channel = (over: Partial<StatusChannel> = {}): StatusChannel => ({
  slug: "aurora",
  live: LIVE,
  lastLiveAt: null,
  ...over,
});
const health = (live: boolean): StatusHealth => ({
  live,
  samples: [],
  viewers: { verified: 0, pending: 0, excluded: 0 },
});

const env: StatusPollEnv = {
  isVisible: () => true,
  onVisibilityChange: () => () => undefined,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
};

async function bar(c: StatusChannel) {
  const loader = { channel: async () => c, health: async () => health(c.live !== null) };
  await renderInRouter(<StudioLiveStatusBar slug="aurora" pathname="/dashboard" loader={loader} env={env} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await screen.findByTestId("studio-status-bar");
}

beforeEach(() => {
  window.localStorage.clear();
  track.calls = [];
  toasts.success = [];
  toasts.error = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the rules", () => {
  it("shows while live for the first time and not dismissed", () => {
    expect(model.sharePromptVisible({ live: true, lastLiveAt: null, dismissed: false })).toBe(true);
    expect(model.sharePromptVisible({ live: false, lastLiveAt: null, dismissed: false })).toBe(false);
    expect(model.sharePromptVisible({ live: true, lastLiveAt: "2026-11-10T19:00:00.000Z", dismissed: false })).toBe(
      false,
    );
    expect(model.sharePromptVisible({ live: true, lastLiveAt: null, dismissed: true })).toBe(false);
  });

  it("remembers the dismissal per channel, and survives storage that throws", () => {
    model.dismissSharePrompt("aurora");
    expect(model.sharePromptDismissed("aurora")).toBe(true);
    expect(model.sharePromptDismissed("sly")).toBe(false);
    expect(window.localStorage.getItem(model.sharePromptKey("aurora"))).toBe("1");
    // A private window whose storage refuses every access.
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(model.sharePromptDismissed("aurora")).toBe(false);
      expect(() => model.dismissSharePrompt("aurora")).not.toThrow();
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  });

  it("builds the channel link and finds the Web Share API only where it exists", async () => {
    expect(model.channelLink("https://site.test/", "aurora")).toBe("https://site.test/aurora");
    expect(model.channelLink("https://site.test", "a b")).toBe("https://site.test/a%20b");
    expect(model.webShare(undefined)).toBeNull();
    expect(model.webShare({})).toBeNull();
    const share = vi.fn<(d: ShareData) => Promise<void>>(async () => undefined);
    const nav = { share };
    const fn = model.webShare(nav);
    await fn?.({ url: "https://site.test/aurora" });
    expect(share).toHaveBeenCalledWith({ url: "https://site.test/aurora" });
  });
});

describe("in the LiveStatusBar", () => {
  it("the first live stream shows it in the bar's slot", async () => {
    await bar(channel());
    const prompt = await screen.findByTestId("studio-share-prompt");
    expect(prompt.closest('[data-slot="live-status-slot"]')).not.toBeNull();
    expect(prompt.textContent).toContain(t("w5Studio.share.title"));
    expect(track.calls).toContain("studio.sharePrompt|view|none");
  });

  it("not after the first stream ended, not offline", async () => {
    await bar(channel({ lastLiveAt: "2026-11-10T19:00:00.000Z" }));
    expect(screen.queryByTestId("studio-share-prompt")).toBeNull();
    cleanup();
    await bar(channel({ live: null }));
    expect(screen.queryByTestId("studio-share-prompt")).toBeNull();
  });

  it("dismissing hides it and keeps it hidden for that channel", async () => {
    await bar(channel());
    fireEvent.click(await screen.findByTestId("studio-share-dismiss"));
    expect(screen.queryByTestId("studio-share-prompt")).toBeNull();
    expect(track.calls).toContain("studio.sharePrompt|dismiss|none");
    cleanup();
    await bar(channel());
    expect(screen.queryByTestId("studio-share-prompt")).toBeNull();
  });
});

describe("SharePrompt", () => {
  it("Copy link copies the channel's address and says so", async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderInRouter(
      <SharePrompt channel="aurora" origin="https://site.test" share={null} onDismiss={() => undefined} />,
    );
    await act(async () => {
      fireEvent.click(await screen.findByTestId("studio-share-copy"));
    });
    expect(writeText).toHaveBeenCalledWith("https://site.test/aurora");
    expect(toasts.success).toEqual([t("w5Studio.share.copied")]);
    expect(track.calls).toContain("studio.sharePrompt|click|copy");
  });

  it("a failed copy says so", async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderInRouter(
      <SharePrompt channel="aurora" origin="https://site.test" share={null} onDismiss={() => undefined} />,
    );
    await act(async () => {
      fireEvent.click(await screen.findByTestId("studio-share-copy"));
    });
    expect(toasts.error).toEqual([t("w5Studio.share.copyFailed")]);
  });

  it("without the Web Share API there is no Share button, only Copy link", async () => {
    await renderInRouter(
      <SharePrompt channel="aurora" origin="https://site.test" share={null} onDismiss={() => undefined} />,
    );
    expect(await screen.findByTestId("studio-share-copy")).toBeTruthy();
    expect(screen.queryByTestId("studio-share-native")).toBeNull();
  });

  it("with it, Share opens the device's share sheet; closing it is not an error", async () => {
    const share = vi.fn<ShareFn>(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    await renderInRouter(
      <SharePrompt channel="aurora" origin="https://site.test" share={share} onDismiss={() => undefined} />,
    );
    await act(async () => {
      fireEvent.click(await screen.findByTestId("studio-share-native"));
    });
    expect(share).toHaveBeenCalledWith({ title: t("w5Studio.share.shareTitle"), url: "https://site.test/aurora" });
    expect(toasts.error).toEqual([]);
    expect(track.calls).toContain("studio.sharePrompt|click|share");
  });
});
