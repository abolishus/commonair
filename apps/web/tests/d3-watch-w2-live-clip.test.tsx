// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 2, d3-watch (D3.7): the live player's bar carries the viewer Clip button while the
 * stream plays, when the page passes `clip`; never in the embed, never offline. The embed's top
 * corners (`topStart`/`topEnd`) reach the chrome.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlayerControllerOptions } from "../src/player/controller.ts";
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
vi.mock("../src/lib/api.ts", () => ({ api: () => ({}), apiKeepalive: () => ({}), errorCode: () => null }));

const { Player } = await import("../src/player/player.tsx");

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

beforeEach(() => {
  FakeController.instances = [];
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

async function play() {
  await waitFor(() => expect(FakeController.instances).toHaveLength(1));
  const c = FakeController.instances[0];
  if (!c) throw new Error("no controller");
  act(() => c.opts.onState("playing"));
  return c;
}

describe("the live Clip button", () => {
  it("shows in the bar while playing, signed in or not", async () => {
    wrap(<Player channel="rivertide" live clip={{ signedIn: true }} />);
    expect(screen.queryByTestId("clip-button")).toBeNull();
    await play();
    expect(screen.getByTestId("clip-button").getAttribute("data-signed-in")).toBe("true");
    expect(screen.getByTestId("player-controls").contains(screen.getByTestId("clip-button"))).toBe(true);
  });

  it("signed out, it is the trigger of the sign-up prompt (intent clip)", async () => {
    wrap(<Player channel="rivertide" live clip={{ signedIn: false }} />);
    await play();
    const button = screen.getByTestId("clip-button");
    expect([button.tagName, button.getAttribute("data-signed-in")]).toEqual(["BUTTON", "false"]);
    expect(button.getAttribute("data-auth-gate")).toBe("clip");
  });

  it("never in the embed, and not without the page asking for it", async () => {
    wrap(<Player channel="rivertide" live embed clip={{ signedIn: true }} />);
    await play();
    expect(screen.queryByTestId("clip-button")).toBeNull();
    cleanup();
    FakeController.instances = [];
    wrap(<Player channel="rivertide" live />);
    await play();
    expect(screen.queryByTestId("clip-button")).toBeNull();
  });

  it("the top corners carry the embed's identity", () => {
    wrap(
      <Player
        channel="rivertide"
        live={false}
        topStart={<span data-testid="top-start" />}
        topEnd={<span data-testid="top-end" />}
      />,
    );
    expect(screen.getByTestId("top-start")).toBeTruthy();
    expect(screen.getByTestId("top-end")).toBeTruthy();
  });
});
