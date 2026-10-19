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
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className={cn("break-words font-semibold tracking-tight", size === "page" ? "text-2xl" : "text-xl")}>
            {title}
          </h1>
          {description ? <p className="mt-2 max-w-prose text-sm text-muted-foreground">{description}</p> : null}
          {meta ? <div className="mt-2 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs}
    </header>
  );
}
