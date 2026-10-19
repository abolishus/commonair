// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { NavGroups, type NavItem } from "./nav.tsx";

export interface SectionNavProps extends React.ComponentProps<"aside"> {
  label: string;
  heading?: string;
  items: NavItem[];
  action?: React.ReactNode;
}
export function SectionNav({ label, heading, items, action, ...props }: SectionNavProps): React.JSX.Element {
  return (
    <aside {...props}>
      <div className="mb-2 flex items-center justify-between gap-2">
        {heading ? <h2 className="text-sm font-medium">{heading}</h2> : null}
        {action}
      </div>
      <div className="hidden md:block">
        <NavGroups groups={[{ id: "sections", items }]} label={label} />
      </div>
      <nav className="flex min-w-0 gap-2 overflow-x-auto pb-2 md:hidden" aria-label={label}>
        {items.map((item) => (
          <a
            key={item.id}
            href={item.href}
            aria-current={item.current ? "page" : undefined}
            className="shrink-0 whitespace-nowrap rounded-none border px-3 py-2 text-sm"
          >
            {item.label}
            {item.badge ? ` ${item.badge.label}` : ""}
          </a>
        ))}
      </nav>
    </aside>
  );
}
