// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When the player's control bar shows (D2-player, F3): on pointer movement over the player, on
 * keyboard focus inside the bar and on tap; hidden again after `BAR_HIDE_MS` without activity
 * while playing. It never hides while paused, while a menu from it is open, or while keyboard
 * focus is inside it, and under `prefers-reduced-motion` it never hides at all (so it never fades).
 */
import * as React from "react";

export const BAR_HIDE_MS = 3_000;
/** A focus this soon after a pointer press inside the player came from the pointer, not the keyboard. */
const POINTER_FOCUS_MS = 600;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
  } catch {
    return null;
  }
}

function subscribeReducedMotion(cb: () => void): () => void {
  const q = reducedMotionQuery();
  // Some environments (and tests) hand back a bare `{ matches }`.
  if (!q || typeof q.addEventListener !== "function") return () => {};
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
}

/** Whether the viewer asked for reduced motion; false on the server. */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => reducedMotionQuery()?.matches === true,
    () => false,
  );
}

export interface PlayerBar {
  visible: boolean;
  /** Spread on the player root (pointer activity and taps). */
  rootProps: {
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
  };
  /** Spread on the control bar (focus inside it). */
  barProps: {
    ref: React.RefCallback<HTMLDivElement>;
    onFocus: (e: React.FocusEvent) => void;
    onBlur: (e: React.FocusEvent) => void;
  };
  /** Keep the bar up while something opened from it (a menu, a hint) is open. */
  hold: (key: string, on: boolean) => void;
  /** Show the bar now, as if the pointer moved (a shortcut was pressed). */
  poke: () => void;
}

export function usePlayerBar({ playing }: { playing: boolean }): PlayerBar {
  const reduced = useReducedMotion();
  const [active, setActive] = React.useState(true);
  const [focusInside, setFocusInside] = React.useState(false);
  const [holds, setHolds] = React.useState<ReadonlySet<string>>(() => new Set());
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const bar = React.useRef<HTMLDivElement | null>(null);
  const pressedAt = React.useRef(0);
  const playingRef = React.useRef(playing);
  React.useEffect(() => {
    playingRef.current = playing;
  });

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const poke = React.useCallback(() => {
    setActive(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = playingRef.current ? setTimeout(() => setActive(false), BAR_HIDE_MS) : null;
  }, []);

  // Playback starting shows the bar and arms the timer; paused, the bar shows regardless (`visible`).
  const [wasPlaying, setWasPlaying] = React.useState(playing);
  if (wasPlaying !== playing) {
    setWasPlaying(playing);
    if (playing) setActive(true);
  }
  React.useEffect(() => {
    if (!playing) return;
    timer.current = setTimeout(() => setActive(false), BAR_HIDE_MS);
    return clear;
  }, [playing]);

  const inBar = (t: EventTarget | null) => t instanceof Node && bar.current !== null && bar.current.contains(t);
  // The settings panel and its hint sit outside the bar but belong to it: a tap there is a tap on a control.
  const inBarUi = (t: EventTarget | null) =>
    inBar(t) ||
    (t instanceof Element && t.closest('[data-slot="player-settings"], [data-slot="player-hint"]') !== null);

  const rootProps: PlayerBar["rootProps"] = {
    onPointerMove: (e) => {
      if (e.pointerType !== "touch") poke();
    },
    onPointerDown: (e) => {
      pressedAt.current = Date.now();
      // A tap on the picture toggles the bar; a tap on a control keeps it up.
      if (e.pointerType === "touch" && !inBarUi(e.target) && active && playingRef.current) {
        clear();
        setActive(false);
        return;
      }
      poke();
    },
    onPointerLeave: (e) => {
      if (e.pointerType === "touch" || !playingRef.current) return;
      clear();
      setActive(false);
    },
  };

  const barProps: PlayerBar["barProps"] = {
    ref: (el) => {
      bar.current = el;
    },
    onFocus: () => {
      if (Date.now() - pressedAt.current > POINTER_FOCUS_MS) setFocusInside(true);
      poke();
    },
    onBlur: (e) => {
      if (inBar(e.relatedTarget)) return;
      setFocusInside(false);
      poke();
    },
  };

  const hold = React.useCallback(
    (key: string, on: boolean) => {
      setHolds((prev) => {
        if (prev.has(key) === on) return prev;
        const next = new Set(prev);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      });
      if (!on) poke();
    },
    [poke],
  );

  const visible = reduced || !playing || focusInside || holds.size > 0 || active;
  return { visible, rootProps, barProps, hold, poke };
}
