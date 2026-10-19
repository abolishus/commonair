// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ViewIcon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import { formatCompactNumber, formatNumber } from "../lib/format.ts";
import { useResolvedLocale, useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";
import { OverlayBadge } from "./overlay-badge.tsx";

const viewerCountVariants = cva("inline-flex items-center gap-1 tabular-nums", {
  variants: {
    variant: {
      default: "text-muted-foreground",
      // Drawn by OverlayBadge; only layout is added here.
      overlay: "",
    },
    size: { sm: "text-2xs [&_svg]:size-3", md: "text-xs [&_svg]:size-3.5" },
  },
  defaultVariants: { variant: "default", size: "md" },
});

export interface ViewerCountProps
  extends Omit<React.ComponentProps<"span">, "children">, VariantProps<typeof viewerCountVariants> {
  /** Verified viewers only (the API never exposes excluded traffic). */
  count: number;
  locale?: string;
  /** Accessible label; defaults to `messages.viewerCount` ("1,234 verified viewers"). */
  label?: (formatted: string, count: number) => string;
  icon?: boolean;
}

/** Compact viewer count ("1.2K") with a full, explicit "verified viewers" label for screen readers. */
export function ViewerCount({
  count,
  locale,
  label,
  icon = true,
  variant,
  size,
  className,
  ...props
}: ViewerCountProps): React.JSX.Element {
  const messages = useUiMessages();
  const resolved = useResolvedLocale(locale);
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const accessible = (label ?? messages.viewerCount)(formatNumber(safe, resolved), safe);
  const content = (
    <>
      {icon && <HugeiconsIcon icon={ViewIcon} strokeWidth={2} aria-hidden />}
      <span aria-hidden>{formatCompactNumber(safe, resolved)}</span>
      <span className="sr-only">{accessible}</span>
    </>
  );
  if (variant === "overlay") {
    return (
      <OverlayBadge data-slot="viewer-count" size={size} className={className} {...props}>
        {content}
      </OverlayBadge>
    );
  }
  return (
    <span data-slot="viewer-count" className={cn(viewerCountVariants({ variant, size }), className)} {...props}>
      {content}
    </span>
  );
}
