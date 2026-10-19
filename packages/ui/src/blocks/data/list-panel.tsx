// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@commonair/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";

export interface ListPanelItem {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  media?: React.ReactNode;
  actions?: React.ReactNode;
  href?: string;
  render?: React.ReactElement;
  highlighted?: boolean;
}
export interface ListPanelProps extends Omit<React.ComponentProps<"section">, "title" | "ref"> {
  title: React.ReactNode;
  action?: React.ReactNode;
  items: ListPanelItem[];
  footer?: React.ReactNode;
  variant?: "card" | "bare";
  empty?: React.ReactNode;
}
export function ListPanel({
  title,
  action,
  items,
  footer,
  variant = "card",
  empty,
  className,
  ...props
}: ListPanelProps) {
  const content = (
    <>
      <ItemGroup>
        {items.length
          ? items.map((item) => (
              <Item
                key={item.id}
                variant="outline"
                size="sm"
                data-highlighted={item.highlighted || undefined}
                render={item.render}
              >
                <ItemMedia>{item.media}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{item.href ? <a href={item.href}>{item.title}</a> : item.title}</ItemTitle>
                  {item.description ? <ItemDescription>{item.description}</ItemDescription> : null}
                  {item.meta ? <span className="text-xs text-muted-foreground">{item.meta}</span> : null}
                </ItemContent>
                {item.actions ? <ItemActions>{item.actions}</ItemActions> : null}
              </Item>
            ))
          : empty}
      </ItemGroup>
      {footer ? <div className="border-t pt-3 text-xs">{footer}</div> : null}
    </>
  );
  return variant === "bare" ? (
    <section className={cn("grid gap-3", className)} {...props}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        {action}
      </header>
      {content}
    </section>
  ) : (
    <Card size="sm" className={className} {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="grid gap-3">{content}</CardContent>
    </Card>
  );
}
