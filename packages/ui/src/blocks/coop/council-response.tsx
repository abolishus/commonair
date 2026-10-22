// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { ChoiceToggle } from "../forms/choice-toggle.tsx";
import { councilStanceTone } from "./tones.ts";

export interface CouncilResponseCardProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  /** `COUNCIL_STANCES` value; set as `data-stance` and picks the badge tone. */
  stance: string;
  /** "Supports" / "Opposes" … */
  stanceLabel: string;
  /** "Creator council response". */
  title: React.ReactNode;
  /** The published text (plain text; line breaks are kept). */
  body: React.ReactNode;
  /** When it was published (`RelativeTime` or formatted text). */
  publishedAt?: React.ReactNode;
}

/** The creator council's published response to a proposal, shown on the ballot. */
export function CouncilResponseCard({
  stance,
  stanceLabel,
  title,
  body,
  publishedAt,
  className,
  ...props
}: CouncilResponseCardProps): React.JSX.Element {
  return (
    <Card size="sm" data-stance={stance} className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {title}
          <StatusBadge tone={councilStanceTone(stance)}>{stanceLabel}</StatusBadge>
        </CardTitle>
        {publishedAt ? <CardDescription>{publishedAt}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="text-xs/relaxed whitespace-pre-line wrap-anywhere">{body}</div>
      </CardContent>
    </Card>
  );
}

export interface CouncilStanceOption {
  value: string;
  label: string;
}

export interface CouncilRespondFormProps extends Omit<React.ComponentProps<"form">, "children" | "title" | "onSubmit"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  stanceLabel: React.ReactNode;
  stances: readonly CouncilStanceOption[];
  stance: string;
  onStanceChange: (stance: string) => void;
  bodyLabel: React.ReactNode;
  bodyHint?: React.ReactNode;
  bodyPlaceholder?: string;
  body: string;
  onBodyChange: (body: string) => void;
  /** Characters allowed in the body. */
  maxLength?: number;
  submitLabel: string;
  onSubmit: (value: { stance: string; body: string }) => void | Promise<void>;
  pending?: boolean;
  error?: React.ReactNode;
  /** Set on the stance toggle group; each stance item gets `stanceItemProps(stance)`. */
  stanceProps?: { "data-testid"?: string };
  stanceItemProps?: (stance: string) => { "data-testid"?: string };
  bodyProps?: DataAttributes;
  submitProps?: DataAttributes;
}

/** Council members, `council_review`, no response yet: stance + text + publish. */
export function CouncilRespondForm({
  title,
  description,
  stanceLabel,
  stances,
  stance,
  onStanceChange,
  bodyLabel,
  bodyHint,
  bodyPlaceholder,
  body,
  onBodyChange,
  maxLength = 5000,
  submitLabel,
  onSubmit,
  pending = false,
  error,
  stanceProps,
  stanceItemProps,
  bodyProps,
  submitProps,
  className,
  ...props
}: CouncilRespondFormProps): React.JSX.Element {
  const bodyId = React.useId();
  const ready = Boolean(stance) && body.trim().length > 0;
  return (
    <Card size="sm" className={cn("min-w-0", className)}>
      <form
        {...props}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !pending) void onSubmit({ stance, body: body.trim() });
        }}
      >
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ChoiceToggle
            label={stanceLabel}
            data-testid={stanceProps?.["data-testid"]}
            options={stances.map((option) => ({
              value: option.value,
              label: option.label,
              disabled: pending,
              "data-testid": stanceItemProps?.(option.value)["data-testid"],
            }))}
            value={stance}
            onValueChange={onStanceChange}
            wrap
          />
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={bodyId}>{bodyLabel}</FieldLabel>
            <Textarea
              {...bodyProps}
              id={bodyId}
              value={body}
              maxLength={maxLength}
              placeholder={bodyPlaceholder}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              onChange={(event) => onBodyChange(event.currentTarget.value)}
            />
            {bodyHint ? <FieldDescription>{bodyHint}</FieldDescription> : null}
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            {...submitProps}
            type="submit"
            size="sm"
            disabled={!ready || pending}
            aria-busy={pending || undefined}
          >
            {submitLabel}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
