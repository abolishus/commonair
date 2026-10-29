// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Progress, ProgressIndicator, ProgressTrack } from "@commonair/ui/components/progress";
import { cn } from "@commonair/ui/lib/utils";

export interface ShareBarProps {
  /** Accessible name of the bar (the choice or outcome title). */
  label: string;
  /** 0–100. */
  percent: number;
  /** Highlight (the viewer's pick, the winner). */
  emphasis?: boolean;
  className?: string;
}

/**
 * A thin share-of-total bar under a poll choice or prediction outcome. Base UI's indicator sets
 * its own inline-size, so the fill follows the writing direction without physical classes.
 */
export function ShareBar({ label, percent, emphasis = false, className }: ShareBarProps): React.JSX.Element {
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <Progress
      aria-label={label}
      value={value}
      className={cn("gap-0", className)}
      render={(rootProps) => (
        <div {...rootProps}>
          <ProgressTrack className="h-1.5">
            <ProgressIndicator
              className={cn("motion-reduce:transition-none", emphasis ? "bg-primary" : "bg-muted-foreground")}
            />
          </ProgressTrack>
        </div>
      )}
    />
  );
}

/** Up to two lines of a card's footer: an error (destructive) or a hint. */
export function CardNote({
  tone,
  children,
  ...props
}: { tone: "error" | "hint"; children: React.ReactNode } & Omit<React.ComponentProps<"p">, "children">) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cn("text-xs", tone === "error" ? "text-destructive" : "text-muted-foreground")}
      {...props}
    >
      {children}
    </p>
  );
}
