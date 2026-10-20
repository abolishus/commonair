// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Badge } from "@commonair/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { cn } from "@commonair/ui/lib/utils";
export interface PageTab {
  id: string;
  label: string;
  href?: string;
  render?: React.ReactElement;
  current?: boolean;
  count?: string | number;
  content?: React.ReactNode;
  /** Disables this tab; say why with `aria-describedby` pointing at visible text. */
  disabled?: boolean;
  "data-testid"?: string;
  "aria-describedby"?: string;
}
export interface PageTabsProps {
  items: PageTab[];
  variant?: "line" | "default";
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  /** Accessible name of the tab list. */
  "aria-label"?: string;
  /** Stretch the tab list to the full width (the triggers share it). */
  fullWidth?: boolean;
  /** Rendered between the tab list and the panels, e.g. why a tab is disabled. */
  afterList?: React.ReactNode;
}
export function PageTabs({
  items,
  variant = "line",
  value,
  onValueChange,
  className,
  fullWidth = false,
  afterList,
  ...props
}: PageTabsProps): React.JSX.Element {
  const panelMode = onValueChange !== undefined || value !== undefined;
  const current = value ?? items.find((item) => item.current)?.id ?? items[0]?.id;
  return (
    <Tabs value={panelMode ? current : undefined} onValueChange={onValueChange} className={cn("min-w-0", className)}>
      {/*
        Only the list scrolls sideways at 320 px; the panels keep the page width. A scroller clips
        vertically too, so the line variant's underline (below the list) gets bottom padding,
        cancelled by a matching negative margin so the layout does not move.
      */}
      <div className={cn("min-w-0 overflow-x-auto", variant === "line" && "-mb-1.5 pb-1.5")}>
        <TabsList variant={variant} aria-label={props["aria-label"]} className={cn("min-w-max", fullWidth && "w-full")}>
          {items.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              disabled={item.disabled}
              data-testid={item["data-testid"]}
              aria-describedby={item["aria-describedby"]}
              nativeButton={panelMode}
              render={
                panelMode
                  ? undefined
                  : (item.render ??
                    (item.href ? (
                      <a href={item.href}>
                        {item.label}
                        {item.count !== undefined ? <Badge variant="secondary">{item.count}</Badge> : null}
                      </a>
                    ) : undefined))
              }
              aria-current={!panelMode && item.current ? "page" : undefined}
            >
              {item.label}
              {item.count !== undefined ? <Badge variant="secondary">{item.count}</Badge> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {afterList}
      {panelMode
        ? items.map((item) => (
            <TabsContent key={item.id} value={item.id}>
              {item.content}
            </TabsContent>
          ))
        : null}
    </Tabs>
  );
}
