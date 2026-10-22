// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { MoneyAmount, type MoneyValue } from "../../primitives/money-amount.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { ProgressRow } from "../data/progress-row.tsx";
import { CopyField } from "../forms/copy-field.tsx";
import { membershipStatusTone, shareStatusTone } from "./tones.ts";

/** A confirmed exit (or any consequential action) behind a `ConfirmDialog`. */
export interface ConfirmedAction {
  label: string;
  confirmTitle: React.ReactNode;
  /** E.g. whether the share will be refunded. */
  confirmDescription?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  disabled?: boolean;
  /** Set on the trigger button (e.g. `membership-exit-viewer`). */
  triggerProps?: DataAttributes;
  /** Set on the dialog (e.g. `membership-exit-confirm`). */
  dialogProps?: DataAttributes;
}

function ConfirmedActionButton({ action }: { action: ConfirmedAction }): React.JSX.Element {
  return (
    <ConfirmDialog
      trigger={
        <Button
          {...action.triggerProps}
          type="button"
          size="sm"
          variant={action.destructive ? "destructive" : "outline"}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      }
      title={action.confirmTitle}
      description={action.confirmDescription}
      confirmLabel={action.confirmLabel ?? action.label}
      variant={action.destructive ? "destructive" : "default"}
      onConfirm={action.onConfirm}
      onError={action.onError}
      contentProps={action.dialogProps}
    />
  );
}

export interface MembershipListItem {
  id: string;
  /** `MEMBER_CLASSES` value; set as `data-class`. */
  memberClass: string;
  classLabel: React.ReactNode;
  /** `MEMBERSHIP_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  /** `MEMBERSHIP_BASES` value; set as `data-basis`. */
  basis: string;
  basisLabel: React.ReactNode;
  /** "Since Mar 2026" (`RelativeTime` or formatted text). */
  since?: React.ReactNode;
  /** Active memberships: leave the class. */
  exit?: ConfirmedAction;
}

export interface MembershipListProps extends Omit<React.ComponentProps<"div">, "children"> {
  items: readonly MembershipListItem[];
  /** Accessible name of the list. */
  label: string;
  empty?: React.ReactNode;
  /** Set on every row besides its `data-*` (e.g. `{ "data-testid": "membership-row" }`). */
  itemProps?: DataAttributes;
}

/** The caller's memberships: class, status, basis and, while active, the exit action. */
export function MembershipList({
  items,
  label,
  empty,
  itemProps,
  className,
  ...props
}: MembershipListProps): React.JSX.Element {
  if (items.length === 0 && empty) return <>{empty}</>;
  return (
    <ItemGroup aria-label={label} className={cn("gap-2", className)} {...props}>
      {items.map((item) => (
        <Item
          {...itemProps}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
          role="listitem"
          key={item.id}
          variant="outline"
          size="sm"
          data-membership-id={item.id}
          data-class={item.memberClass}
          data-status={item.status}
          data-basis={item.basis}
        >
          <ItemContent className="min-w-0">
            <ItemTitle className="flex-wrap">
              {item.classLabel}
              <StatusBadge tone={membershipStatusTone(item.status)}>{item.statusLabel}</StatusBadge>
            </ItemTitle>
            <ItemDescription>
              {item.basisLabel}
              {item.since ? <> · {item.since}</> : null}
            </ItemDescription>
          </ItemContent>
          {item.exit ? (
            <ItemActions>
              <ConfirmedActionButton action={item.exit} />
            </ItemActions>
          ) : null}
        </Item>
      ))}
    </ItemGroup>
  );
}

export interface EligibilityProgress {
  /** Names the meter ("Streaming hours, last 30 days"). */
  label: string;
  have: number;
  need: number;
  /** `hours` or `cents`; set as `data-unit`. */
  unit: string;
  /** "12.5 of 20 hours" / "$0.00 of $25.00". */
  valueText: React.ReactNode;
}

export interface EligibilityItem {
  /** `MEMBER_CLASSES` value; set as `data-class`. */
  memberClass: string;
  classLabel: React.ReactNode;
  eligible: boolean;
  /** "Eligible" / "Not yet". */
  statusLabel: string;
  /** The basis the class would use now (`data-basis`, empty when none). */
  basis: string | null;
  basisLabel?: React.ReactNode;
  progress: EligibilityProgress | null;
  /** The API's `detail` text, translated. */
  detail?: React.ReactNode;
}

export interface EligibilityListProps extends Omit<React.ComponentProps<"ul">, "children"> {
  items: readonly EligibilityItem[];
  /** Set on every class besides its `data-*` (e.g. `{ "data-testid": "membership-eligibility" }`). */
  itemProps?: DataAttributes;
}

/** Per class: eligible or not, the basis, a progress meter toward the threshold, and the detail. */
export function EligibilityList({ items, itemProps, className, ...props }: EligibilityListProps): React.JSX.Element {
  return (
    <ul className={cn("grid min-w-0 gap-3 sm:grid-cols-3", className)} {...props}>
      {items.map((item) => {
        const progress = item.progress;
        const percent = progress && progress.need > 0 ? (progress.have / progress.need) * 100 : item.eligible ? 100 : 0;
        return (
          <li
            {...itemProps}
            key={item.memberClass}
            data-class={item.memberClass}
            data-eligible={String(item.eligible)}
            data-basis={item.basis ?? ""}
            data-have={progress?.have ?? ""}
            data-need={progress?.need ?? ""}
            data-unit={progress?.unit ?? ""}
            className="flex min-w-0 flex-col gap-2 border p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium">{item.classLabel}</span>
              <StatusBadge tone={item.eligible ? "success" : "neutral"} icon={item.eligible ? Tick02Icon : undefined}>
                {item.statusLabel}
              </StatusBadge>
            </div>
            {item.basisLabel ? <span className="text-xs text-muted-foreground">{item.basisLabel}</span> : null}
            {progress ? (
              <ProgressRow
                label={progress.label}
                value={percent}
                valueText={progress.valueText}
                tone={item.eligible ? "success" : "default"}
              />
            ) : null}
            {item.detail ? <p className="text-xs text-muted-foreground">{item.detail}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface ShareInstructionsProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  title: React.ReactNode;
  /** The provider's instructions text. */
  instructions: React.ReactNode;
  amount: MoneyValue;
  amountLabel: React.ReactNode;
  /** The `CA-…` payment reference. */
  reference: string;
  referenceLabel: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  paymentId: string;
  locale?: string;
}

/** After buying the share (manual provider): how to pay, the amount and the copyable reference. */
export function ShareInstructions({
  title,
  instructions,
  amount,
  amountLabel,
  reference,
  referenceLabel,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
  paymentId,
  locale,
  className,
  ...props
}: ShareInstructionsProps): React.JSX.Element {
  return (
    <div
      data-reference={reference}
      data-payment-id={paymentId}
      data-cents={amount.cents}
      className={cn("flex min-w-0 flex-col gap-3 border border-info p-3", className)}
      {...props}
    >
      <p className="text-xs font-medium text-info">{title}</p>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{amountLabel}</span>
        <MoneyAmount value={amount} locale={locale} className="font-medium" />
      </div>
      <CopyField
        label={referenceLabel}
        value={reference}
        copyLabel={copyLabel}
        copiedLabel={copiedLabel}
        copyFailedLabel={copyFailedLabel}
      />
      <div className="text-xs/relaxed whitespace-pre-line wrap-anywhere text-muted-foreground">{instructions}</div>
    </div>
  );
}

export interface ShareCardProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `none` (no share) or a `SHARE_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  /** The share amount (held or price to buy); its cents are set as `data-cents`. */
  amount: MoneyValue | null;
  amountLabel?: React.ReactNode;
  /** Explains the state ("Refundable when you leave", "Waiting for your payment"). */
  note?: React.ReactNode;
  /** Buy the share; omit to hide (pending/held share or an existing viewer membership). */
  buy?: { label: string; onBuy: () => void | Promise<void>; pending?: boolean; props?: DataAttributes };
  /** `<ShareInstructions>` after buying. */
  instructions?: React.ReactNode;
  locale?: string;
}

/** The member share: status, amount, buy action and (after buying) the manual payment instructions. */
export function ShareCard({
  title,
  description,
  status,
  statusLabel,
  amount,
  amountLabel,
  note,
  buy,
  instructions,
  locale,
  className,
  ...props
}: ShareCardProps): React.JSX.Element {
  return (
    <Card
      size="sm"
      data-status={status}
      data-cents={amount?.cents ?? ""}
      className={cn("min-w-0", className)}
      {...props}
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        <CardAction>
          <StatusBadge tone={shareStatusTone(status)}>{statusLabel}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {amount ? (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            {amountLabel ? <span className="text-xs text-muted-foreground">{amountLabel}</span> : null}
            <MoneyAmount value={amount} locale={locale} className="text-lg font-semibold" />
          </div>
        ) : null}
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        {instructions}
      </CardContent>
      {buy ? (
        <CardFooter className="justify-end">
          <Button
            {...buy.props}
            type="button"
            size="sm"
            disabled={buy.pending}
            aria-busy={buy.pending || undefined}
            onClick={() => void buy.onBuy()}
          >
            {buy.label}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export { ConfirmedActionButton };
