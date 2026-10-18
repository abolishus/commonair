// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "../components/empty.tsx";

export interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title"> {
  /** A Hugeicons icon. */
  icon?: IconSvgElement;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Usually a `<Button>` that resolves the emptiness ("Browse categories"). */
  action?: React.ReactNode;
  /** Heading level for the title, to fit the page outline. */
  headingLevel?: 2 | 3 | 4;
}

/** What an empty list shows instead of a blank area. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 2,
  ...props
}: EmptyStateProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  return (
    <Empty data-slot="empty-state" {...props}>
      <EmptyHeader>
        {icon && (
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden />
          </EmptyMedia>
        )}
        {/* A real heading (EmptyTitle is a div) so the empty state shows up in the page outline. */}
        <Heading data-slot="empty-title" className="text-sm font-medium">
          {title}
        </Heading>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
