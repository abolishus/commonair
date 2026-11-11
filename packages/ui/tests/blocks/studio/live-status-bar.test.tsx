// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-shell: the `LiveStatusBar` block (D5.2). Offline, starting and live each say their state in a
 * word (never colour alone) and in a live region; live adds the uptime, verified viewers and the
 * health word; the slot hides while empty; compact drops the sticky chrome.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { LiveStatusBar, type LiveStatusBarLabels } from "../../../src/blocks/studio/index.ts";

afterEach(() => cleanup());

const labels: LiveStatusBarLabels = {
  region: "Stream status",
  offline: "Offline",
  starting: "Starting",
  live: "Live",
  uptime: "Live for",
  health: "Stream health:",
  healthy: "Healthy",
  warning: "Needs attention",
  unknown: "No health data yet",
};

const bar = () => screen.getByRole("region", { name: "Stream status" });

describe("LiveStatusBar", () => {
  test("offline: the word in a status region, no live numbers, the detail line", () => {
    render(<LiveStatusBar state="offline" labels={labels} viewers={5} health="healthy" detail="Last live" />);
    expect(bar().getAttribute("data-state")).toBe("offline");
    expect(screen.getByRole("status").textContent).toBe("Offline");
    expect(bar().querySelector('[data-slot="live-badge"]')).toBeNull();
    expect(bar().querySelector('[data-slot="live-status-viewers"]')).toBeNull();
    expect(bar().querySelector('[data-slot="live-status-health"]')).toBeNull();
    expect(bar().querySelector('[data-slot="live-status-detail"]')?.textContent).toBe("Last live");
    expect(bar().className).toContain("sticky");
  });

  test("checking: a skeleton badge, an empty live region, no state word or numbers", () => {
    render(
      <LiveStatusBar
        state="checking"
        labels={labels}
        startedAt={new Date().toISOString()}
        viewers={5}
        health="healthy"
      />,
    );
    expect(bar().getAttribute("data-state")).toBe("checking");
    expect(screen.getByRole("status").textContent).toBe("");
    expect(bar().querySelector('[data-slot="live-status-checking"]')).not.toBeNull();
    for (const word of [labels.offline, labels.starting, labels.live]) expect(bar().textContent).not.toContain(word);
    expect(bar().querySelector('[data-slot="live-status-uptime"]')).toBeNull();
    expect(bar().querySelector('[data-slot="live-status-viewers"]')).toBeNull();
    expect(bar().querySelector('[data-slot="live-status-health"]')).toBeNull();
  });

  test("starting: an icon badge and the uptime, no viewers or health yet", () => {
    render(
      <LiveStatusBar
        state="starting"
        labels={labels}
        startedAt={new Date().toISOString()}
        viewers={3}
        health="unknown"
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Starting");
    expect(bar().querySelector('[data-tone="info"] svg')).not.toBeNull();
    expect(bar().querySelector('[data-slot="live-status-uptime"] time')).not.toBeNull();
    expect(bar().querySelector('[data-slot="live-status-viewers"]')).toBeNull();
  });

  test.each([
    ["healthy", "Healthy", "success"],
    ["warning", "Needs attention", "warning"],
    ["unknown", "No health data yet", "neutral"],
  ] as const)("live with %s health: badge, uptime, viewers and the health word", (health, word, tone) => {
    render(
      <LiveStatusBar
        state="live"
        labels={labels}
        startedAt={new Date(Date.now() - 65_000).toISOString()}
        viewers={16}
        health={health}
        detail="Pixel art"
      />,
    );
    expect(bar().querySelector('[data-slot="live-badge"]')?.textContent).toBe("Live");
    expect(bar().querySelector('[data-slot="live-status-uptime"] time')?.getAttribute("datetime")).toMatch(/^P/);
    expect(bar().querySelector('[data-slot="live-status-viewers"]')?.textContent).toContain("16");
    const h = bar().querySelector('[data-slot="live-status-health"]');
    expect(h?.getAttribute("data-health")).toBe(health);
    expect(h?.textContent).toBe(`Stream health: ${word}`);
    expect(h?.querySelector(`[data-tone="${tone}"] svg`)).not.toBeNull();
  });

  test("live without a health value shows no health (the compact home row)", () => {
    render(<LiveStatusBar compact state="live" labels={labels} viewers={1} />);
    expect(bar().querySelector('[data-slot="live-status-health"]')).toBeNull();
    expect(bar().hasAttribute("data-compact")).toBe(true);
    expect(bar().className).not.toContain("sticky");
  });

  test("the slot renders its content, hides while empty, and the actions and notice show", () => {
    const { rerender } = render(<LiveStatusBar state="offline" labels={labels} slotRef={() => undefined} />);
    expect(bar().querySelector('[data-slot="live-status-slot"]')?.className).toContain("empty:hidden");
    rerender(
      <LiveStatusBar
        state="offline"
        labels={labels}
        slot={<button>Copy your channel link</button>}
        actions={<a href="/x">View channel</a>}
        notice="Stream status didn't load."
      />,
    );
    expect(screen.getByRole("button", { name: "Copy your channel link" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View channel" })).toBeTruthy();
    expect(bar().querySelector('[data-slot="live-status-notice"]')?.textContent).toContain("didn't load");
  });

  test("no slot element at all without slot or slotRef", () => {
    render(<LiveStatusBar state="offline" labels={labels} />);
    expect(bar().querySelector('[data-slot="live-status-slot"]')).toBeNull();
  });
});
