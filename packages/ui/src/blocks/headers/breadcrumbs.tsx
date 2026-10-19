// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@commonair/ui/components/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
export interface BreadcrumbEntry {
  label: string;
  href?: string;
  render?: React.ReactElement;
}
export interface BreadcrumbsProps extends Omit<React.ComponentProps<"nav">, "children"> {
  items: BreadcrumbEntry[];
  label: string;
}
export function Breadcrumbs({ items, label, ...props }: BreadcrumbsProps): React.JSX.Element {
  if (items.length === 0) return <Breadcrumb aria-label={label} {...props} />;
  const middle = items.length > 4 ? items.slice(1, -2) : [];
  const shown = items.length > 4 ? [items[0], items[items.length - 2], items[items.length - 1]] : items;
  return (
    <Breadcrumb aria-label={label} {...props}>
      <BreadcrumbList>
        {shown.map((item, index) =>
          item ? (
            <React.Fragment key={`${item.label}-${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              {items.length > 4 && index === 1 ? (
                <BreadcrumbItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label={label}>
                      <BreadcrumbEllipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {middle.map((entry) => (
                        <DropdownMenuItem
                          key={entry.label}
                          render={entry.render ?? (entry.href ? <a href={entry.href}>{entry.label}</a> : undefined)}
                        >
                          {entry.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem>
                  {index === shown.length - 1 ? (
                    <BreadcrumbPage aria-current="page">{item.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={item.render ?? (item.href ? <a href={item.href}>{item.label}</a> : undefined)}
                    >
                      {item.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              )}
            </React.Fragment>
          ) : null,
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
