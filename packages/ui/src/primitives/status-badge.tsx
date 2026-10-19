// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import { Badge } from "../components/badge.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Each tone is text on its own 10 % tint (hover 15 %); tests/tokens.test.ts checks
 * every pair is AA over --background and --card in both themes.
 */
export const statusBadgeVariants = cva("", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground [a]:hover:bg-muted",
      success: "bg-success/10 text-success [a]:hover:bg-success/15",
      warning: "bg-warning/10 text-warning [a]:hover:bg-warning/15",
      info: "bg-info/10 text-info [a]:hover:bg-info/15",
      danger: "bg-destructive/10 text-destructive [a]:hover:bg-destructive/15",
      accent: "bg-channel-accent text-channel-accent-foreground [a]:hover:bg-channel-accent-hover",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>["tone"]>;

export interface StatusBadgeProps
  extends Omit<React.ComponentProps<typeof Badge>, "variant">, VariantProps<typeof statusBadgeVariants> {
  /** Optional leading Hugeicon (decorative: the text carries the meaning). */
  icon?: IconSvgElement;
}

/**
 * A state chip ("Active", "Pending review", "Paid"). The tone is never the only
 * signal: the label always says the state in words.
 */
export function StatusBadge({ tone, icon, className, children, ...props }: StatusBadgeProps): React.JSX.Element {
  return (
    <Badge
      variant="secondary"
      data-tone={tone ?? "neutral"}
      className={cn(statusBadgeVariants({ tone }), className)}
      {...props}
    >
      {icon && <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden data-icon="inline-start" />}
      {children}
    </Badge>
  );
}
