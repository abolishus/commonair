// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PlayerChrome behaviour: the in-player settings menu (open, outside press, Escape, focus return,
 * controlled mode, hint), the volume control, the control bar's visibility modes, ref forwarding
 * and the fullscreen flag (standard and WebKit-prefixed).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Settings01Icon, VolumeHighIcon, VolumeMute01Icon } from "@hugeicons/core-free-icons";
import {
  PlayerChrome,
  PlayerScrubber,
  type PlayerSettingsProps,
  type PlayerVolumeProps,
} from "../../src/blocks/media/player-chrome.tsx";

afterEach(() => {
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "webkitFullscreenElement");
});

function settings(over: Partial<PlayerSettingsProps> = {}): PlayerSettingsProps {
  return {
    label: "Settings",
    icon: Settings01Icon,
    closeLabel: "Close settings",
    triggerProps: { "data-testid": "gear" },
    contentProps: { "data-testid": "panel" },
    children: <button type="button">Quality</button>,
    ...over,
  };
}

function volume(over: Partial<PlayerVolumeProps> = {}): PlayerVolumeProps {
  return {
    muted: false,
    level: 0.4,
    onToggleMute: vi.fn<() => void>(),
    onLevelChange: vi.fn<(level: number) => void>(),
    muteLabel: "Mute",
    unmuteLabel: "Unmute",
    sliderLabel: "Volume",
    valueText: "40%",
    muteIcon: VolumeHighIcon,
    unmuteIcon: VolumeMute01Icon,
    shortcut: "M",
    ...over,
  };
}

function chrome(props: Partial<React.ComponentProps<typeof PlayerChrome>> = {}) {
  return (
    <PlayerChrome variant="vod" {...props}>
      <div data-testid="picture" />
    </PlayerChrome>
  );
}

const gear = () => screen.getByTestId("gear");
const panel = () => screen.getByTestId("panel");

describe("PlayerChrome settings menu", () => {
  test("the gear opens the panel inside the player and focuses it", async () => {
    const user = userEvent.setup();
    render(chrome({ settings: settings({ badge: <span data-testid="badge">Saver</span> }) }));
    expect(panel().hidden).toBe(true);
    expect(gear().getAttribute("aria-expanded")).toBe("false");
    expect(gear().getAttribute("aria-controls")).toBe(panel().id);
    expect(screen.getByTestId("badge")).toBeTruthy();
    await user.click(gear());
    expect(panel().hidden).toBe(false);
    expect(gear().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(panel());
    // Named by its heading, and inside the chrome (so it shows in fullscreen).
    expect(screen.getByRole("region", { name: "Settings" })).toBe(panel());
    expect(document.querySelector('[data-slot="player-chrome"]')!.contains(panel())).toBe(true);
    await user.click(gear());
    expect(panel().hidden).toBe(true);
  });

  test("a press outside closes it; presses inside the panel or on the gear do not", async () => {
    const user = userEvent.setup();
    render(
      <>
        {chrome({ settings: settings() })}
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(gear());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Quality" }));
    fireEvent.pointerDown(gear());
    expect(panel().hidden).toBe(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(panel().hidden).toBe(true);
  });

  test("Escape in the panel closes it and returns focus to the gear", async () => {
    const user = userEvent.setup();
    render(chrome({ settings: settings() }));
    await user.click(gear());
    screen.getByRole("button", { name: "Quality" }).focus();
    await user.keyboard("{Escape}");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(gear());
  });

  test("Escape elsewhere, other keys, and an already handled Escape leave it open", async () => {
    const user = userEvent.setup();
    render(
      <>
        {chrome({ settings: settings() })}
        <input aria-label="Chat" />
      </>,
    );
    await user.click(gear());
    fireEvent.keyDown(panel(), { key: "Enter" });
    expect(panel().hidden).toBe(false);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Chat" }), { key: "Escape" });
    expect(panel().hidden).toBe(false);
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => void panel().dispatchEvent(handled));
    expect(panel().hidden).toBe(false);
    fireEvent.keyDown(gear(), { key: "Escape" });
    expect(panel().hidden).toBe(true);
  });

  test("the close button closes it and returns focus to the gear", async () => {
    const user = userEvent.setup();
    render(chrome({ settings: settings() }));
    await user.click(gear());
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(gear());
  });

  test("controlled: open comes from the caller and changes are reported", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const { rerender } = render(chrome({ settings: settings({ open: true, onOpenChange }) }));
    expect(panel().hidden).toBe(false);
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    // Still open until the caller says otherwise.
    expect(panel().hidden).toBe(false);
    rerender(chrome({ settings: settings({ open: false, onOpenChange }) }));
    expect(panel().hidden).toBe(true);
    await user.click(gear());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  test("the hint shows beside the gear only while the menu is closed", async () => {
    const user = userEvent.setup();
    const hint = { open: true, children: "Try data saver", props: { "data-testid": "hint" } };
    const { rerender } = render(chrome({ settings: settings({ hint }) }));
    expect(screen.getByTestId("hint").textContent).toBe("Try data saver");
    expect(screen.getByTestId("hint").getAttribute("data-slot")).toBe("player-hint");
    await user.click(gear());
    expect(screen.queryByTestId("hint")).toBeNull();
    rerender(chrome({ settings: settings({ hint: { ...hint, open: false }, open: false }) }));
    expect(screen.queryByTestId("hint")).toBeNull();
  });

  test("the panel stays mounted while closed, so its state survives", async () => {
    const user = userEvent.setup();
    render(chrome({ settings: settings({ children: <input aria-label="Budget" /> }) }));
    await user.click(gear());
    await user.type(screen.getByRole("textbox", { name: "Budget" }), "250");
    await user.click(gear());
    await user.click(gear());
    expect((screen.getByRole("textbox", { name: "Budget" }) as HTMLInputElement).value).toBe("250");
  });
});

describe("PlayerChrome volume", () => {
  test("the mute button names its action and toggles", async () => {
    const user = userEvent.setup();
    const v = volume();
    const { rerender } = render(chrome({ volume: v }));
    const mute = screen.getByTestId("player-mute");
    expect(mute.getAttribute("aria-label")).toBe("Mute");
    expect(mute.getAttribute("aria-keyshortcuts")).toBe("M");
    expect(mute.hasAttribute("aria-pressed")).toBe(false);
    await user.click(mute);
    expect(v.onToggleMute).toHaveBeenCalledTimes(1);
    rerender(chrome({ volume: { ...v, muted: true } }));
    expect(screen.getByTestId("player-mute").getAttribute("aria-label")).toBe("Unmute");
  });

  test("the slider shows the level as a percentage, 0 while muted, clamped to 0..100", () => {
    const v = volume();
    const { rerender } = render(chrome({ volume: v }));
    const slider = () => screen.getByLabelText("Volume", { selector: "input" });
    expect(slider().getAttribute("aria-valuenow")).toBe("40");
    expect(slider().getAttribute("aria-valuetext")).toBe("40%");
    rerender(chrome({ volume: { ...v, muted: true } }));
    expect(slider().getAttribute("aria-valuenow")).toBe("0");
    rerender(chrome({ volume: { ...v, level: 1.7 } }));
    expect(slider().getAttribute("aria-valuenow")).toBe("100");
    rerender(chrome({ volume: { ...v, level: -0.3 } }));
    expect(slider().getAttribute("aria-valuenow")).toBe("0");
  });

  test("moving the slider reports a 0..1 level in steps of 5%", () => {
    const v = volume();
    render(chrome({ volume: v }));
    const slider = screen.getByLabelText("Volume", { selector: "input" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(v.onLevelChange).toHaveBeenLastCalledWith(0.45);
    fireEvent.keyDown(slider, { key: "End" });
    expect(v.onLevelChange).toHaveBeenLastCalledWith(1);
  });
});

describe("PlayerChrome control bar", () => {
  const bar = () => document.querySelector<HTMLElement>('[data-slot="player-controls"]')!;

  test("uncontrolled: no data-visible, shown on hover and focus by CSS", () => {
    render(chrome());
    expect(bar().hasAttribute("data-visible")).toBe(false);
    expect(bar().className).toContain("group-hover/player:opacity-100");
  });

  test("controlled: visible or hidden, with keyboard focus still revealing a hidden bar", () => {
    const { rerender } = render(chrome({ controlsVisible: true, controlsProps: { className: "extra" } }));
    expect(bar().getAttribute("data-visible")).toBe("true");
    expect(bar().className).toContain("opacity-100");
    expect(bar().className).toContain("extra");
    rerender(chrome({ controlsVisible: false }));
    expect(bar().getAttribute("data-visible")).toBe("false");
    expect(bar().className).toContain("pointer-events-none");
    expect(bar().className).toContain("has-focus-visible:opacity-100");
    expect(bar().className).toContain("motion-reduce:opacity-100");
  });

  test("forwards controlsProps (test ids, handlers) to the bar", () => {
    const onPointerMove = vi.fn<() => void>();
    render(chrome({ controlsProps: { "data-testid": "bar", onPointerMove } }));
    fireEvent.pointerMove(screen.getByTestId("bar"));
    expect(onPointerMove).toHaveBeenCalledTimes(1);
  });

  test("the time label sits at the far end unless settings or end controls take it", () => {
    const { rerender } = render(chrome({ timeLabel: "1:02 / 3:04" }));
    expect(screen.getByText("1:02 / 3:04").className).toContain("ms-auto");
    rerender(chrome({ timeLabel: "1:02 / 3:04", controlsEnd: <button type="button">Fullscreen</button> }));
    expect(screen.getByText("1:02 / 3:04").className).not.toContain("ms-auto");
    expect(screen.getByRole("button", { name: "Fullscreen" }).parentElement!.className).toContain("ms-auto");
  });

  test("live variant shows the live badge and viewers; vod shows neither; a stage covers the picture", () => {
    const { rerender } = render(
      chrome({
        variant: "live",
        liveLabel: "On air",
        liveBadgeProps: { "data-testid": "live" },
        viewerCount: 1200,
        topStart: <span>Start</span>,
        topEnd: <span>End</span>,
      }),
    );
    expect(screen.getByTestId("live").textContent).toContain("On air");
    expect(screen.getByText(/1,200/)).toBeTruthy();
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByText("End")).toBeTruthy();
    rerender(chrome({ stage: <p>Starting soon</p>, scrubber: <div data-testid="scrubber" /> }));
    expect(screen.queryByTestId("live")).toBeNull();
    expect(screen.queryByText(/1,200/)).toBeNull();
    expect(screen.getByText("Starting soon")).toBeTruthy();
    expect(screen.getByTestId("scrubber")).toBeTruthy();
  });

  test("controls render in the bar", () => {
    render(chrome({ controls: <button type="button">Play</button> }));
    expect(bar().contains(screen.getByRole("button", { name: "Play" }))).toBe(true);
  });
});

describe("PlayerChrome ref and fullscreen", () => {
  test("forwards its section to a function ref and an object ref", () => {
    const fn = vi.fn<(el: HTMLElement | null) => void>();
    const { unmount } = render(chrome({ ref: fn }));
    const section = document.querySelector('[data-slot="player-chrome"]');
    expect(fn).toHaveBeenCalledWith(section);
    unmount();
    expect(fn).toHaveBeenLastCalledWith(null);
    const obj = React.createRef<HTMLElement>();
    render(chrome({ ref: obj as React.Ref<HTMLElement> as never }));
    expect(obj.current).toBe(document.querySelector('[data-slot="player-chrome"]'));
  });

  test("follows the WebKit-prefixed fullscreen element too", () => {
    render(chrome());
    const section = document.querySelector<HTMLElement>('[data-slot="player-chrome"]')!;
    expect(section.hasAttribute("data-fullscreen")).toBe(false);
    Object.defineProperty(document, "webkitFullscreenElement", { configurable: true, value: section });
    act(() => void document.dispatchEvent(new Event("webkitfullscreenchange")));
    expect(section.hasAttribute("data-fullscreen")).toBe(true);
    Object.defineProperty(document, "webkitFullscreenElement", { configurable: true, value: null });
    act(() => void document.dispatchEvent(new Event("webkitfullscreenchange")));
    expect(section.hasAttribute("data-fullscreen")).toBe(false);
  });

  test("another element in fullscreen does not mark this player", () => {
    render(chrome());
    const other = document.createElement("div");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: other });
    act(() => void document.dispatchEvent(new Event("fullscreenchange")));
    expect(document.querySelector('[data-slot="player-chrome"]')!.hasAttribute("data-fullscreen")).toBe(false);
  });
});

describe("PlayerScrubber", () => {
  test("names the slider and reads its value text", () => {
    const onValueChange = vi.fn<(value: number | readonly number[]) => void>();
    render(<PlayerScrubber value={30} max={120} label="Seek" valueText="0:30 of 2:00" onValueChange={onValueChange} />);
    const slider = screen.getByLabelText("Seek", { selector: "input" });
    expect(slider.getAttribute("aria-valuetext")).toBe("0:30 of 2:00");
    expect(slider.getAttribute("max")).toBe("120");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenCalled();
  });
});
