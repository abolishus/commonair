// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { EmptyArt, type EmptyArtVariant } from "../art/empty-art.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from "../components/empty.tsx";
import { cn } from "../lib/utils.ts";

export interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title"> {
  /** A Hugeicons icon, drawn on the glyph plate (the default art when given). */
  icon?: IconSvgElement;
  title: React.ReactNode;
  /** One or two sentences under the title. */
  description?: React.ReactNode;
  /** Same as `description` (the plan's name for it); `description` wins when both are set. */
  body?: React.ReactNode;
  /** The primary action, usually a `<Button>` that resolves the emptiness ("Browse categories"). */
  action?: React.ReactNode;
  /** A second, quieter action (outline or ghost), after the primary one. */
  secondaryAction?: React.ReactNode;
  /** Heading level for the title, to fit the page outline. */
  headingLevel?: 2 | 3 | 4;
  /**
   * The picture: `glyph` (the icon on a tinted plate; the default with an icon), `arcs` (the
   * default without one), `bars`, or `none`.
   */
  art?: EmptyArtVariant | "none";
  /** The arcs crossed by one bar: for errors and things that are down. */
  crossed?: boolean;
  /** sm inside panels and rails, md in lists and sections, lg for a whole page (404, 500). */
  size?: "sm" | "md" | "lg";
}

const TITLE = { sm: "text-sm font-semibold", md: "text-base font-semibold", lg: "text-2xl font-semibold" } as const;
const BODY = { sm: "max-w-xs text-sm", md: "max-w-sm text-sm", lg: "max-w-md text-base" } as const;

/** What an empty list, an error or a missing page shows instead of a blank area. */
export function EmptyState({
  icon,
  title,
  description,
  body,
  action,
  secondaryAction,
  headingLevel = 2,
  art,
  crossed = false,
  size = "md",
  className,
  ...props
}: EmptyStateProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  const variant = art ?? (icon ? "glyph" : "arcs");
  const text = description ?? body;
  return (
    <Empty
      data-slot="empty-state"
      data-size={size}
      className={cn(size === "lg" && "min-h-96 gap-6 py-12", size === "sm" && "gap-3 p-4", className)}
      {...props}
    >
      <EmptyHeader className={cn(size === "lg" && "max-w-md")}>
        {variant !== "none" && (
          <EmptyArt variant={variant} icon={icon} size={size} crossed={crossed} className="mb-2" />
        )}
        {/* A real heading (EmptyTitle is a div) so the empty state shows up in the page outline. */}
        <Heading data-slot="empty-title" className={cn("text-balance text-foreground", TITLE[size])}>
          {title}
        </Heading>
        {text && <EmptyDescription className={cn("text-pretty", BODY[size])}>{text}</EmptyDescription>}
      </EmptyHeader>
      {(action || secondaryAction) && (
        <EmptyContent
          data-slot="empty-state-actions"
          className="max-w-md flex-row flex-wrap justify-center gap-2 text-sm"
        >
          {action}
          {secondaryAction}
        </EmptyContent>
      )}
    </Empty>
  );
}
