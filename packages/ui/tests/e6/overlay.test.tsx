// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The OBS overlay: the alert queue's de-dup and timing (fake timers) and the view's DOM contract. */
import * as React from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  OverlayAlertsView,
  useAlertQueue,
  useReducedMotion,
  type OverlayAlertItem,
} from "../../src/blocks/overlay/index.ts";

const alert = (id: string, durationMs = 5000, extra: Partial<OverlayAlertItem> = {}): OverlayAlertItem => ({
  id,
  type: "tip",
  text: `alert ${id}`,
  message: null,
  amountCents: 250,
  durationMs,
  animation: "fade",
  test: false,
  ...extra,
});

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("useAlertQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows one alert at a time, each for its own duration, in arrival order", () => {
    const { result } = renderHook(() => useAlertQueue());
    expect(result.current.current).toBeNull();
    act(() => {
      result.current.enqueue(alert("a", 5000));
      result.current.enqueue(alert("b", 2000));
      result.current.enqueue(alert("c", 1000));
    });
    expect(result.current.current?.id).toBe("a");
    expect(result.current.pending).toBe(2);
    tick(4999);
    expect(result.current.current?.id).toBe("a");
    tick(1);
    expect(result.current.current?.id).toBe("b");
    tick(2000);
    expect(result.current.current?.id).toBe("c");
    tick(1000);
    expect(result.current.current).toBeNull();
    expect(result.current.pending).toBe(0);
  });

  test("de-duplicates by id: on screen, queued and already shown", () => {
    const { result } = renderHook(() => useAlertQueue());
    let accepted: boolean[] = [];
    act(() => {
      accepted = [
        result.current.enqueue(alert("a", 1000)),
        result.current.enqueue(alert("a", 1000)),
        result.current.enqueue(alert("b", 1000)),
        result.current.enqueue(alert("b", 1000)),
      ];
    });
    expect(accepted).toEqual([true, false, true, false]);
    expect(result.current.pending).toBe(1);
    tick(1000);
    expect(result.current.current?.id).toBe("b");
    tick(1000);
    expect(result.current.current).toBeNull();
    // A replay after a reconnect does not show it again.
    act(() => {
      expect(result.current.enqueue(alert("a"))).toBe(false);
    });
    expect(result.current.current).toBeNull();
  });

  test("an alert arriving after the queue drained shows at once", () => {
    const { result } = renderHook(() => useAlertQueue());
    act(() => {
      result.current.enqueue(alert("a", 1000));
    });
    tick(1000);
    act(() => {
      result.current.enqueue(alert("b", 1000));
    });
    expect(result.current.current?.id).toBe("b");
  });

  test("remembers only the last `remember` ids", () => {
    const { result } = renderHook(() => useAlertQueue({ remember: 2 }));
    act(() => {
      result.current.enqueue(alert("a", 10));
      result.current.enqueue(alert("b", 10));
      result.current.enqueue(alert("c", 10));
    });
    tick(30);
    act(() => {
      expect(result.current.enqueue(alert("c", 10))).toBe(false);
      expect(result.current.enqueue(alert("a", 10))).toBe(true);
    });
  });

  test("clear drops the alert on screen and the queue, and no timer fires afterwards", () => {
    const { result } = renderHook(() => useAlertQueue());
    act(() => {
      result.current.enqueue(alert("a", 1000));
      result.current.enqueue(alert("b", 1000));
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.current).toBeNull();
    expect(result.current.pending).toBe(0);
    tick(5000);
    expect(result.current.current).toBeNull();
  });
});

describe("useReducedMotion", () => {
  test("follows the media query", () => {
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("reduce"),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
    spy.mockRestore();
  });
});

describe("OverlayAlertsView", () => {
  test("root state and the alert's data attributes", () => {
    render(
      <OverlayAlertsView
        state="live"
        reducedMotion={false}
        alert={alert("x1", 5000, { message: "nice", animation: "slide", test: true })}
      />,
    );
    const root = screen.getByTestId("overlay-alerts");
    expect(root.getAttribute("data-state")).toBe("live");
    expect(root.className).toContain("bg-transparent");
    const shown = screen.getByTestId("overlay-alert");
    expect(shown.getAttribute("data-alert-id")).toBe("x1");
    expect(shown.getAttribute("data-type")).toBe("tip");
    expect(shown.getAttribute("data-test")).toBe("true");
    expect(shown.getAttribute("data-amount-cents")).toBe("250");
    expect(shown.getAttribute("data-animation")).toBe("slide");
    expect(shown.className).toContain("slide-in-from-bottom");
    expect(screen.getByTestId("overlay-alert-text").textContent).toBe("alert x1");
    expect(screen.getByTestId("overlay-alert-message").textContent).toBe("nice");
  });

  test("no amount and no message", () => {
    render(<OverlayAlertsView state="live" alert={alert("f", 1000, { type: "follow", amountCents: null })} />);
    expect(screen.getByTestId("overlay-alert").getAttribute("data-amount-cents")).toBe("");
    expect(screen.queryByTestId("overlay-alert-message")).toBeNull();
  });

  test("reduced motion forces no animation", () => {
    render(<OverlayAlertsView state="live" reducedMotion alert={alert("r", 1000, { animation: "slide" })} />);
    const shown = screen.getByTestId("overlay-alert");
    expect(shown.getAttribute("data-animation")).toBe("none");
    expect(shown.className).not.toContain("animate-in");
  });

  test.each(["connecting", "refused"] as const)("%s shows nothing, even with an alert", (state) => {
    render(<OverlayAlertsView state={state} alert={alert("z")} />);
    expect(screen.getByTestId("overlay-alerts").getAttribute("data-state")).toBe(state);
    expect(screen.queryByTestId("overlay-alert")).toBeNull();
    expect(screen.getByTestId("overlay-alerts").textContent).toBe("");
  });

  test("the queue drives the view end to end", () => {
    vi.useFakeTimers();
    function Overlay(): React.JSX.Element {
      const queue = useAlertQueue();
      const { enqueue } = queue;
      React.useEffect(() => {
        enqueue(alert("one", 1000));
        enqueue(alert("two", 1000));
      }, [enqueue]);
      return <OverlayAlertsView state="live" alert={queue.current} reducedMotion />;
    }
    render(<Overlay />);
    expect(screen.getByTestId("overlay-alert").getAttribute("data-alert-id")).toBe("one");
    tick(1000);
    expect(screen.getByTestId("overlay-alert").getAttribute("data-alert-id")).toBe("two");
    tick(1000);
    expect(screen.queryByTestId("overlay-alert")).toBeNull();
    vi.useRealTimers();
  });
});
