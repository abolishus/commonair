// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";

export interface PageContainerProps extends React.ComponentProps<"div"> {
  width?: "default" | "narrow" | "wide";
}
export function PageContainer({ width = "default", className, ...props }: PageContainerProps): React.JSX.Element {
  const widths = { default: "max-w-6xl", narrow: "max-w-3xl", wide: "max-w-7xl" };
  return <div className={cn("mx-auto w-full px-4", widths[width], className)} {...props} />;
}
export interface SplitLayoutProps extends React.ComponentProps<"div"> {
  main: React.ReactNode;
  aside: React.ReactNode;
  asideWidth?: "sm" | "md" | "lg";
}
export function SplitLayout({
  main,
  aside,
  asideWidth = "md",
  className,
  ...props
}: SplitLayoutProps): React.JSX.Element {
  const widths = { sm: "lg:w-64", md: "lg:w-72", lg: "lg:w-80" };
  return (
    <div className={cn("flex min-w-0 flex-col gap-6 lg:flex-row", className)} {...props}>
      <div className="min-w-0 flex-1">{main}</div>
      <aside className={cn("min-w-0", widths[asideWidth])}>{aside}</aside>
    </div>
  );
}
export interface ResponsiveGridProps extends React.ComponentProps<"div"> {
  cols?: 2 | 3 | 4;
  gap?: "sm" | "md" | "lg";
}
export function ResponsiveGrid({ cols = 3, gap = "md", className, ...props }: ResponsiveGridProps): React.JSX.Element {
  const columns = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 xl:grid-cols-3", 4: "sm:grid-cols-2 xl:grid-cols-4" };
  const gaps = { sm: "gap-3", md: "gap-4", lg: "gap-6" };
  return <div className={cn("grid min-w-0 grid-cols-1", columns[cols], gaps[gap], className)} {...props} />;
}
