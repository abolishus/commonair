// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ConfirmDialog,
  EmptyState,
  MoneyAmount,
  RelativeTime,
  StatusBadge,
  formatMoney,
  useLocale,
} from "@commonair/ui";
import { DataTable, FilterBar, type DataTableColumn } from "@commonair/ui/blocks/data";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { AmountField, FormSection, SwitchField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { Invoice01Icon, MoneyReceive01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  COST_CATEGORY,
  COST_CATEGORY_MAX,
  COST_DESCRIPTION_MAX,
  DISPUTE_REASON_MAX,
  PAYOUT_REFERENCE_MAX,
  REFERENCE_SEARCH_MAX,
  canDispute,
  disputeAmountError,
  holdReasonLabel,
  paymentDescription,
  paymentStatusBadge,
  payoutStatusBadge,
  refundableCents,
  type TreasurerPaymentDto,
  type TreasurerPayoutDto,
} from "../../lib/money.ts";

/**
 * `/treasury` pieces. Each takes its data and actions as props (the route wires them to
 * `money.treasurer.*`), so tests/selectors-render.test.tsx can server-render them with fixtures.
 * Actions resolve on success and reject on failure; the pieces toast either way.
 */

export type TreasuryTab = "payments" | "payouts" | "accounts" | "costs";
export type DisputeKind = "refund" | "chargeback";

export interface TreasuryTabsProps {
  value: TreasuryTab;
  onValueChange: (tab: TreasuryTab) => void;
  payments: React.ReactNode;
  payouts: React.ReactNode;
  accounts: React.ReactNode;
  costs: React.ReactNode;
}

const TABS: readonly TreasuryTab[] = ["payments", "payouts", "accounts", "costs"];
const isTab = (value: unknown): value is TreasuryTab => TABS.some((tab) => tab === value);

/*
 * Tabs parts rather than PageTabs: the tabs need the spec's `treasury-tab-*` test ids, which
 * PageTabs does not forward yet (contract request to the head agent).
 */
export function TreasuryTabs({ value, onValueChange, ...panels }: TreasuryTabsProps): React.JSX.Element {
  return (
    <Tabs value={value} onValueChange={(next) => isTab(next) && onValueChange(next)}>
      <div className="min-w-0 overflow-x-auto">
        <TabsList variant="line" className="min-w-max">
          <TabsTrigger value="payments" data-testid="treasury-tab-payments">
            {t("treasury.tab.payments")}
          </TabsTrigger>
          <TabsTrigger value="payouts" data-testid="treasury-tab-payouts">
            {t("treasury.tab.payouts")}
          </TabsTrigger>
          <TabsTrigger value="accounts" data-testid="treasury-tab-accounts">
            {t("treasury.tab.accounts")}
          </TabsTrigger>
          <TabsTrigger value="costs" data-testid="treasury-tab-costs">
            {t("treasury.tab.costs")}
          </TabsTrigger>
        </TabsList>
      </div>
      {TABS.map((tab) => (
        <TabsContent key={tab} value={tab} className="flex flex-col gap-4 pt-4">
          {panels[tab]}
        </TabsContent>
      ))}
    </Tabs>
  );
}

// ── Payments ──────────────────────────────────────────────────────────────────────────────────

export interface PaymentsPanelProps {
  /** null while loading. */
  payments: TreasurerPaymentDto[] | null;
  search: string;
  onSearchChange: (value: string) => void;
  onConfirm: (payment: TreasurerPaymentDto) => Promise<void>;
  onDispute: (payment: TreasurerPaymentDto, kind: DisputeKind, amountCents: number, reason: string) => Promise<void>;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

// A variable, not an inline literal: a `data-testid` key in a literal is an excess property.
const searchInput = {
  "data-testid": "treasury-search",
  name: "reference",
  autoComplete: "off",
  spellCheck: false,
  maxLength: REFERENCE_SEARCH_MAX,
};

export function PaymentsPanel({
  payments,
  search,
  onSearchChange,
  onConfirm,
  onDispute,
  hasMore = false,
  onLoadMore,
}: PaymentsPanelProps): React.JSX.Element {
  const columns: DataTableColumn<TreasurerPaymentDto>[] = [
    {
      id: "reference",
      header: t("treasury.payments.reference"),
      cell: ({ row: { original: p } }) => <span className="tabular-nums">{p.reference}</span>,
    },
    { id: "what", header: t("treasury.payments.what"), cell: ({ row: { original: p } }) => paymentDescription(p) },
    {
      id: "who",
      header: t("treasury.payments.who"),
      cell: ({ row: { original: p } }) =>
        [
          p.user?.username ?? t("treasury.payments.noUser"),
          p.channelSlug ? t("treasury.payments.to", { channel: p.channelSlug }) : "",
        ]
          .filter((s) => s !== "")
          .join(t("money.detailSeparator")),
    },
    {
      id: "amount",
      header: t("treasury.payments.amount"),
      align: "numeric",
      cell: ({ row: { original: p } }) => <MoneyAmount value={p.amount} />,
    },
    {
      id: "status",
      header: t("treasury.payments.status"),
      cell: ({ row: { original: p } }) => {
        const badge = paymentStatusBadge(p.status);
        return <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>;
      },
    },
    {
      id: "created",
      header: t("treasury.payments.created"),
      cell: ({ row: { original: p } }) => <RelativeTime date={p.createdAt} />,
    },
    {
      id: "actions",
      header: t("treasury.actions"),
      cell: ({ row: { original: p } }) => <PaymentActions payment={p} onConfirm={onConfirm} onDispute={onDispute} />,
    },
  ];
  return (
    <>
      <FilterBar
        searchLabel={t("treasury.search")}
        searchValue={search}
        onSearchChange={onSearchChange}
        searchInputProps={searchInput}
      />
      <DataTable
        caption={search ? t("treasury.payments.searchCaption") : t("treasury.payments.pendingCaption")}
        columns={columns}
        rows={payments ?? []}
        loading={payments === null}
        loadingRows={3}
        getRowId={(p) => p.paymentId}
        rowProps={(p) => ({
          "data-testid": "treasury-payment-row",
          "data-payment-id": p.paymentId,
          "data-reference": p.reference,
          "data-status": p.status,
          "data-kind": p.kind,
          "data-cents": p.amount.cents,
          "data-refunded": p.refunded.cents,
        })}
        empty={
          <EmptyState
            icon={MoneyReceive01Icon}
            title={search ? t("treasury.payments.noMatch") : t("treasury.payments.empty")}
            description={search ? t("treasury.payments.noMatchHint") : t("treasury.payments.emptyHint")}
            headingLevel={3}
          />
        }
        footer={hasMore && onLoadMore ? <LoadMore onClick={onLoadMore} /> : undefined}
      />
    </>
  );
}

function LoadMore({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      {t("treasury.loadMore")}
    </Button>
  );
}

function PaymentActions({
  payment,
  onConfirm,
  onDispute,
}: {
  payment: TreasurerPaymentDto;
  onConfirm: PaymentsPanelProps["onConfirm"];
  onDispute: PaymentsPanelProps["onDispute"];
}): React.JSX.Element | null {
  const { locale } = useLocale();
  if (payment.status === "pending") {
    const amount = formatMoney(payment.amount.cents, payment.amount.currency, locale);
    return (
      <ConfirmDialog
        trigger={
          <Button
            data-testid="treasury-confirm"
            size="sm"
            aria-label={t("treasury.confirm.label", { reference: payment.reference })}
          >
            {t("treasury.confirm")}
          </Button>
        }
        title={t("treasury.confirm.title", { reference: payment.reference })}
        description={t("treasury.confirm.body", { amount })}
        confirmLabel={t("treasury.confirm")}
        onConfirm={async () => {
          await onConfirm(payment);
          toast.success(t("treasury.confirm.done"));
        }}
        onError={(err) => toastActionError(err, t("treasury.confirm.failed"))}
      />
    );
  }
  if (!canDispute(payment)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <DisputeDialog payment={payment} kind="refund" onSubmit={onDispute} />
      <DisputeDialog payment={payment} kind="chargeback" onSubmit={onDispute} />
    </div>
  );
}

export function DisputeDialog({
  payment,
  kind,
  onSubmit,
}: {
  payment: TreasurerPaymentDto;
  kind: DisputeKind;
  onSubmit: PaymentsPanelProps["onDispute"];
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  // A fresh form (amount = the refundable rest, empty reason) every time the dialog opens.
  const [generation, setGeneration] = React.useState(0);
  const refund = kind === "refund";
  const trigger = refund ? (
    <Button
      data-testid="treasury-refund"
      variant="outline"
      size="sm"
      aria-label={t("treasury.refund.label", { reference: payment.reference })}
    />
  ) : (
    <Button
      data-testid="treasury-chargeback"
      variant="destructive"
      size="sm"
      aria-label={t("treasury.chargeback.label", { reference: payment.reference })}
    />
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) setGeneration((g) => g + 1);
      }}
    >
      <DialogTrigger render={trigger}>{refund ? t("treasury.refund") : t("treasury.chargeback")}</DialogTrigger>
      <DialogContent>
        <DisputeForm
          key={generation}
          payment={payment}
          kind={kind}
          onPendingChange={setPending}
          onSubmit={async (amountCents, reason) => {
            await onSubmit(payment, kind, amountCents, reason);
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The refund / chargeback form inside its dialog. */
export function DisputeForm({
  payment,
  kind,
  onSubmit,
  onPendingChange,
}: {
  payment: TreasurerPaymentDto;
  kind: DisputeKind;
  onSubmit: (amountCents: number, reason: string) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  const refundable = refundableCents(payment);
  const [amount, setAmount] = React.useState(refundable);
  const [reason, setReason] = React.useState("");
  const [pending, setPendingState] = React.useState(false);
  const amountError = disputeAmountError(amount, refundable);
  const reasonId = React.useId();
  const refund = kind === "refund";
  // A variable, not an inline literal: a `data-testid` key in a literal is an excess property.
  const amountInput = { "data-testid": "treasury-dispute-amount", name: "amount" };
  const setPending = (next: boolean) => {
    setPendingState(next);
    onPendingChange?.(next);
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (amountError || pending) return;
    setPending(true);
    try {
      await onSubmit(amount, reason.trim());
      toast.success(refund ? t("treasury.refund.done") : t("treasury.chargeback.done"));
    } catch (err) {
      toastActionError(err, refund ? t("treasury.refund.failed") : t("treasury.chargeback.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>
          {refund
            ? t("treasury.refund.title", { reference: payment.reference })
            : t("treasury.chargeback.title", { reference: payment.reference })}
        </DialogTitle>
        <DialogDescription>{refund ? t("treasury.refund.body") : t("treasury.chargeback.body")}</DialogDescription>
      </DialogHeader>
      <AmountField
        label={t("treasury.dispute.amount")}
        currency={payment.amount.currency}
        locale={locale}
        value={amount}
        min={1}
        max={refundable}
        rangeError={amountError}
        hint={t("treasury.dispute.amountHint", {
          amount: formatMoney(refundable, payment.amount.currency, locale),
        })}
        inputProps={amountInput}
        onValueChange={setAmount}
      />
      <Field>
        <FieldLabel htmlFor={reasonId}>{t("treasury.dispute.reason")}</FieldLabel>
        <Textarea
          id={reasonId}
          data-testid="treasury-dispute-reason"
          value={reason}
          maxLength={DISPUTE_REASON_MAX}
          rows={3}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <FieldDescription>{t("treasury.dispute.reasonHint")}</FieldDescription>
      </Field>
      <DialogFooter>
        <Button
          data-testid="treasury-dispute-submit"
          type="submit"
          variant={refund ? "default" : "destructive"}
          disabled={amountError !== null || pending}
          aria-busy={pending || undefined}
        >
          {refund ? t("treasury.refund.submit") : t("treasury.chargeback.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── Payouts ───────────────────────────────────────────────────────────────────────────────────

export interface PayoutRunResult {
  created: number;
  held: number;
  total: { cents: number; currency: string };
}

export interface PayoutsPanelProps {
  payouts: TreasurerPayoutDto[] | null;
  result: PayoutRunResult | null;
  running: boolean;
  onRun: () => void;
  onMarkPaid: (payout: TreasurerPayoutDto, reference: string) => Promise<void>;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export function PayoutsPanel({
  payouts,
  result,
  running,
  onRun,
  onMarkPaid,
  hasMore = false,
  onLoadMore,
}: PayoutsPanelProps): React.JSX.Element {
  const columns: DataTableColumn<TreasurerPayoutDto>[] = [
    { id: "creator", header: t("treasury.payouts.creator"), cell: ({ row: { original: p } }) => p.user.username },
    {
      id: "amount",
      header: t("treasury.payouts.amount"),
      align: "numeric",
      cell: ({ row: { original: p } }) => <MoneyAmount value={p.amount} />,
    },
    {
      id: "status",
      header: t("treasury.payouts.status"),
      cell: ({ row: { original: p } }) => {
        const badge = payoutStatusBadge(p.status);
        return (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            {p.holdReason && <span className="text-xs text-muted-foreground">{holdReasonLabel(p.holdReason)}</span>}
          </div>
        );
      },
    },
    {
      id: "period",
      header: t("treasury.payouts.created"),
      cell: ({ row: { original: p } }) => <RelativeTime date={p.createdAt} />,
    },
    {
      id: "actions",
      header: t("treasury.actions"),
      cell: ({ row: { original: p } }) =>
        p.status === "pending" ? <MarkPaidDialog payout={p} onSubmit={onMarkPaid} /> : (p.reference ?? null),
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button data-testid="treasury-run-payouts" disabled={running} aria-busy={running || undefined} onClick={onRun}>
          {t("treasury.payouts.run")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("treasury.payouts.runHint")}</p>
      </div>
      {result && <PayoutResult result={result} />}
      <DataTable
        caption={t("treasury.payouts.caption")}
        columns={columns}
        rows={payouts ?? []}
        loading={payouts === null}
        loadingRows={3}
        getRowId={(p) => p.id}
        rowProps={(p) => ({
          "data-testid": "treasury-payout-row",
          "data-payout-id": p.id,
          "data-username": p.user.username,
          "data-status": p.status,
          "data-cents": p.amount.cents,
          "data-hold-reason": p.holdReason ?? "",
        })}
        empty={
          <EmptyState
            icon={Invoice01Icon}
            title={t("treasury.payouts.empty")}
            description={t("treasury.payouts.emptyHint")}
            headingLevel={3}
          />
        }
        footer={hasMore && onLoadMore ? <LoadMore onClick={onLoadMore} /> : undefined}
      />
    </>
  );
}

export function PayoutResult({ result }: { result: PayoutRunResult }): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <AlertCallout
      data-testid="treasury-payouts-result"
      data-created={result.created}
      data-held={result.held}
      data-cents={result.total.cents}
      tone="info"
      live
      title={t("treasury.payouts.result")}
      description={t("treasury.payouts.resultBody", {
        created: result.created,
        held: result.held,
        total: formatMoney(result.total.cents, result.total.currency, locale),
      })}
    />
  );
}

export function MarkPaidDialog({
  payout,
  onSubmit,
}: {
  payout: TreasurerPayoutDto;
  onSubmit: PayoutsPanelProps["onMarkPaid"];
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [generation, setGeneration] = React.useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) setGeneration((g) => g + 1);
      }}
    >
      <DialogTrigger
        render={
          <Button
            data-testid="treasury-mark-paid"
            size="sm"
            variant="outline"
            aria-label={t("treasury.markPaid.label", { username: payout.user.username })}
          />
        }
      >
        {t("treasury.markPaid")}
      </DialogTrigger>
      <DialogContent>
        <MarkPaidForm
          key={generation}
          payout={payout}
          onPendingChange={setPending}
          onSubmit={async (reference) => {
            await onSubmit(payout, reference);
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The mark-paid form inside its dialog. */
export function MarkPaidForm({
  payout,
  onSubmit,
  onPendingChange,
}: {
  payout: TreasurerPayoutDto;
  onSubmit: (reference: string) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  const [reference, setReference] = React.useState("");
  const [pending, setPendingState] = React.useState(false);
  const referenceId = React.useId();
  const valid = reference.trim() !== "";
  const setPending = (next: boolean) => {
    setPendingState(next);
    onPendingChange?.(next);
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      await onSubmit(reference.trim());
      toast.success(t("treasury.markPaid.done"));
    } catch (err) {
      toastActionError(err, t("treasury.markPaid.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("treasury.markPaid.title", { username: payout.user.username })}</DialogTitle>
        <DialogDescription>
          {t("treasury.markPaid.body", {
            amount: formatMoney(payout.amount.cents, payout.amount.currency, locale),
          })}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={referenceId}>{t("treasury.markPaid.reference")}</FieldLabel>
        <Input
          id={referenceId}
          data-testid="treasury-mark-paid-reference"
          value={reference}
          maxLength={PAYOUT_REFERENCE_MAX}
          autoComplete="off"
          onChange={(e) => setReference(e.currentTarget.value)}
        />
        <FieldDescription>{t("treasury.markPaid.referenceHint")}</FieldDescription>
      </Field>
      <DialogFooter>
        <Button
          data-testid="treasury-mark-paid-submit"
          type="submit"
          disabled={!valid || pending}
          aria-busy={pending || undefined}
        >
          {t("treasury.markPaid.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── Payout accounts and costs ─────────────────────────────────────────────────────────────────

export interface PayoutAccountInput {
  username: string;
  reference: string;
  payoutsEnabled: boolean;
}

const enabledSwitch = { "data-testid": "treasury-account-enabled" };

export function PayoutAccountForm({
  onSubmit,
}: {
  onSubmit: (input: PayoutAccountInput) => Promise<void>;
}): React.JSX.Element {
  const [username, setUsername] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const name = username.trim().toLowerCase();
  const valid = /^[a-z0-9_]{3,25}$/.test(name);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      await onSubmit({ username: name, reference: reference.trim(), payoutsEnabled: enabled });
      toast.success(t("treasury.account.saved"));
      setUsername("");
      setReference("");
    } catch (err) {
      toastActionError(err, t("treasury.account.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormSection
      title={t("treasury.account.title")}
      description={t("treasury.account.hint")}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <Field>
        <FieldLabel htmlFor="treasury-account-username">{t("treasury.account.username")}</FieldLabel>
        <Input
          id="treasury-account-username"
          data-testid="treasury-account-username"
          value={username}
          maxLength={25}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="treasury-account-reference">{t("treasury.account.reference")}</FieldLabel>
        <Input
          id="treasury-account-reference"
          data-testid="treasury-account-reference"
          value={reference}
          maxLength={PAYOUT_REFERENCE_MAX}
          autoComplete="off"
          onChange={(e) => setReference(e.currentTarget.value)}
        />
        <FieldDescription>{t("treasury.account.referenceHint")}</FieldDescription>
      </Field>
      <SwitchField
        label={t("treasury.account.enabled")}
        description={t("treasury.account.enabledHint")}
        checked={enabled}
        onCheckedChange={setEnabled}
        switchProps={enabledSwitch}
      />
      <div>
        <Button
          data-testid="treasury-account-submit"
          type="submit"
          disabled={!valid || pending}
          aria-busy={pending || undefined}
        >
          {t("treasury.account.submit")}
        </Button>
      </div>
    </FormSection>
  );
}

export interface CostInput {
  category: string;
  description: string;
  amountCents: number;
}

export function CostForm({
  currency,
  onSubmit,
}: {
  currency: string;
  onSubmit: (input: CostInput) => Promise<void>;
}): React.JSX.Element {
  const { locale } = useLocale();
  const [category, setCategory] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [amount, setAmount] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const slug = category.trim().toLowerCase();
  const categoryValid = COST_CATEGORY.test(slug);
  const amountValid = Number.isSafeInteger(amount) && amount > 0;
  // A variable, not an inline literal: a `data-testid` key in a literal is an excess property.
  const amountInput = { "data-testid": "treasury-cost-amount", name: "amount" };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!categoryValid || !amountValid || pending) return;
    setPending(true);
    try {
      await onSubmit({ category: slug, description: description.trim(), amountCents: amount });
      toast.success(t("treasury.cost.saved"));
      setCategory("");
      setDescription("");
      setAmount(0);
    } catch (err) {
      toastActionError(err, t("treasury.cost.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormSection
      title={t("treasury.cost.title")}
      description={t("treasury.cost.hint")}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <Field data-invalid={category !== "" && !categoryValid ? true : undefined}>
        <FieldLabel htmlFor="treasury-cost-category">{t("treasury.cost.category")}</FieldLabel>
        <Input
          id="treasury-cost-category"
          data-testid="treasury-cost-category"
          value={category}
          maxLength={COST_CATEGORY_MAX}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={category !== "" && !categoryValid ? true : undefined}
          onChange={(e) => setCategory(e.currentTarget.value)}
        />
        <FieldDescription>{t("treasury.cost.categoryHint")}</FieldDescription>
        {category !== "" && !categoryValid && <FieldError>{t("treasury.cost.categoryInvalid")}</FieldError>}
      </Field>
      <Field>
        <FieldLabel htmlFor="treasury-cost-description">{t("treasury.cost.description")}</FieldLabel>
        <Input
          id="treasury-cost-description"
          data-testid="treasury-cost-description"
          value={description}
          maxLength={COST_DESCRIPTION_MAX}
          autoComplete="off"
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </Field>
      <AmountField
        label={t("treasury.cost.amount")}
        currency={currency}
        locale={locale}
        value={amount}
        rangeError={null}
        hint={t("treasury.cost.amountHint")}
        inputProps={amountInput}
        onValueChange={setAmount}
      />
      <div>
        <Button
          data-testid="treasury-cost-submit"
          type="submit"
          disabled={!categoryValid || !amountValid || pending}
          aria-busy={pending || undefined}
        >
          {t("treasury.cost.submit")}
        </Button>
      </div>
    </FormSection>
  );
}
