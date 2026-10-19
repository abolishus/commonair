// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { useId } from "react";
import { cn } from "@commonair/ui/lib/utils";
export interface SectionProps extends React.ComponentProps<"section"> {
  heading?: string;
  headingLevel?: 2 | 3 | 4;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}
export function Section({
  heading,
  headingLevel = 2,
  description,
  action,
  children,
  className,
  "aria-labelledby": labelledBy,
  ...props
}: SectionProps): React.JSX.Element {
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      aria-labelledby={heading ? (labelledBy ?? id) : labelledBy}
      className={cn("min-w-0 space-y-4", className)}
      {...props}
    >
      {heading || action ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          {heading ? (
            <div>
              <Heading id={labelledBy ?? id} className="font-medium">
                {heading}
              </Heading>
              {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
          ) : null}
          {action}
        </div>
      ) : description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </section>
  );
}
