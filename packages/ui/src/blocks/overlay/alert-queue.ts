// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/** What the overlay shows of one `OverlayAlert` (the contract entity; extra fields are ignored). */
export interface OverlayAlertItem {
  id: string;
  /** `ALERT_TYPES` value. */
  type: string;
  text: string;
  message: string | null;
  amountCents: number | null;
  durationMs: number;
  animation: "fade" | "slide" | "none";
  test: boolean;
}

export interface AlertQueue {
  /** The alert on screen, or `null`. */
  current: OverlayAlertItem | null;
  /** Alerts waiting behind `current`. */
  pending: number;
  /** Adds an alert; `false` when its id was already seen (shown, showing or queued). */
  enqueue: (alert: OverlayAlertItem) => boolean;
  /** Drops the alert on screen and everything queued (the token was refused). */
  clear: () => void;
}

export interface AlertQueueOptions {
  /** How many recent ids are remembered for de-duplication (a reconnect may replay a few). */
  remember?: number;
}

interface QueueState {
  current: OverlayAlertItem | null;
  queue: readonly OverlayAlertItem[];
}

type QueueAction = { kind: "push"; alert: OverlayAlertItem } | { kind: "next" } | { kind: "clear" };

function reduce(state: QueueState, action: QueueAction): QueueState {
  switch (action.kind) {
    case "push":
      return state.current === null
        ? { current: action.alert, queue: state.queue }
        : { current: state.current, queue: [...state.queue, action.alert] };
    case "next": {
      const [head = null, ...rest] = state.queue;
      return { current: head, queue: rest };
    }
    case "clear":
      return { current: null, queue: [] };
  }
}

/**
 * The overlay's alert queue: one alert at a time, each for its own `durationMs`, in arrival
 * order, de-duplicated by id across the page's lifetime (bounded to the last `remember` ids).
 */
export function useAlertQueue({ remember = 500 }: AlertQueueOptions = {}): AlertQueue {
  const [state, dispatch] = React.useReducer(reduce, { current: null, queue: [] });
  const seen = React.useRef<{ ids: Set<string>; order: string[] }>({ ids: new Set(), order: [] });

  const current = state.current;
  React.useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => dispatch({ kind: "next" }), current.durationMs);
    return () => clearTimeout(timer);
  }, [current]);

  const enqueue = React.useCallback(
    (alert: OverlayAlertItem): boolean => {
      const memory = seen.current;
      if (memory.ids.has(alert.id)) return false;
      memory.ids.add(alert.id);
      memory.order.push(alert.id);
      while (memory.order.length > Math.max(1, remember)) {
        const oldest = memory.order.shift();
        if (oldest !== undefined) memory.ids.delete(oldest);
      }
      dispatch({ kind: "push", alert });
      return true;
    },
    [remember],
  );
  const clear = React.useCallback(() => dispatch({ kind: "clear" }), []);

  return { current, pending: state.queue.length, enqueue, clear };
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(REDUCED_MOTION);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Whether the viewer (or OBS) asks for reduced motion; `false` on the server. */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}
