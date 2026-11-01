// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `player.tsx`'s W2 slots (contract step §4): while a session plays, the captions toggle and the
 * DVR scrubber and controls get the controller and what `playback.start` granted (`onFeatures`).
 * The units fill those components; here they are markers echoing their props.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlayerControllerOptions, SessionFeatures } from "../src/player/controller.ts";
import type { CaptionsToggleProps } from "../src/player/captions-toggle.tsx";
import type { DvrSlotProps } from "../src/player/dvr-controls.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { setP2PStorage } from "../src/player/p2p/preference.ts";

class FakeController {
  static instances: FakeController[] = [];
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  disableP2P = vi.fn<() => void>();
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  playheadWallclock = () => null;
  playbackMode = () => "live" as const;
  onPlaybackMode = () => () => undefined;
}

vi.mock("../src/player/controller.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/controller.ts")>();
  return { ...real, PlayerController: FakeController };
});
vi.mock("../src/player/p2p/use-p2p.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/p2p/use-p2p.ts")>();
  return { ...real, useOperatorP2PDefault: () => "off" };
});
vi.mock("../src/lib/api.ts", () => ({ api: () => ({}), apiKeepalive: () => ({}) }));

const seen = { captions: [] as CaptionsToggleProps[], scrubber: [] as DvrSlotProps[], controls: [] as DvrSlotProps[] };
vi.mock("../src/player/captions-toggle.tsx", () => ({
  CaptionsToggle: (p: CaptionsToggleProps) => {
    seen.captions.push(p);
    return <span data-testid="slot-captions" data-state={p.captions.state} />;
  },
}));
vi.mock("../src/player/dvr-controls.tsx", () => ({
  DvrScrubber: (p: DvrSlotProps) => {
    seen.scrubber.push(p);
    return <span data-testid="slot-dvr-scrubber" data-window={p.grant?.windowSeconds ?? 0} />;
  },
  DvrControls: (p: DvrSlotProps) => {
    seen.controls.push(p);
    return <span data-testid="slot-dvr-controls" data-data-mode={String(p.dataMode)} />;
  },
}));

const { Player } = await import("../src/player/player.tsx");

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  FakeController.instances = [];
  seen.captions = [];
  seen.scrubber = [];
  seen.controls = [];
  const data = new Map<string, string>();
  setP2PStorage(() => ({
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }));
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: fine)" })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  setP2PStorage(null);
});

const features: SessionFeatures = {
  captions: { tracks: [{ language: "en", label: "English", url: "https://play.example/c/en.m3u8" }], state: "active" },
  dvr: { windowSeconds: 1800, playlistUrl: "https://play.example/dvr/v/index.m3u8?t=d" },
};

describe("W2 player slots", () => {
  it("are absent until the session plays, then get the controller and the session's features", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    const c = FakeController.instances[0];
    if (!c) throw new Error("no controller");
    expect(screen.queryByTestId("slot-captions")).toBeNull();
    act(() => {
      c.opts.onFeatures?.(features);
      c.opts.onState("playing");
    });
    expect(screen.getByTestId("slot-captions").getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("player").getAttribute("data-dvr-window")).toBe("1800");
    expect(screen.getByTestId("player").getAttribute("data-captions")).toBe("active");
    expect(screen.getByTestId("slot-dvr-scrubber").getAttribute("data-window")).toBe("1800");
    expect(screen.getByTestId("slot-dvr-controls").getAttribute("data-data-mode")).toBe("false");
    expect(seen.captions.at(-1)?.controller).toBe(c);
    const controls = seen.controls.at(-1);
    expect(controls?.controller).toBe(c);
    expect(controls?.grant).toEqual(features.dvr);
    expect(controls?.playbackMode).toBe("live");
    act(() => c.opts.onState("error"));
    expect(screen.queryByTestId("slot-dvr-controls")).toBeNull();
  });

  it("without a grant the DVR slots still mount with grant null (they hide themselves)", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    const c = FakeController.instances[0];
    if (!c) throw new Error("no controller");
    act(() => c.opts.onState("playing"));
    expect(seen.scrubber.at(-1)?.grant).toBeNull();
    expect(screen.getByTestId("player").getAttribute("data-dvr-window")).toBe("0");
    expect(screen.getByTestId("player").getAttribute("data-captions")).toBe("off");
    expect(seen.captions.at(-1)?.captions).toEqual({ tracks: [], state: "off" });
  });
});
