// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { type OverlayAlertItem, useReducedMotion } from "./alert-queue.ts";

export type OverlayState = "connecting" | "live" | "refused";

export interface OverlayAlertsViewProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Set as the root's `data-state`. */
  state: OverlayState;
  /** The alert on screen (from `useAlertQueue().current`). */
  alert: OverlayAlertItem | null;
  /** Overrides the `prefers-reduced-motion` query (tests, stories). */
  reducedMotion?: boolean;
}

const ENTER: Record<OverlayAlertItem["animation"], string> = {
  fade: "animate-in fade-in duration-500",
  slide: "animate-in fade-in slide-in-from-bottom-8 duration-500",
  none: "",
};

/**
 * The OBS browser-source view: a transparent page with one alert at a time, large text with a
 * dark outline that stays legible over any stream, and no chrome. Nothing is visible while
 * connecting or once refused. Renders `overlay-alerts` (`data-state`), `overlay-alert`,
 * `overlay-alert-text` and `overlay-alert-message` (docs/testing/e6-selectors.md).
 */
export function OverlayAlertsView({
  state,
  alert,
  reducedMotion,
  className,
  ...props
}: OverlayAlertsViewProps): React.JSX.Element {
  const prefersReduced = useReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const shown = state === "live" ? alert : null;
  const animation = shown ? (reduced ? "none" : shown.animation) : "none";
  return (
    <div
      data-testid="overlay-alerts"
      data-state={state}
      aria-live="polite"
      className={cn(
        "pointer-events-none flex min-h-svh w-full items-end justify-center bg-transparent p-8 text-overlay-foreground select-none",
        className,
      )}
      {...props}
    >
      {shown ? (
        <div
          key={shown.id}
          data-testid="overlay-alert"
          data-alert-id={shown.id}
          data-type={shown.type}
          data-test={String(shown.test)}
          data-amount-cents={shown.amountCents ?? ""}
          data-animation={animation}
          className={cn(
            "flex max-w-4xl min-w-0 flex-col items-center gap-3 text-center motion-reduce:animate-none",
            ENTER[animation],
          )}
        >
          <p
            data-testid="overlay-alert-text"
            className="text-4xl font-bold wrap-anywhere text-shadow-lg text-shadow-overlay sm:text-6xl"
          >
            {shown.text}
          </p>
          {shown.message ? (
            <p
              data-testid="overlay-alert-message"
              className="text-2xl font-medium wrap-anywhere text-shadow-md text-shadow-overlay sm:text-3xl"
            >
              {shown.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
