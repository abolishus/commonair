// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Button } from "@commonair/ui/components/button";
import { FieldGroup } from "@commonair/ui/components/field";
import { cn } from "@commonair/ui/lib/utils";

export interface FormSectionProps extends Omit<React.ComponentProps<"form">, "title" | "action"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  actions?: { cancelLabel?: string; saveLabel: string; onCancel?: () => void; disabled?: boolean };
  variant?: "card" | "plain";
  "data-testid"?: string;
}

export function FormSection({
  title,
  description,
  action,
  children,
  actions,
  variant = "card",
  className,
  "data-testid": testId,
  ...formProps
}: FormSectionProps): React.JSX.Element {
  const headingId = React.useId();
  const cardContent = (
    <>
      <CardHeader>
        <CardTitle id={headingId}>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>
        <FieldGroup>{children}</FieldGroup>
      </CardContent>
      {actions && (
        <CardFooter className="justify-end gap-2">
          {actions.onCancel && (
            <Button type="button" variant="ghost" onClick={actions.onCancel} disabled={actions.disabled}>
              {actions.cancelLabel}
            </Button>
          )}
          <Button type="submit" disabled={actions.disabled}>
            {actions.saveLabel}
          </Button>
        </CardFooter>
      )}
    </>
  );
  const shared = { "aria-labelledby": headingId, "data-testid": testId, className: cn("min-w-0", className) };
  if (variant === "plain")
    return (
      <section {...shared}>
        <form aria-labelledby={headingId} {...formProps}>
          <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={headingId} className="text-sm font-medium">
                {title}
              </h2>
              {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
            </div>
            {action}
          </header>
          <FieldGroup>{children}</FieldGroup>
          {actions && (
            <footer className="mt-4 flex flex-wrap justify-end gap-2">
              {actions.onCancel && (
                <Button type="button" variant="ghost" onClick={actions.onCancel} disabled={actions.disabled}>
                  {actions.cancelLabel}
                </Button>
              )}
              <Button type="submit" disabled={actions.disabled}>
                {actions.saveLabel}
              </Button>
            </footer>
          )}
        </form>
      </section>
    );
  return (
    <Card {...shared}>
      <form aria-labelledby={headingId} {...formProps}>
        {cardContent}
      </form>
    </Card>
  );
}
