// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { ToggleGroup, ToggleGroupItem } from "../components/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip.tsx";
import { useUiMessages } from "../lib/locale.tsx";

export const THEMES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * Applies a theme choice to the document: `data-theme` drives globals.css
 * (dark default, light block, "system" via `prefers-color-scheme`).
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.classList.toggle("light", theme === "light");
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function subscribeColorScheme(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(LIGHT_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

/** The theme actually shown ("system" resolved against the OS), e.g. for `<Toaster theme>`. */
export function useResolvedTheme(theme: Theme): "dark" | "light" {
  const prefersLight = React.useSyncExternalStore(
    subscribeColorScheme,
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(LIGHT_QUERY).matches,
    () => false,
  );
  if (theme === "system") return prefersLight ? "light" : "dark";
  return theme;
}

const ICONS = { dark: Moon02Icon, light: Sun03Icon, system: ComputerIcon } as const;

export interface ThemeToggleProps {
  value: Theme;
  /** Persist the choice (cookie, account setting) and call `applyTheme`; this component stores nothing. */
  onValueChange: (theme: Theme) => void;
  /** Labels; default to `messages.theme`. */
  labels?: Partial<Record<Theme | "label", string>>;
  className?: string;
}

/** Dark / light / system switch as a three-way toggle group with labelled icon buttons. */
export function ThemeToggle({ value, onValueChange, labels, className }: ThemeToggleProps): React.JSX.Element {
  const messages = useUiMessages();
  const text = { ...messages.theme, ...labels };
  return (
    <ToggleGroup
      aria-label={text.label}
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      onValueChange={(next: unknown[]) => {
        // Pressing the active item would empty the group; a theme is always selected.
        const picked = next.find((v): v is Theme => isTheme(v) && v !== value);
        if (picked) onValueChange(picked);
      }}
      className={className}
    >
      {THEMES.map((theme) => (
        <Tooltip key={theme}>
          <TooltipTrigger
            render={
              <ToggleGroupItem value={theme} aria-label={text[theme]}>
                <HugeiconsIcon icon={ICONS[theme]} strokeWidth={2} aria-hidden />
              </ToggleGroupItem>
            }
          />
          <TooltipContent>{text[theme]}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
