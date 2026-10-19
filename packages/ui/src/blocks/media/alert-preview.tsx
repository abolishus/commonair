// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Card, CardContent } from "@commonair/ui/components/card";
import { ChannelAvatar, MoneyAmount } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";

export interface AlertPreviewProps extends React.ComponentProps<"section"> {
  name: string;
  avatarUrl?: string | null;
  message: string;
  amount?: { cents: number; currency: string };
  eventLabel?: string;
  goal?: React.ReactNode;
  stageLabel: string;
}

export function AlertPreview({
  name,
  avatarUrl,
  message,
  amount,
  eventLabel,
  goal,
  stageLabel,
  className,
  ...props
}: AlertPreviewProps): React.JSX.Element {
  return (
    <section data-slot="alert-preview" className={cn("min-w-0", className)} {...props}>
      <AspectRatio ratio={16 / 9} className="grid place-items-center bg-muted p-4">
        <span className="sr-only">{stageLabel}</span>
        <Card size="sm" className="w-full max-w-md">
          <CardContent className="flex min-w-0 items-center gap-3 py-3">
            <ChannelAvatar name={name} src={avatarUrl} size="lg" decorative />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {eventLabel} {amount && <MoneyAmount value={amount} />}
              </p>
              <p className="break-words text-muted-foreground">{message}</p>
            </div>
          </CardContent>
        </Card>
        {goal && <div className="absolute inset-x-4 bottom-4">{goal}</div>}
      </AspectRatio>
    </section>
  );
}
