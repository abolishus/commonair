// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Badge } from "@commonair/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
export interface PageTab {
  id: string;
  label: string;
  href?: string;
  render?: React.ReactElement;
  current?: boolean;
  count?: string | number;
  content?: React.ReactNode;
}
export interface PageTabsProps {
  items: PageTab[];
  variant?: "line" | "default";
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}
export function PageTabs({
  items,
  variant = "line",
  value,
  onValueChange,
  className,
}: PageTabsProps): React.JSX.Element {
  const panelMode = onValueChange !== undefined || value !== undefined;
  const current = value ?? items.find((item) => item.current)?.id ?? items[0]?.id;
  return (
    <div className="min-w-0 overflow-x-auto">
      <Tabs value={panelMode ? current : undefined} onValueChange={onValueChange} className={className}>
        <TabsList variant={variant} className="min-w-max">
          {items.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
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
        {panelMode
          ? items.map((item) => (
              <TabsContent key={item.id} value={item.id}>
                {item.content}
              </TabsContent>
            ))
          : null}
      </Tabs>
    </div>
  );
}
