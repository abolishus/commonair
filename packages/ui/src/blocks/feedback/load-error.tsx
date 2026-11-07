// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { Button } from "@commonair/ui/components/button";
import { cn } from "@commonair/ui/lib/utils";

export interface LoadErrorProps extends Omit<React.ComponentProps<"section">, "title" | "children"> {
  /** "{section} didn't load." with the section's own heading as `{section}`. */
  title: React.ReactNode;
  /** What else to know: "The rest of the page is fine.", "Busy right now. Retrying in 5 seconds…". */
  description?: React.ReactNode;
  /** The button's text ("Retry", or "Retry now" while an automatic retry is waiting). */
  retryLabel: React.ReactNode;
  onRetry: () => void;
  /** An automatic retry is scheduled: a spinner replaces the warning icon. */
  busy?: boolean;
  /**
   * The title's heading level, to fit the page outline (default 2: the block stands for a
   * section; 1 when it stands for the whole page, as on an error page).
   */
  headingLevel?: 1 | 2 | 3 | 4;
  /** `data-testid` on the Retry button. */
  retryTestId?: string;
}

/**
 * One section of a page did not load (F3): the section's name, what to expect, and Retry. The
 * rest of the page keeps rendering around it. A polite live region, so the failure (and a
 * changed note, such as "Retrying…") is announced without interrupting.
 */
export function LoadError({
  title,
  description,
  retryLabel,
  onRetry,
  busy = false,
  headingLevel = 2,
  retryTestId,
  className,
  ...props
}: LoadErrorProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      data-slot="load-error"
      data-busy={busy ? "true" : undefined}
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "flex flex-wrap items-center gap-3 bg-muted/40 px-3.5 py-3 ring-1 ring-border ring-inset",
        className,
      )}
      {...props}
    >
      <HugeiconsIcon
        icon={busy ? Loading03Icon : Alert02Icon}
        strokeWidth={2}
        aria-hidden="true"
        className={cn("size-4 shrink-0 text-muted-foreground", busy && "motion-safe:animate-spin")}
      />
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <Heading data-slot="load-error-title" className="text-sm font-medium text-foreground">
          {title}
        </Heading>
        {description ? (
          <p data-slot="load-error-description" className="text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <Button data-testid={retryTestId} variant="outline" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </section>
  );
}
