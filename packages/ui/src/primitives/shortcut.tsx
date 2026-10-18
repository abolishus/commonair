// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Kbd, KbdGroup } from "../components/kbd.tsx";

export { Kbd, KbdGroup };

export type Platform = "mac" | "other";

/** Symbols are universal; the "other" spellings are the key-cap names printed on PC keyboards. */
const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  mod: { mac: "⌘", other: "Ctrl" },
  ctrl: { mac: "⌃", other: "Ctrl" },
  control: { mac: "⌃", other: "Ctrl" },
  meta: { mac: "⌘", other: "Win" },
  cmd: { mac: "⌘", other: "Ctrl" },
  alt: { mac: "⌥", other: "Alt" },
  option: { mac: "⌥", other: "Alt" },
  shift: { mac: "⇧", other: "Shift" },
  enter: { mac: "↵", other: "Enter" },
  escape: { mac: "Esc", other: "Esc" },
  esc: { mac: "Esc", other: "Esc" },
  backspace: { mac: "⌫", other: "Backspace" },
  tab: { mac: "⇥", other: "Tab" },
  space: { mac: "Space", other: "Space" },
  arrowup: { mac: "↑", other: "↑" },
  arrowdown: { mac: "↓", other: "↓" },
  arrowleft: { mac: "←", other: "←" },
  arrowright: { mac: "→", other: "→" },
};

/** Display label for one key in a shortcut ("mod" is ⌘ on macOS and Ctrl elsewhere). */
export function keyLabel(key: string, platform: Platform): string {
  const known = KEY_LABELS[key.toLowerCase()];
  if (known) return known[platform];
  return key.length === 1 ? key.toUpperCase() : key;
}

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(name) ? "mac" : "other";
}

const noopSubscribe = (): (() => void) => () => {};

/** Client platform, "other" during SSR so hydration matches, then the real one. */
export function usePlatform(): Platform {
  return React.useSyncExternalStore(noopSubscribe, detectPlatform, () => "other");
}

export interface ShortcutProps extends Omit<React.ComponentProps<typeof KbdGroup>, "children"> {
  /** Keys in order, e.g. `["mod", "k"]` or `["shift", "?"]`. */
  keys: readonly string[];
  /** Overrides detection (stories, docs pages showing both). */
  platform?: Platform;
}

/** A keyboard shortcut rendered as key caps. */
export function Shortcut({ keys, platform, className, ...props }: ShortcutProps): React.JSX.Element {
  const detected = usePlatform();
  const p = platform ?? detected;
  return (
    <KbdGroup data-slot="shortcut" className={className} {...props}>
      {keys.map((key, i) => (
        <Kbd key={`${key}-${i}`}>{keyLabel(key, p)}</Kbd>
      ))}
    </KbdGroup>
  );
}
