// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The player's keyboard shortcuts (D2-player, F3): one map for live, DVR and VOD, listed in the
 * `?` dialog. They act only while focus is in the player or on the page body: never in a text
 * field, never in chat or anywhere else on the page, never with Ctrl, ⌘ or Alt held. A control
 * that owns a key keeps it: Space on a focused button presses that button, and arrows on the
 * scrubber or the volume slider move that slider (the DVR scrubber's own ±10 s, Page Up/Down,
 * Home and End are unchanged). `L` (back to live) stays with the DVR controls, which listen for
 * it themselves (`isBackToLiveKey`); it is listed here so the dialog shows it.
 */
import * as React from "react";
import type { MessageKey } from "../i18n/keys/index.gen.ts";
import { isTypingTarget } from "./dvr.ts";

export type ShortcutAction =
  | "playPause"
  | "mute"
  | "fullscreen"
  | "theatre"
  | "captions"
  | "back"
  | "forward"
  | "volumeUp"
  | "volumeDown"
  | "backToLive"
  | "help";

/** Where a shortcut applies: `all`, or only when the player can seek (`seek`: DVR and VOD). */
export interface ShortcutEntry {
  action: ShortcutAction;
  /** `KeyboardEvent.key` values, compared case-insensitively for letters. */
  keys: readonly string[];
  /** Key caps for the dialog (`Shortcut` labels). */
  caps: readonly (readonly string[])[];
  label: MessageKey;
  when: "all" | "seek" | "dvr";
}

/** Seconds the arrow keys seek on DVR and VOD. */
export const SEEK_STEP_SECONDS = 5;
/** Volume step of the up and down arrows (0 to 1). */
export const VOLUME_STEP = 0.1;

export const PLAYER_SHORTCUTS: readonly ShortcutEntry[] = [
  { action: "playPause", keys: [" ", "k"], caps: [["space"], ["k"]], label: "player.shortcuts.playPause", when: "all" },
  { action: "mute", keys: ["m"], caps: [["m"]], label: "player.shortcuts.mute", when: "all" },
  { action: "volumeUp", keys: ["ArrowUp"], caps: [["arrowup"]], label: "player.shortcuts.volumeUp", when: "all" },
  {
    action: "volumeDown",
    keys: ["ArrowDown"],
    caps: [["arrowdown"]],
    label: "player.shortcuts.volumeDown",
    when: "all",
  },
  { action: "back", keys: ["ArrowLeft"], caps: [["arrowleft"]], label: "player.shortcuts.back", when: "seek" },
  { action: "forward", keys: ["ArrowRight"], caps: [["arrowright"]], label: "player.shortcuts.forward", when: "seek" },
  { action: "backToLive", keys: [], caps: [["l"]], label: "player.shortcuts.backToLive", when: "dvr" },
  { action: "captions", keys: ["c"], caps: [["c"]], label: "player.shortcuts.captions", when: "all" },
  { action: "fullscreen", keys: ["f"], caps: [["f"]], label: "player.shortcuts.fullscreen", when: "all" },
  { action: "theatre", keys: ["t"], caps: [["t"]], label: "player.shortcuts.theatre", when: "all" },
  { action: "help", keys: ["?"], caps: [["shift", "?"]], label: "player.shortcuts.help", when: "all" },
];

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** Roles whose own keyboard handling uses the arrows. */
const ARROW_ROLES = new Set(["slider", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "tab"]);

function asElement(t: EventTarget | null): Element | null {
  return t !== null && typeof (t as Element).closest === "function" ? (t as Element) : null;
}

/** A focused control that handles this key itself (Space on a button, arrows on a slider). */
function ownsKey(target: Element, key: string): boolean {
  if (key === " ")
    return target.closest("button, a[href], summary, [role=button], [role=switch], [role=checkbox]") !== null;
  if (ARROWS.has(key)) {
    if (target instanceof HTMLInputElement && target.type === "range") return true;
    const role = target.closest("[role]")?.getAttribute("role");
    return role !== null && role !== undefined && ARROW_ROLES.has(role);
  }
  return false;
}

/** Focus on the page itself, not on any control. */
function onBody(target: Element | null): boolean {
  return target === null || target === document.body || target === document.documentElement;
}

/** The action a key event asks of the player whose root is `root`, or null. */
export function shortcutFor(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target" | "defaultPrevented">,
  root: Element | null,
): ShortcutAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  const target = asElement(e.target);
  const inPlayer = root !== null && target !== null && root.contains(target);
  if (!inPlayer && !onBody(target)) return null;
  if (inPlayer && target && target !== root && ownsKey(target, e.key)) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return PLAYER_SHORTCUTS.find((s) => s.keys.includes(key))?.action ?? null;
}

/** Players mounted on the page, newest last: a key on the body goes to the newest one only. */
const mounted: symbol[] = [];

/**
 * Listen for the shortcuts on the document. `handle` returns whether it acted (then the key's
 * default, such as scrolling, is prevented).
 */
export function usePlayerShortcuts(
  root: React.RefObject<HTMLElement | null>,
  handle: (action: ShortcutAction) => boolean,
  enabled = true,
): void {
  const handleRef = React.useRef(handle);
  React.useEffect(() => {
    handleRef.current = handle;
  });
  React.useEffect(() => {
    if (!enabled) return;
    const id = Symbol("player");
    mounted.push(id);
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      const target = asElement(e.target);
      // Body-level keys belong to the newest player; keys inside a player to that player.
      if (onBody(target) && mounted.at(-1) !== id) return;
      const action = shortcutFor(e, el);
      if (action === null) return;
      if (handleRef.current(action)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = mounted.indexOf(id);
      if (i >= 0) mounted.splice(i, 1);
    };
  }, [root, enabled]);
}
