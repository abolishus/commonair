// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";

export interface MetricPanelProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: string;
  value: React.ReactNode;
  caption: React.ReactNode;
  body?: React.ReactNode;
  icon?: React.ReactNode;
}
export function MetricPanel({ title, value, caption, body, icon, className, ...props }: MetricPanelProps) {
  return (
    <Card size="sm" className={className} {...props}>
      <CardHeader className="flex flex-row items-center gap-2">
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1">
        <div className="text-lg font-semibold tabular-nums">{value}</div>
        <p className="text-xs text-muted-foreground">{caption}</p>
        {body ? <p className="mt-2 text-xs">{body}</p> : null}
      </CardContent>
    </Card>
  );
}
