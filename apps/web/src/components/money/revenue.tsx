// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MONEY_LIMITS } from "@commonair/contracts/currency";
import {
  EmptyState,
  MoneyAmount,
  RelativeTime,
  Skeleton,
  SkeletonGroup,
  StatusBadge,
  formatMoney,
  useLocale,
} from "@commonair/ui";
import {
  BarChart,
  BreakdownBar,
  DataTable,
  FilterBar,
  KeyValueList,
  StatCard,
  StatGrid,
  type DataTableColumn,
} from "@commonair/ui/blocks/data";
import { AmountField, FormSection } from "@commonair/ui/blocks/forms";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet, FieldLegend } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Progress } from "@commonair/ui/components/progress";
import { Textarea } from "@commonair/ui/components/textarea";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Download01Icon, Invoice01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  earnedDelta,
  payoutProgress,
  revenueLineBadge,
  tierDrafts,
  tiersInput,
  validateTiers,
  type MonthOption,
  type PayoutAccountDto,
  type RevenueLineDto,
  type RevenueSummaryDto,
  type SubTierDto,
  type TierDraft,
} from "../../lib/money.ts";
import { payoutView } from "../studio-money/payout.ts";
import { ledgerReference } from "../studio-money/reconcile.ts";
import { ResponsiveRows, type StackedRow } from "../studio/stacked-rows.tsx";
import { formatDayLabel, revenueTrend } from "../studio/trends.ts";
import { BreakdownOpenButton } from "./breakdown-dialog.tsx";

/**
 * `/revenue` pieces (Revenue board). Each takes its data as props, so tests/selectors-render.test.tsx
 * can server-render them with fixtures; the route file loads the data.
 */

export interface RevenueMonthFilterProps {
  value: string;
  options: MonthOption[];
  onValueChange: (month: string) => void;
}

/** The month picker (`revenue-month`); option values are `YYYY-MM`. */
export function RevenueMonthFilter({ value, options, onValueChange }: RevenueMonthFilterProps): React.JSX.Element {
  return (
    <FilterBar
      filters={[
        {
          id: "revenue-month-filter",
          label: t("revenue.month"),
          value,
          options,
          onValueChange,
          "data-testid": "revenue-month",
        },
      ]}
    />
  );
}

export function RevenueStatsSkeleton(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("revenue.loading")}>
      <StatGrid cols={4}>
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </StatGrid>
    </SkeletonGroup>
  );
}

/**
 * The month's tiles (CS-9): what was earned and paid out this month, then the balances now
 * (available toward the payout minimum, held, and owed in the destructive tone, not amber).
 * `RevenueReconcile` beside them shows how earned adds up.
 */
export function RevenueStats({ summary }: { summary: RevenueSummaryDto }): React.JSX.Element {
  const { locale } = useLocale();
  const { available, held, owed, minimumPayout, holdDays } = summary.balance;
  const delta = earnedDelta(summary.net, summary.previousNet, locale);
  const minimum = formatMoney(minimumPayout.cents, minimumPayout.currency, locale);
  return (
    <StatGrid cols={owed.cents > 0 ? 3 : 4}>
      <StatCard
        data-testid="revenue-earned"
        data-cents={summary.net.cents}
        data-previous={summary.previousNet.cents}
        label={t("revenue.earned")}
        value={<MoneyAmount value={summary.net} colorNegative />}
        delta={delta}
      />
      <StatCard
        data-testid="revenue-paid-out"
        data-cents={summary.paidOut.cents}
        label={t("d5Money.revenue.paidOut")}
        value={<MoneyAmount value={summary.paidOut} />}
        hint={t("d5Money.revenue.paidOutHint")}
      />
      <StatCard
        data-testid="revenue-available"
        data-cents={available.cents}
        data-minimum={minimumPayout.cents}
        label={t("revenue.available")}
        value={<MoneyAmount value={available} />}
        hint={t("revenue.availableHint", { minimum })}
        footer={
          <Progress
            aria-label={t("revenue.availableProgress")}
            value={payoutProgress(available.cents, minimumPayout.cents)}
          />
        }
      />
      <StatCard
        data-testid="revenue-held"
        data-cents={held.cents}
        label={t("revenue.held")}
        value={<MoneyAmount value={held} />}
        hint={t("revenue.heldHint", { days: holdDays })}
      />
      {owed.cents > 0 && (
        <StatCard
          data-testid="revenue-owed"
          data-cents={owed.cents}
          tone="destructive"
          label={t("revenue.owed")}
          value={<MoneyAmount value={owed} />}
          hint={t("revenue.owedHint")}
        />
      )}
    </StatGrid>
  );
}

/**
 * The month's earnings by day as bars (D5.6: sparse daily money is bars, not lines), whole
 * currency units on the axis, with the same figures in a table behind a toggle.
 */
export function RevenueTrend({ summary }: { summary: RevenueSummaryDto }): React.JSX.Element {
  const { locale } = useLocale();
  const currency = summary.net.currency;
  const rows = revenueTrend({ from: summary.periodStart, to: summary.periodEnd }, summary.daily);
  const any = rows.some((r) => r.gross !== 0 || r.net !== 0);
  return (
    <Card data-testid="revenue-trend" data-days={rows.length}>
      <CardHeader>
        <CardTitle>{t("d5Money.trend.title")}</CardTitle>
        <CardDescription>{t("d5Money.trend.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {any ? (
          <BarChart
            data={rows.map((r) => ({ key: r.date, label: formatDayLabel(r.date, locale), value: r.net }))}
            ariaLabel={t("d5Money.trend.title")}
            seriesLabel={t("d5Money.trend.series")}
            formatValue={(cents) => formatMoney(cents, currency, locale)}
            minStep={100}
            locale={locale}
            table={{
              caption: t("d5Money.trend.title"),
              categoryHeader: t("studio.trend.day"),
              showLabel: t("studio.trend.showTable"),
            }}
          />
        ) : (
          <EmptyState
            icon={Invoice01Icon}
            title={t("studio.trend.revenueEmpty")}
            description={t("studio.trend.revenueEmptyHint")}
            headingLevel={3}
          />
        )}
      </CardContent>
    </Card>
  );
}

const SOURCES = ["subscriptions", "gifts", "tips"] as const;

export function RevenueSources({ summary }: { summary: RevenueSummaryDto }): React.JSX.Element {
  const { locale } = useLocale();
  const currency = summary.net.currency;
  const labels = {
    subscriptions: t("revenue.source.subscriptions"),
    gifts: t("revenue.source.gifts"),
    tips: t("revenue.source.tips"),
  };
  const segments = SOURCES.map((source) => ({
    id: source,
    label: labels[source],
    value: summary.bySource[source],
    attributes: { "data-testid": "revenue-source", "data-source": source, "data-cents": summary.bySource[source] },
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("revenue.bySource")}</CardTitle>
        <CardDescription>{t("revenue.bySourceHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <BreakdownBar
          label={t("revenue.bySource")}
          segments={segments}
          formatValue={(cents) => formatMoney(cents, currency, locale)}
          formatLabel={(items, shares) =>
            items
              .map((item, i) => t("money.shareLabel", { label: item.label, share: shares[i] ?? 0 }))
              .join(t("common.listSeparator"))
          }
        />
      </CardContent>
    </Card>
  );
}

type TierRow = RevenueSummaryDto["tiers"][number];

export function RevenueTiers({ summary }: { summary: RevenueSummaryDto }): React.JSX.Element {
  const total = summary.tiers.reduce((sum, row) => sum + row.active, 0);
  const columns: DataTableColumn<TierRow>[] = [
    {
      id: "tier",
      header: t("revenue.tierColumn"),
      cell: ({ row }) => t("money.tierName", { tier: row.original.tier }),
    },
    { id: "active", header: t("revenue.activeColumn"), align: "numeric", cell: ({ row }) => row.original.active },
    {
      id: "share",
      header: t("revenue.monthlyShareColumn"),
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={row.original.monthlyShare} />,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("revenue.subscribers")}</CardTitle>
        <CardAction>
          <StatusBadge tone="neutral">{t("revenue.subscribersTotal", { count: total })}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTable
          caption={t("revenue.subscribersCaption")}
          columns={columns}
          rows={summary.tiers}
          getRowId={(row) => String(row.tier)}
          rowProps={(row) => ({
            "data-testid": "revenue-tier-row",
            "data-tier": row.tier,
            "data-active": row.active,
            "data-cents": row.monthlyShare.cents,
          })}
          empty={
            <EmptyState
              title={t("revenue.subscribersEmpty")}
              description={t("studio.empty.subscribersHint")}
              headingLevel={3}
              action={<SetUpTiersButton />}
            />
          }
        />
      </CardContent>
    </Card>
  );
}

/** The revenue empties' way forward: the subscription tiers form below (F25). */
function SetUpTiersButton(): React.JSX.Element {
  return (
    <Button
      data-testid="empty-state-action"
      size="sm"
      nativeButton={false}
      render={<a href={`#${TIERS_FORM_ID}`} aria-label={t("studio.empty.setUpTiers")} />}
    >
      {t("studio.empty.setUpTiers")}
    </Button>
  );
}

/** The tier form's id, the target of "Set up subscription tiers". */
export const TIERS_FORM_ID = "revenue-tiers-form";

export interface RevenueLedgerProps {
  /** null while the first page loads. */
  lines: RevenueLineDto[] | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  downloading: boolean;
  onDownload: () => void;
}

const signed = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? "" : String(cents);

export function RevenueLedger({
  lines,
  hasMore,
  loadingMore,
  onLoadMore,
  downloading,
  onDownload,
}: RevenueLedgerProps): React.JSX.Element {
  const columns: DataTableColumn<RevenueLineDto>[] = [
    {
      id: "date",
      header: t("revenue.ledger.date"),
      cell: ({ row }) => <RelativeTime date={row.original.occurredAt} />,
    },
    {
      id: "type",
      header: t("revenue.ledger.type"),
      cell: ({ row }) => {
        const badge = revenueLineBadge(row.original.type);
        return <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>;
      },
    },
    {
      id: "detail",
      header: t("revenue.ledger.detail"),
      cell: ({ row: { original: line } }) => ledgerDetail(line),
    },
    {
      id: "gross",
      header: t("revenue.ledger.gross"),
      align: "numeric",
      cell: ({ row }) => (row.original.gross ? <MoneyAmount value={row.original.gross} colorNegative /> : null),
    },
    {
      id: "deductions",
      header: t("revenue.ledger.deductions"),
      align: "numeric",
      cell: ({ row }) =>
        row.original.deductions ? <MoneyAmount value={row.original.deductions} colorNegative /> : null,
    },
    {
      id: "net",
      header: t("revenue.ledger.net"),
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={row.original.net} colorNegative />,
    },
    {
      id: "breakdown",
      header: t("breakdown.payments.details"),
      // Payments and their reversals open the payment's breakdown; payouts have none.
      cell: ({ row }) => (row.original.paymentId ? <BreakdownOpenButton paymentId={row.original.paymentId} /> : null),
    },
  ];
  return (
    <Section
      heading={t("revenue.ledger.title")}
      description={t("revenue.ledger.hint")}
      action={
        <Button
          data-testid="revenue-statement-csv"
          variant="outline"
          size="sm"
          disabled={downloading}
          aria-busy={downloading || undefined}
          onClick={onDownload}
        >
          <HugeiconsIcon icon={Download01Icon} strokeWidth={2} aria-hidden />
          {t("revenue.ledger.csv")}
        </Button>
      }
    >
      <ResponsiveRows
        label={t("revenue.ledger.title")}
        rows={lines?.map((line) => ledgerStackedRow(line)) ?? null}
        footer={
          hasMore ? (
            <Button
              data-testid="revenue-ledger-more-stacked"
              variant="outline"
              size="sm"
              disabled={loadingMore}
              aria-busy={loadingMore || undefined}
              onClick={onLoadMore}
            >
              {t("revenue.ledger.more")}
            </Button>
          ) : undefined
        }
        table={
          <DataTable
            caption={t("revenue.ledger.title")}
            columns={columns}
            rows={lines ?? []}
            loading={lines === null}
            loadingRows={3}
            getRowId={(line) => line.id}
            rowProps={(line) => ({
              "data-testid": "revenue-ledger-row",
              "data-transaction-id": line.id,
              "data-type": line.type,
              "data-tier": line.tier ?? "",
              "data-quantity": line.quantity,
              "data-gross": signed(line.gross?.cents),
              "data-deductions": signed(line.deductions?.cents),
              "data-net": line.net.cents,
            })}
            empty={
              <EmptyState
                icon={Invoice01Icon}
                title={t("revenue.ledger.empty")}
                description={t("revenue.ledger.emptyHint")}
                headingLevel={3}
                action={<SetUpTiersButton />}
              />
            }
            footer={
              hasMore ? (
                <Button
                  data-testid="revenue-ledger-more"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  aria-busy={loadingMore || undefined}
                  onClick={onLoadMore}
                >
                  {t("revenue.ledger.more")}
                </Button>
              ) : undefined
            }
          />
        }
      />
    </Section>
  );
}

/** One ledger line as a stacked row at phone width (F31): date and type, detail, net, breakdown. */
function ledgerStackedRow(line: RevenueLineDto): StackedRow {
  const badge = revenueLineBadge(line.type);
  const detail = ledgerDetail(line);
  return {
    id: line.id,
    attributes: {
      "data-testid": "revenue-ledger-stacked-row",
      "data-transaction-id": line.id,
      "data-net": line.net.cents,
    },
    title: (
      <span className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        <RelativeTime date={line.occurredAt} className="font-normal text-muted-foreground" />
      </span>
    ),
    value: <MoneyAmount value={line.net} colorNegative />,
    details: (
      <>
        {detail && <span className="break-words">{detail}</span>}
        {(line.gross || line.deductions) && (
          // Term/value pairs, not "label: value" text, so no punctuation sits outside the catalog.
          <KeyValueList
            dense
            rows={[
              ...(line.gross
                ? [{ term: t("revenue.ledger.gross"), value: <MoneyAmount value={line.gross} colorNegative /> }]
                : []),
              ...(line.deductions
                ? [
                    {
                      term: t("revenue.ledger.deductions"),
                      value: <MoneyAmount value={line.deductions} colorNegative />,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </>
    ),
    actions: line.paymentId ? <BreakdownOpenButton paymentId={line.paymentId} /> : undefined,
  };
}

/**
 * Supporter, tier and quantity, then the reference: "Card payment" for a processor payment (its
 * id stays in the breakdown dialog), a short bank or payout reference, never a raw `pi_…` id.
 */
export function ledgerDetail(line: RevenueLineDto): string {
  const who = line.from?.displayName ?? (line.type === "payout" ? "" : t("revenue.ledger.anonymous"));
  const ref = ledgerReference(line);
  const parts = [
    who,
    line.tier !== null ? t("money.tierName", { tier: line.tier }) : "",
    line.quantity > 1 ? t("revenue.ledger.quantity", { count: line.quantity }) : "",
    ref === null
      ? ""
      : ref.kind === "card"
        ? t("d5Money.ledger.cardPayment")
        : t("d5Money.ledger.reference", { reference: ref.text }),
  ];
  return parts.filter((p) => p !== "").join(t("money.detailSeparator"));
}

/** The payout card's id, so the setup section can point at it. */
export const PAYOUT_CARD_ID = "revenue-payout-account";

/**
 * The payout account (CS-9): one status, one explanation, at most one action. Ready says payouts
 * are on; an unfinished Connect account offers "Set up payouts"; a manual arrangement shows the
 * treasurer's instructions; otherwise it says the treasurer sets it up. `minimum` is the payout
 * minimum, formatted, once the summary has loaded.
 */
export function PayoutAccountCard({
  account,
  minimum,
}: {
  account: PayoutAccountDto;
  minimum?: string;
}): React.JSX.Element {
  const view = payoutView(account);
  const explanation = {
    ready: minimum ? t("d5Money.payout.readyMinimum", { minimum }) : t("d5Money.payout.ready"),
    connect: t("d5Money.payout.connect"),
    manual: t("d5Money.payout.manual"),
    waiting: t("d5Money.payout.waiting"),
  }[view.state];
  return (
    <Card
      id={PAYOUT_CARD_ID}
      data-testid="revenue-payout-account"
      data-provider={account.provider}
      data-enabled={String(account.payoutsEnabled)}
      data-state={view.state}
    >
      <CardHeader>
        <CardTitle>{t("revenue.payout.title")}</CardTitle>
        <CardDescription>{explanation}</CardDescription>
        <CardAction>
          <StatusBadge tone={view.tone}>{t(view.status)}</StatusBadge>
        </CardAction>
      </CardHeader>
      {view.instructions || view.onboardingUrl ? (
        <CardContent className="flex flex-col gap-3">
          {view.instructions && <p className="text-sm whitespace-pre-line">{view.instructions}</p>}
          {view.onboardingUrl && (
            <div>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={view.onboardingUrl} rel="noopener" aria-label={t("revenue.payout.onboard")} />}
              >
                {t("revenue.payout.onboard")}
              </Button>
            </div>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

export interface TierEditorProps {
  tiers: SubTierDto[];
  currency: string;
  /** Saves and resolves with the stored tiers; a rejection is shown as a toast. */
  onSave: (tiers: SubTierDto[]) => Promise<SubTierDto[]>;
}

export function TierEditor({ tiers, currency, onSave }: TierEditorProps): React.JSX.Element {
  const [drafts, setDrafts] = React.useState<TierDraft[]>(() => tierDrafts(tiers));
  const [pending, setPending] = React.useState(false);
  // Price inputs whose typed text does not parse yet (their cents are stale until it does).
  const [unparsed, setUnparsed] = React.useState<ReadonlySet<TierDraft["tier"]>>(() => new Set());
  // Bumped after a save, so the price inputs drop any typed text and show the stored prices.
  const [generation, setGeneration] = React.useState(0);
  const errors = validateTiers(drafts);
  const valid = Object.keys(errors).length === 0 && unparsed.size === 0;
  // F32: a field's error shows once the field has been left (blur) or the form submitted, never
  // on first load (a new streamer's empty tiers are not a mistake yet).
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = React.useState(false);
  const touch = (key: string) => setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  const shown = (tier: TierDraft["tier"]): { name?: string; price?: string; benefits?: string } => {
    const all = errors[tier] ?? {};
    const visible = (field: "name" | "price" | "benefits") => submitted || touched.has(`${tier}.${field}`);
    return {
      ...(all.name && visible("name") ? { name: all.name } : {}),
      ...(all.price && visible("price") ? { price: all.price } : {}),
      ...(all.benefits && visible("benefits") ? { benefits: all.benefits } : {}),
    };
  };
  const onPriceValidity = (tier: TierDraft["tier"], ok: boolean) =>
    setUnparsed((prev) => {
      if (prev.has(tier) !== ok) return prev;
      const next = new Set(prev);
      if (ok) next.delete(tier);
      else next.add(tier);
      return next;
    });
  const update = (tier: TierDraft["tier"], patch: Partial<TierDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.tier === tier ? { ...d, ...patch } : d)));

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
    if (!valid || pending) return;
    setPending(true);
    try {
      const saved = await onSave(tiersInput(drafts, currency));
      setDrafts(tierDrafts(saved));
      setGeneration((g) => g + 1);
      setTouched(new Set());
      setSubmitted(false);
      toast.success(t("revenue.tiers.saved"));
    } catch (err) {
      toastActionError(err, t("revenue.tiers.saveFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormSection
      data-testid="revenue-tiers"
      title={t("revenue.tiers.title")}
      description={t("revenue.tiers.hint")}
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      id={TIERS_FORM_ID}
      tabIndex={-1}
    >
      <ResponsiveGrid cols={3}>
        {drafts.map((draft) => (
          <TierFields
            key={`${draft.tier}-${generation}`}
            draft={draft}
            currency={currency}
            errors={shown(draft.tier)}
            onBlurField={(field) => touch(`${draft.tier}.${field}`)}
            onChange={(patch) => update(draft.tier, patch)}
            onPriceValidity={(ok) => onPriceValidity(draft.tier, ok)}
          />
        ))}
      </ResponsiveGrid>
      {/* FormSection's own submit takes no test id, so the button is ours. */}
      <div>
        <Button
          data-testid="revenue-tiers-save"
          type="submit"
          // Invalid fields do not disable it: submitting shows what to fix (F32). A price that does
          // not parse yet does, since its cents are stale until it does.
          disabled={unparsed.size > 0 || pending}
          aria-busy={pending || undefined}
        >
          {t("revenue.tiers.save")}
        </Button>
      </div>
    </FormSection>
  );
}

// Variables, not inline literals: a `data-testid` key in a literal is an excess property.
const PRICE_INPUTS: Record<TierDraft["tier"], { "data-testid": string; name: string }> = {
  1: { "data-testid": "revenue-tier-price-1", name: "tier-1-price" },
  2: { "data-testid": "revenue-tier-price-2", name: "tier-2-price" },
  3: { "data-testid": "revenue-tier-price-3", name: "tier-3-price" },
};

function TierFields({
  draft,
  currency,
  errors,
  onChange,
  onBlurField,
  onPriceValidity,
}: {
  draft: TierDraft;
  currency: string;
  errors: { name?: string; price?: string; benefits?: string };
  onChange: (patch: Partial<TierDraft>) => void;
  onBlurField: (field: "name" | "price" | "benefits") => void;
  onPriceValidity: (valid: boolean) => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  const n = draft.tier;
  const nameId = `revenue-tier-name-${n}`;
  const benefitsId = `revenue-tier-benefits-${n}`;
  const priceInput = PRICE_INPUTS[n];
  return (
    <FieldSet>
      <FieldLegend>{t("money.tierName", { tier: n })}</FieldLegend>
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={nameId}>{t("revenue.tiers.name")}</FieldLabel>
        <Input
          id={nameId}
          data-testid={nameId}
          value={draft.name}
          maxLength={MONEY_LIMITS.tierNameMaxLength}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          onBlur={() => onBlurField("name")}
          onChange={(e) => onChange({ name: e.currentTarget.value })}
        />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      {/* AmountField owns its input's blur; the wrapper hears it bubble (React focus events do). */}
      <div className="contents" onBlur={() => onBlurField("price")}>
        <AmountField
          label={t("revenue.tiers.price")}
          currency={currency}
          locale={locale}
          value={draft.priceCents}
          min={MONEY_LIMITS.tierMinCents}
          max={MONEY_LIMITS.tierMaxCents}
          rangeError={null}
          formatError={t("money.amountFormat")}
          onValidityChange={onPriceValidity}
          errors={errors.price}
          hint={t("revenue.tiers.priceHint", {
            min: formatMoney(MONEY_LIMITS.tierMinCents, currency, locale),
            max: formatMoney(MONEY_LIMITS.tierMaxCents, currency, locale),
          })}
          inputProps={priceInput}
          onValueChange={(priceCents) => onChange({ priceCents })}
        />
      </div>
      <Field data-invalid={errors.benefits ? true : undefined}>
        <FieldLabel htmlFor={benefitsId}>{t("revenue.tiers.benefits")}</FieldLabel>
        <Textarea
          id={benefitsId}
          data-testid={benefitsId}
          value={draft.benefits}
          maxLength={MONEY_LIMITS.tierBenefitsMaxLength}
          rows={3}
          aria-invalid={errors.benefits ? true : undefined}
          onBlur={() => onBlurField("benefits")}
          onChange={(e) => onChange({ benefits: e.currentTarget.value })}
        />
        <FieldDescription>{t("revenue.tiers.benefitsHint")}</FieldDescription>
        {errors.benefits && <FieldError>{errors.benefits}</FieldError>}
      </Field>
    </FieldSet>
  );
}
