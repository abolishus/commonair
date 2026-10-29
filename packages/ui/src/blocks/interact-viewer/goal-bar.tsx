// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Progress, ProgressIndicator, ProgressTrack } from "@commonair/ui/components/progress";
import { cn } from "@commonair/ui/lib/utils";
import type { OverlayState } from "../overlay/overlay-alerts.tsx";
import { useReducedMotion } from "../overlay/alert-queue.ts";

export type GoalBarType = "followers" | "subscriptions" | "tips";

export interface GoalBarItem {
  id: string;
  type: GoalBarType;
  title: string;
  /** Raw counts (tips: minor units), set as `data-current` / `data-target`. */
  current: number;
  target: number;
  /** "7 / 10 followers", "$12.00 / $50.00". */
  valueText: string;
  /** Reached its target: drawn full for a moment before it leaves. */
  achieved?: boolean;
}

export interface GoalBarProps extends Omit<React.ComponentProps<"div">, "children"> {
  goal: GoalBarItem;
  reducedMotion?: boolean;
}

/**
 * One goal on the OBS goals overlay (`overlay-goal`, docs/testing/e8-selectors.md): its title,
 * progress text and a thick bar, legible over any stream. The fill eases between updates unless
 * the viewer (or OBS) prefers reduced motion.
 */
export function GoalBar({ goal, reducedMotion, className, ...props }: GoalBarProps): React.JSX.Element {
  const prefersReduced = useReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const percent =
    goal.achieved || goal.current >= goal.target
      ? 100
      : goal.target > 0
        ? Math.max(0, Math.min(100, (goal.current / goal.target) * 100))
        : 0;
  return (
    <div
      data-testid="overlay-goal"
      data-goal-id={goal.id}
      data-type={goal.type}
      data-current={goal.current}
      data-target={goal.target}
      data-achieved={goal.achieved ? "true" : undefined}
      data-motion={reduced ? "reduced" : "full"}
      className={cn("grid w-full max-w-2xl min-w-0 gap-2", className)}
      {...props}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-4">
        <p className="min-w-0 text-2xl font-bold wrap-anywhere text-shadow-md text-shadow-overlay">{goal.title}</p>
        <p className="shrink-0 text-xl font-semibold tabular-nums text-shadow-md text-shadow-overlay">
          {goal.valueText}
        </p>
      </div>
      <Progress
        aria-label={goal.title}
        value={percent}
        className="gap-0"
        render={(rootProps) => (
          <div {...rootProps}>
            <ProgressTrack className="h-4 bg-overlay">
              <ProgressIndicator
                className={cn(
                  goal.achieved ? "bg-success" : "bg-primary",
                  reduced ? "transition-none" : "duration-700",
                )}
              />
            </ProgressTrack>
          </div>
        )}
      />
    </div>
  );
}

export interface OverlayGoalsViewProps extends Omit<React.ComponentProps<"div">, "children"> {
  state: OverlayState;
  goals: GoalBarItem[];
  reducedMotion?: boolean;
}

/**
 * The goals overlay page body (`overlay-goals`, `data-state` `loading` | `live` | `refused`):
 * transparent and chrome-less like the alerts overlay; nothing drawn until live or once refused.
 */
export function OverlayGoalsView({
  state,
  goals,
  reducedMotion,
  className,
  ...props
}: OverlayGoalsViewProps): React.JSX.Element {
  const shown = state === "live" ? goals : [];
  return (
    <div
      data-testid="overlay-goals"
      data-state={state === "connecting" ? "loading" : state}
      className={cn(
        "pointer-events-none flex min-h-svh w-full flex-col items-center justify-end gap-6 bg-transparent p-8 text-overlay-foreground select-none",
        className,
      )}
      {...props}
    >
      {shown.map((goal) => (
        <GoalBar key={goal.id} goal={goal} reducedMotion={reducedMotion} />
      ))}
    </div>
  );
}
