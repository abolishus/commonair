// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The player's P2P surface (docs/testing/p1-selectors.md): `data-p2p`, the indicator, the
 * first-run notice, the dialog and its switch, and the settings section following it. The
 * controller is a fake here (its P2P logic is tested in p2p-engine.test.ts), except where the
 * real one runs against a fake hls.js to show `enabled: false` never reads as sharing.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { P2PStatus, PlayerControllerOptions } from "../src/player/controller.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { setP2PStorage } from "../src/player/p2p/preference.ts";
import { p2pDefaultOf } from "../src/player/p2p/use-p2p.ts";
import { FakeHls, fakeApi, playbackStart, type FakeApi } from "./p2p-fakes.ts";

const mode = vi.hoisted(() => ({ real: false, operatorDefault: "off" as "off" | "on", api: null as unknown }));

class FakeController {
  static instances: FakeController[] = [];
  disableP2P = vi.fn<() => void>();
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  /** Whether the notice was on screen when this session was created. */
  noticeOnScreen = document.querySelector('[data-testid="player-p2p-notice"]') !== null;
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  /** What the server answered and the loader did, as the real controller would report it. */
  report(status: Partial<P2PStatus>) {
    act(() => {
      this.opts.onState("playing");
      this.opts.onP2P?.({ available: true, state: "off", peers: 0, uploadedBytes: 0, receivedBytes: 0, ...status });
    });
  }
}

vi.mock("hls.js", () => ({ default: FakeHls }));

vi.mock("../src/player/controller.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/controller.ts")>();
  class Switching {
    constructor(opts: PlayerControllerOptions) {
      // A constructor may return another object: the real controller or the fake.
      return mode.real ? new real.PlayerController(opts) : new FakeController(opts);
    }
  }
  return { ...real, PlayerController: Switching };
});

vi.mock("../src/player/p2p/use-p2p.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/p2p/use-p2p.ts")>();
  return { ...real, useOperatorP2PDefault: () => mode.operatorDefault };
});

vi.mock("../src/lib/api.ts", () => ({
  api: () =>
    mode.api ?? {
      legal: {
        current: async () => [
          {
            id: "0192f000-0000-7000-8000-00000000000a",
            kind: "privacy",
            title: "Privacy policy",
            version: "1",
            body: "We keep little.",
            isDraft: false,
            requiresAcceptance: true,
          },
        ],
      },
    },
  apiKeepalive: () => mode.api ?? {},
}));

const { Player } = await import("../src/player/player.tsx");
const { P2PSettingsSection } = await import("../src/player/p2p/p2p-ui.tsx");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

let store = memoryStorage();

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const byId = (id: string) => screen.queryByTestId(id);
const player = () => screen.getByTestId("player");
const last = () => {
  const c = FakeController.instances.at(-1);
  if (!c) throw new Error("no controller");
  return c;
};

function finePointer(fine: boolean) {
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: fine)" && fine })) as typeof window.matchMedia;
}

beforeEach(() => {
  FakeController.instances = [];
  FakeHls.instances = [];
  mode.real = false;
  mode.api = null;
  mode.operatorDefault = "off";
  store = memoryStorage();
  setP2PStorage(() => store);
  finePointer(true);
});

afterEach(() => {
  cleanup();
  setP2PStorage(null);
});

describe("operator default off (the shipped default), no preference", () => {
  it("no notice, data-p2p off, no P2P asked for, but the indicator offers the switch", async () => {
    wrap(<Player channel="rivertide" live embed />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(byId("player-p2p-notice")).toBeNull();
    expect(player().getAttribute("data-p2p")).toBe("off");
    expect(last().opts.p2pWanted?.(false)).toBe(false);
    last().report({ available: true, state: "off" });
    expect(player().getAttribute("data-p2p")).toBe("off");
    const indicator = byId("player-p2p");
    expect(indicator?.getAttribute("aria-label")).toBe(t("p2p.indicator.off"));
    fireEvent.click(indicator as HTMLElement);
    await waitFor(() => expect(byId("player-p2p-dialog")).not.toBeNull());
    expect(byId("player-p2p-toggle")?.getAttribute("aria-checked")).toBe("false");
  });

  it("no indicator when the server says P2P is not available (gated, native, disabled)", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().report({ available: false, state: "off" });
    expect(screen.getByTestId("player").getAttribute("data-state")).toBe("playing");
    expect(byId("player-p2p")).toBeNull();
    expect(byId("player-p2p-dialog")).toBeNull();
  });

  it("an opted-in viewer (as the harness sets it up) asks for P2P without any notice", async () => {
    store = memoryStorage({ "commonair:p2p": "on", "commonair:p2p-notice": "seen" });
    setP2PStorage(() => store);
    finePointer(false);
    wrap(<Player channel="rivertide" live embed />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(byId("player-p2p-notice")).toBeNull();
    expect(last().opts.p2pWanted?.(false)).toBe(true);
    // Native HLS never asks.
    expect(last().opts.p2pWanted?.(true)).toBe(false);
  });
});

describe("operator default on", () => {
  beforeEach(() => {
    mode.operatorDefault = "on";
  });

  it("shows the notice first; the session (and P2P) starts only once it is on screen", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(byId("player-p2p-notice")?.textContent).toContain(t("p2p.notice.text"));
    expect(byId("player-p2p-notice")?.textContent).toContain("shows them your IP address");
    expect(last().noticeOnScreen).toBe(true);
    expect(last().opts.p2pWanted?.(false)).toBe(true);
  });

  it("dismissing marks the disclosure seen, and the notice never shows again", async () => {
    const first = wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(byId("player-p2p-notice")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: t("p2p.notice.dismiss") }));
    expect(store.data.get("commonair:p2p-notice")).toBe("seen");
    expect(store.data.has("commonair:p2p")).toBe(false);
    expect(byId("player-p2p-notice")).toBeNull();
    first.unmount();
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(2));
    expect(byId("player-p2p-notice")).toBeNull();
    expect(last().opts.p2pWanted?.(false)).toBe(true);
  });

  it("the notice's off switch stores off and stops P2P in the running session", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().report({ state: "on" });
    fireEvent.click(screen.getByRole("button", { name: t("p2p.notice.turnOff") }));
    expect(store.data.get("commonair:p2p")).toBe("off");
    expect(last().disableP2P).toHaveBeenCalled();
    expect(byId("player-p2p-notice")).toBeNull();
  });

  it("touch-primary devices get no notice and no P2P by default", async () => {
    finePointer(false);
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(byId("player-p2p-notice")).toBeNull();
    expect(last().opts.p2pWanted?.(false)).toBe(false);
  });

  it("no notice while the channel is offline", async () => {
    wrap(<Player channel="rivertide" live={false} />);
    await act(async () => undefined);
    expect(byId("player-p2p-notice")).toBeNull();
  });
});

describe("data-p2p and the indicator", () => {
  it.each([
    ["off", t("p2p.indicator.off")],
    ["on", t("p2p.indicator.on")],
  ] as const)("%s", async (state, label) => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().report({ state });
    expect(player().getAttribute("data-p2p")).toBe(state);
    expect(byId("player-p2p")?.getAttribute("aria-label")).toBe(label);
  });

  it("sharing shows peers and bytes shared", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().report({ state: "sharing", peers: 3, uploadedBytes: 1_500_000 });
    expect(player().getAttribute("data-p2p")).toBe("sharing");
    const label = byId("player-p2p")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("3");
    expect(label).toContain("1.5");
  });

  it("goes back to off when the session ends", async () => {
    const view = wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().report({ state: "sharing", peers: 1 });
    view.rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <Player channel="rivertide" live={false} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(player().getAttribute("data-p2p")).toBe("off");
  });
});

describe("the dialog", () => {
  async function openDialog(status: Partial<P2PStatus>) {
    wrap(
      <>
        <Player channel="rivertide" live />
        <P2PSettingsSection />
      </>,
    );
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    last().report(status);
    fireEvent.click(byId("player-p2p") as HTMLElement);
    await waitFor(() => expect(byId("player-p2p-dialog")).not.toBeNull());
    return byId("player-p2p-dialog") as HTMLElement;
  }

  it("says what P2P does, that it is off unless turned on, the IP disclosure, gated streams, per device, the policy", async () => {
    const dialog = await openDialog({ state: "off" });
    const text = dialog.textContent ?? "";
    for (const key of [
      "p2p.dialog.title",
      "p2p.dialog.what",
      "p2p.dialog.default",
      "p2p.disclosure",
      "p2p.dialog.gated",
      "p2p.dialog.perDevice",
    ] as const)
      expect(text).toContain(t(key));
    await waitFor(() => expect(dialog.textContent).toContain("Privacy policy"));
    expect(byId("player-p2p-toggle")?.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("toggling on persists on, marks the disclosure seen and says it applies from the next start", async () => {
    await openDialog({ state: "off" });
    fireEvent.click(byId("player-p2p-toggle") as HTMLElement);
    expect(Object.fromEntries(store.data)).toEqual({ "commonair:p2p": "on", "commonair:p2p-notice": "seen" });
    await waitFor(() => expect(byId("player-p2p-toggle")?.getAttribute("aria-checked")).toBe("true"));
    expect(byId("player-p2p-dialog-note")?.textContent).toBe(t("p2p.dialog.nextStart"));
    // Never a silent restart of this session.
    expect(FakeController.instances).toHaveLength(1);
    expect(last().stop).not.toHaveBeenCalled();
    // The settings section follows the toggle made in the player.
    expect(byId("privacy-p2p-toggle")?.getAttribute("aria-checked")).toBe("true");
  });

  it("toggling off persists off and stops the loader at once; the settings section follows", async () => {
    store = memoryStorage({ "commonair:p2p": "on", "commonair:p2p-notice": "seen" });
    setP2PStorage(() => store);
    await openDialog({ state: "sharing", peers: 2 });
    expect(byId("player-p2p-toggle")?.getAttribute("aria-checked")).toBe("true");
    expect(byId("privacy-p2p-toggle")?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(byId("player-p2p-toggle") as HTMLElement);
    expect(store.data.get("commonair:p2p")).toBe("off");
    expect(last().disableP2P).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(byId("privacy-p2p-toggle")?.getAttribute("aria-checked")).toBe("false"));
    expect(byId("player-p2p-toggle")?.getAttribute("aria-checked")).toBe("false");
    expect(FakeController.instances).toHaveLength(1);
  });
});

describe("the settings section", () => {
  it("states the disclosure next to the switch, per device, and stores the choice", async () => {
    wrap(<P2PSettingsSection />);
    const toggle = await screen.findByTestId("privacy-p2p-toggle");
    expect(document.body.textContent).toContain(t("p2p.disclosure"));
    expect(document.body.textContent).toContain(t("p2p.settings.perDevice"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(store.data.get("commonair:p2p")).toBe("on");
    expect(store.data.get("commonair:p2p-notice")).toBe("seen");
  });
});

describe("with the real controller", () => {
  let f: FakeApi;
  beforeEach(() => {
    mode.real = true;
  });

  it("nothing renders as sharing when the server said enabled: false, and no RTCPeerConnection is made", async () => {
    store = memoryStorage({ "commonair:p2p": "on", "commonair:p2p-notice": "seen" });
    setP2PStorage(() => store);
    const rtc = vi.fn<() => void>();
    vi.stubGlobal("RTCPeerConnection", rtc);
    f = fakeApi(playbackStart({ enabled: false, available: true }));
    mode.api = f.api;
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(f.start).toHaveBeenCalled());
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ p2pCapable: true });
    await waitFor(() => expect(FakeHls.instances).toHaveLength(1));
    expect(player().getAttribute("data-p2p")).toBe("off");
    expect(f.iceServers).not.toHaveBeenCalled();
    expect(rtc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a default viewer asks for nothing and stays off", async () => {
    f = fakeApi(playbackStart({ enabled: false, available: true, trackerUrls: [] }));
    mode.api = f.api;
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(f.start).toHaveBeenCalled());
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ p2pCapable: false });
    expect(player().getAttribute("data-p2p")).toBe("off");
  });
});

describe("p2pDefaultOf", () => {
  it("reads the bootstrap's operator default, off when missing", () => {
    expect(p2pDefaultOf({ instance: { p2pDefault: "on" } })).toBe("on");
    expect(p2pDefaultOf({ instance: { features: { p2pDefault: "on" } } })).toBe("on");
    expect(p2pDefaultOf({ instance: { name: "x" } })).toBe("off");
    expect(p2pDefaultOf({ instance: { p2pDefault: "yes" } })).toBe("off");
    expect(p2pDefaultOf(undefined)).toBe("off");
  });
});
