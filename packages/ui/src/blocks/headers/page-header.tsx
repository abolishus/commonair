// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
export interface PageHeaderProps extends React.ComponentProps<"header"> {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  tabs?: React.ReactNode;
  size?: "page" | "compact";
}
/**
 * A page's title, description and actions. Below `sm` the actions stack under the title, so a
 * phone never squeezes the title into a sliver that breaks mid-word (F29); from `sm` they sit
 * beside it and wrap under it only when the title would get narrower than 16rem. A title wraps
 * between words (balanced); only a single word longer than the line breaks.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  breadcrumbs,
  tabs,
  size = "page",
  className,
  ...props
}: PageHeaderProps): React.JSX.Element {
  return (
    <header className={cn("min-w-0 space-y-4", className)} {...props}>
      {breadcrumbs}
      <div
        data-slot="page-header-row"
        className="flex min-w-0 flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between"
      >
        <div data-slot="page-header-title" className="min-w-0 sm:flex-1 sm:basis-64">
          <h1
            className={cn(
              "text-balance break-words hyphens-none font-semibold tracking-tight",
              size === "page" ? "text-2xl" : "text-xl",
            )}
          >
            {title}
          </h1>
          {description ? <p className="mt-2 max-w-prose text-sm text-muted-foreground">{description}</p> : null}
          {meta ? <div className="mt-2 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {actions ? (
          <div data-slot="page-header-actions" className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">
            {actions}
          </div>
        ) : null}
      </div>
      {tabs}
    </header>
  );
}
