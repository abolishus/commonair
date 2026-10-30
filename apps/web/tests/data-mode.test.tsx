// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The data-saver UI (docs/testing/w1-selectors.md "Data mode"): the panel's controls and numbers,
 * and the player's wiring (saved choice → `playback.start`, `setDataMode`, `data-data-mode`, no
 * P2P in data mode). The controller is a fake here; tests/player-data-mode.test.ts covers it.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import type { PlayerControllerOptions, PlayerState } from "../src/player/controller.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { DATA_MODE_STORAGE_KEY, type DataModeChoice } from "../src/player/budget.ts";
import { DataModeNotice, DataModePanel, type DataModePanelProps } from "../src/player/data-mode.tsx";
import { setP2PStorage } from "../src/player/p2p/preference.ts";

const AUDIO = dataModeCeilingBps(50);
const LOW = dataModeCeilingBps(800);

class FakeController {
  static instances: FakeController[] = [];
  disableP2P = vi.fn<() => void>();
  setDataMode = vi.fn<(c: number | null) => void>();
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  usage = { bytes: 1_500_000, mbPerHour: 48.4 };
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  playheadWallclock = () => null;
  playbackMode = () => "live" as const;
  onPlaybackMode = () => () => undefined;
  dataUsage = () => this.usage;
  playableLevels = () => [{ bitrate: 96_000, audioOnly: true }];
  setState(s: PlayerState) {
    act(() => this.opts.onState(s));
  }
  applied(ceiling: number | null) {
    act(() => this.opts.onDataMode?.(ceiling));
  }
}

vi.mock("../src/player/controller.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/controller.ts")>();
  return { ...real, PlayerController: FakeController };
});

vi.mock("../src/player/p2p/use-p2p.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/p2p/use-p2p.ts")>();
  return { ...real, useOperatorP2PDefault: () => "on" };
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
  window.localStorage.clear();
  const data = new Map<string, string>([["commonair:p2p-notice", "seen"]]);
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

function panel(over: Partial<DataModePanelProps> = {}) {
  const onChoice = vi.fn<(c: DataModeChoice) => void>();
  const props: DataModePanelProps = {
    choice: { on: true, mbPerHour: 50 },
    onChoice,
    applied: AUDIO,
    wanted: AUDIO,
    native: false,
    suggested: false,
    levels: [
      { bitrate: 96_000, audioOnly: true },
      { bitrate: 1_296_000, audioOnly: false },
    ],
    usage: { bytes: 2_000_000, mbPerHour: 47.6 },
    dvr: false,
    ...over,
  };
  const view = wrap(<DataModePanel {...props} />);
  return { view, onChoice };
}

describe("DataModePanel", () => {
  it("the toggle's state is an attribute and text, not colour", () => {
    panel();
    const toggle = screen.getByTestId("data-mode-toggle");
    expect(toggle.getAttribute("data-state")).toBe("on");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Limit data use" })).toBe(toggle);
  });

  it("toggling reports the choice with the budget kept", () => {
    const { onChoice } = panel({ choice: { on: false, mbPerHour: 800 } });
    expect(screen.getByTestId("data-mode-toggle").getAttribute("data-state")).toBe("off");
    fireEvent.click(screen.getByTestId("data-mode-toggle"));
    expect(onChoice).toHaveBeenCalledWith({ on: true, mbPerHour: 800 });
  });

  it("the presets and custom, labelled; picking a preset reports it", () => {
    const { onChoice } = panel();
    const group = screen.getByTestId("data-mode-budget");
    for (const id of [
      "data-mode-budget-50",
      "data-mode-budget-800",
      "data-mode-budget-1900",
      "data-mode-budget-custom",
    ])
      expect(within(group).getByTestId(id)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Audio only, about 50 MB an hour" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByTestId("data-mode-budget-1900"));
    expect(onChoice).toHaveBeenCalledWith({ on: true, mbPerHour: 1900 });
  });

  it("custom: a number within the bounds, applied on submit", () => {
    const { onChoice } = panel();
    fireEvent.click(screen.getByTestId("data-mode-budget-custom"));
    const input = screen.getByLabelText("MB an hour");
    fireEvent.change(input, { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this budget" }));
    expect(onChoice).toHaveBeenCalledWith({ on: true, mbPerHour: 300 });
    fireEvent.change(input, { target: { value: "999999" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this budget" }));
    expect(onChoice).toHaveBeenLastCalledWith({ on: true, mbPerHour: 4000 });
  });

  it("a saved custom budget shows as custom", () => {
    panel({ choice: { on: true, mbPerHour: 300 } });
    expect(screen.getByTestId("data-mode-budget-custom").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("MB an hour") as HTMLInputElement).value).toBe("300");
  });

  it("off: the picker is disabled and there is no estimate", () => {
    panel({ choice: { on: false, mbPerHour: 50 } });
    expect(screen.getByTestId("data-mode-budget-50").hasAttribute("data-disabled")).toBe(true);
    expect(screen.queryByTestId("data-mode-estimate")).toBeNull();
  });

  it("the estimate for the level the budget plays, and the meter's numbers as integers", () => {
    panel();
    const estimate = screen.getByTestId("data-mode-estimate");
    expect(estimate.getAttribute("data-mb-per-hour")).toBe("50");
    expect(estimate.textContent).toContain("audio only");
    const usage = screen.getByTestId("data-usage");
    expect(usage.getAttribute("data-bytes")).toBe("2000000");
    expect(usage.getAttribute("data-mb-per-hour")).toBe("48");
  });

  it("over budget when even the audio floor costs more", () => {
    panel({ levels: [{ bitrate: 192_000, audioOnly: true }] });
    expect(screen.getByText(/lowest this stream goes/)).toBeTruthy();
  });

  it("a meter the browser cannot fill says so; no meter before playback", () => {
    panel({ usage: null });
    expect(screen.getByTestId("data-usage").getAttribute("data-unknown")).toBe("true");
    cleanup();
    panel({ usage: undefined });
    expect(screen.queryByTestId("data-usage")).toBeNull();
  });

  it("pending while the token does not carry the wanted ceiling", () => {
    panel({ applied: null, wanted: AUDIO });
    expect(screen.getByText("Applying your budget…").tagName).toBe("OUTPUT");
  });

  it("notices: native reload, DVR (only while on), and the suggestion", () => {
    panel({ native: true, dvr: true });
    const reasons = screen.getAllByTestId("data-mode-notice").map((n) => n.getAttribute("data-reason"));
    expect(reasons).toEqual(["native-reload", "dvr"]);
    cleanup();
    panel({ dvr: true, choice: { on: false, mbPerHour: 50 }, suggested: true });
    expect(screen.queryByTestId("data-mode-notice")).toBeNull();
    expect(screen.getByText(/asked to save data/)).toBeTruthy();
  });

  it("the VOD notice", () => {
    wrap(<DataModeNotice reason="vod" />);
    expect(screen.getByTestId("data-mode-notice").getAttribute("data-reason")).toBe("vod");
  });
});

describe("Player wiring", () => {
  it("a saved choice starts the session in data mode, without P2P; the player shows the applied ceiling", async () => {
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: 50 }));
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(last().opts.dataMode).toBe(AUDIO);
    expect(last().opts.p2pWanted?.(false)).toBe(false);
    const player = screen.getByTestId("player");
    expect(player.getAttribute("data-data-mode")).toBe("");
    last().applied(AUDIO);
    expect(player.getAttribute("data-data-mode")).toBe(String(AUDIO));
  });

  it("nothing saved: off, P2P allowed as before, the default budget selected", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(last().opts.dataMode).toBeNull();
    expect(last().opts.p2pWanted?.(false)).toBe(true);
    expect(screen.getByTestId("data-mode-toggle").getAttribute("data-state")).toBe("off");
    expect(screen.getByTestId("data-mode-budget-800").getAttribute("aria-checked")).toBe("true");
  });

  it("toggling and picking call setDataMode, save the choice, and turn the P2P policy off", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    const c = last();
    fireEvent.click(screen.getByTestId("data-mode-toggle"));
    expect(c.setDataMode).toHaveBeenLastCalledWith(LOW);
    fireEvent.click(screen.getByTestId("data-mode-budget-50"));
    expect(c.setDataMode).toHaveBeenLastCalledWith(AUDIO);
    expect(JSON.parse(window.localStorage.getItem(DATA_MODE_STORAGE_KEY) ?? "")).toEqual({ on: true, mbPerHour: 50 });
    expect(c.opts.p2pWanted?.(false)).toBe(false);
    fireEvent.click(screen.getByTestId("data-mode-toggle"));
    expect(c.setDataMode).toHaveBeenLastCalledWith(null);
    // One session throughout: a change never restarts playback.
    expect(FakeController.instances).toHaveLength(1);
  });

  it("while playing the meter and the estimate come from the controller", async () => {
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: 50 }));
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(screen.queryByTestId("data-usage")).toBeNull();
    last().setState("playing");
    await waitFor(() => expect(screen.getByTestId("data-usage").getAttribute("data-bytes")).toBe("1500000"));
    expect(screen.getByTestId("data-usage").getAttribute("data-mb-per-hour")).toBe("48");
    expect(screen.getByTestId("data-mode-estimate").getAttribute("data-mb-per-hour")).toBe("50");
  });

  it("embeds and offline channels show no panel", async () => {
    wrap(<Player channel="rivertide" live embed />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(screen.queryByTestId("data-mode-toggle")).toBeNull();
    cleanup();
    wrap(<Player channel="rivertide" live={false} />);
    expect(screen.queryByTestId("data-mode-toggle")).toBeNull();
  });

  it("storage that throws: the player still starts, off", async () => {
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(last().opts.dataMode).toBeNull();
    fireEvent.click(screen.getByTestId("data-mode-toggle"));
    expect(last().setDataMode).toHaveBeenLastCalledWith(LOW);
    spy.mockRestore();
  });
});
