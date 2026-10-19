// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Alert01Icon, AlertCircleIcon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import { Alert, AlertDescription, AlertTitle } from "@commonair/ui/components/alert";
import { cn } from "@commonair/ui/lib/utils";

/**
 * The tone colors the border, icon and title only; the description stays `muted-foreground` on
 * `card`. Every pair is one tests/tokens.test.ts already checks AA (status tone on card), so the
 * callout adds no new token pair.
 */
export const alertCalloutVariants = cva("", {
  variants: {
    tone: {
      neutral: "",
      info: "border-info text-info",
      warning: "border-warning text-warning",
      danger: "border-destructive text-destructive",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type AlertCalloutTone = NonNullable<VariantProps<typeof alertCalloutVariants>["tone"]>;

const defaultIcons: Record<AlertCalloutTone, IconSvgElement> = {
  neutral: InformationCircleIcon,
  info: InformationCircleIcon,
  warning: Alert01Icon,
  danger: AlertCircleIcon,
};

export interface AlertCalloutProps extends Omit<React.ComponentProps<typeof Alert>, "title" | "variant"> {
  tone?: AlertCalloutTone;
  /** Leading Hugeicon; defaults per tone, `null` hides it. */
  icon?: IconSvgElement | null;
  title?: React.ReactNode;
  /** The body; a string renders as a paragraph, anything else as-is. */
  description?: React.ReactNode;
  /** A link or button under the description ("What the leak scanner checks", "Notification settings"). */
  action?: React.ReactNode;
  /**
   * `true` announces it (`role="alert"`, for something that just happened). Static page notes default
   * to `role="note"`, so screen readers do not interrupt with text that was always there.
   */
  live?: boolean;
}

/** A page callout: info notes, warnings (leaked key, copyright claim) and errors, on shadcn `Alert`. */
export function AlertCallout({
  tone = "neutral",
  icon,
  title,
  description,
  action,
  live = false,
  className,
  children,
  ...props
}: AlertCalloutProps): React.JSX.Element {
  const svg = icon === null ? null : (icon ?? defaultIcons[tone]);
  return (
    <Alert
      role={live ? "alert" : "note"}
      data-tone={tone}
      className={cn(alertCalloutVariants({ tone }), className)}
      {...props}
    >
      {svg ? <HugeiconsIcon icon={svg} strokeWidth={2} aria-hidden="true" /> : null}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {description || action || children ? (
        <AlertDescription>
          {typeof description === "string" ? <p>{description}</p> : description}
          {children}
          {action ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
