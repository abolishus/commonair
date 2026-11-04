// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F35: the one paragraph style for a note inside a studio card, the size of the card's own
 * description and the fields' help text (`text-xs/relaxed`, muted). An important note is an
 * `AlertCallout` instead, never a bigger paragraph.
 */
import { cn } from "@commonair/ui/lib/utils";
import type * as React from "react";

export const NOTE_CLASS = "text-xs/relaxed text-muted-foreground";

export function StudioNote({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element {
  return <p data-slot="studio-note" className={cn(NOTE_CLASS, className)} {...props} />;
}
