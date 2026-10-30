// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `player.tsx`'s half of the seam: it registers its controller as the channel's media clock,
 * mirrors the playback mode on `data-playback-mode`, and hands the diagnostic query parameters
 * (`targetLatency`, `rendition`) to the controller. The controller is a fake here.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlayerControllerOptions } from "../src/player/controller.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { playbackMode, playheadWallclock } from "../src/player/media-clock.ts";
import { setP2PStorage } from "../src/player/p2p/preference.ts";

type Mode = "live" | "dvr";

class FakeController {
  static instances: FakeController[] = [];
  mode: Mode = "live";
  playhead: Date | null = null;
  listeners = new Set<(m: Mode) => void>();
  disableP2P = vi.fn<() => void>();
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  playheadWallclock = () => this.playhead;
  playbackMode = () => this.mode;
  onPlaybackMode = (cb: (m: Mode) => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  switchMode(m: Mode) {
    this.mode = m;
    act(() => {
      for (const l of this.listeners) l(m);
    });
  }
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

const { Player } = await import("../src/player/player.tsx");

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const last = () => {
  const c = FakeController.instances.at(-1);
  if (!c) throw new Error("no controller");
  return c;
};

beforeEach(() => {
  FakeController.instances = [];
  const data = new Map<string, string>();
  setP2PStorage(() => ({
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }));
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: fine)" })) as typeof window.matchMedia;
  window.history.replaceState(null, "", "/rivertide");
});

afterEach(() => {
  cleanup();
  setP2PStorage(null);
  window.history.replaceState(null, "", "/");
});

describe("player seam wiring", () => {
  it("registers the controller as the channel's media clock until unmount", async () => {
    const view = wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().playhead = new Date("2026-10-30T12:00:00.000Z");
    expect(playheadWallclock("rivertide")?.toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(playheadWallclock("someone_else")).toBeNull();
    view.unmount();
    expect(playheadWallclock("rivertide")).toBeNull();
  });

  it("data-playback-mode follows onPlaybackMode, and the registry reads the same mode", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    const el = screen.getByTestId("player");
    expect(el.getAttribute("data-playback-mode")).toBe("live");
    last().switchMode("dvr");
    expect(el.getAttribute("data-playback-mode")).toBe("dvr");
    expect(playbackMode("rivertide")).toBe("dvr");
    last().switchMode("live");
    expect(el.getAttribute("data-playback-mode")).toBe("live");
  });

  it("passes ?targetLatency= and ?rendition= to the controller", async () => {
    window.history.replaceState(null, "", "/rivertide?targetLatency=12&rendition=480p");
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(last().opts).toMatchObject({ targetLatency: 12, rendition: "480p" });
  });

  it("ignores invalid diagnostic values", async () => {
    window.history.replaceState(null, "", "/rivertide?targetLatency=99&rendition=4k");
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(last().opts.targetLatency).toBeUndefined();
    expect(last().opts.rendition).toBeUndefined();
  });

  it("offline: no controller, nothing registered", () => {
    wrap(<Player channel="rivertide" live={false} />);
    expect(FakeController.instances).toHaveLength(0);
    expect(playheadWallclock("rivertide")).toBeNull();
  });
});
