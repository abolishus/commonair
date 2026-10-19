// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Badge } from "../components/badge.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";

const liveBadgeVariants = cva(
  "gap-1 bg-live font-semibold tracking-wide text-live-foreground uppercase select-none [a]:hover:bg-live",
  {
    variants: {
      size: {
        sm: "h-4 px-1 text-2xs",
        md: "h-5 px-1.5 text-xs",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface LiveBadgeProps
  extends Omit<React.ComponentProps<"span">, "children">, VariantProps<typeof liveBadgeVariants> {
  /** Visible text; defaults to the design-system catalog (`messages.live`). */
  label?: string;
  /** Pulsing dot (disabled automatically under reduced motion). */
  pulse?: boolean;
}

/** The one way to mark something as live (a `Badge` in the live tone). Never write "LIVE" by hand. */
export function LiveBadge({ label, pulse = false, size, className, ...props }: LiveBadgeProps): React.JSX.Element {
  const messages = useUiMessages();
  return (
    <Badge data-slot="live-badge" className={cn(liveBadgeVariants({ size }), className)} {...props}>
      {pulse && <span aria-hidden className="size-1.5 rounded-full bg-live-foreground motion-safe:animate-pulse" />}
      {label ?? messages.live}
    </Badge>
  );
}
