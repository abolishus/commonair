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
  BreakdownBar,
  DataTable,
  FilterBar,
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
import { safeHttpUrl } from "../../lib/url.ts";

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

export function RevenueStats({ summary }: { summary: RevenueSummaryDto }): React.JSX.Element {
  const { locale } = useLocale();
  const { available, held, owed, minimumPayout, holdDays } = summary.balance;
  const delta = earnedDelta(summary.net, summary.previousNet, locale);
  const minimum = formatMoney(minimumPayout.cents, minimumPayout.currency, locale);
  return (
    <StatGrid cols={owed.cents > 0 ? 4 : 3}>
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
          tone="warning"
          label={t("revenue.owed")}
          value={<MoneyAmount value={owed} />}
          hint={t("revenue.owedHint")}
        />
      )}
      <StatCard
        data-testid="revenue-earned"
        data-cents={summary.net.cents}
        data-previous={summary.previousNet.cents}
        label={t("revenue.earned")}
        value={<MoneyAmount value={summary.net} colorNegative />}
        delta={delta}
      />
    </StatGrid>
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
          empty={<EmptyState title={t("revenue.subscribersEmpty")} headingLevel={3} />}
        />
      </CardContent>
    </Card>
  );
}

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
    </Section>
  );
}

function ledgerDetail(line: RevenueLineDto): string {
  const who = line.from?.displayName ?? (line.type === "payout" ? "" : t("revenue.ledger.anonymous"));
  const parts = [
    who,
    line.tier !== null ? t("money.tierName", { tier: line.tier }) : "",
    line.quantity > 1 ? t("revenue.ledger.quantity", { count: line.quantity }) : "",
    line.reference ?? "",
  ];
  return parts.filter((p) => p !== "").join(t("money.detailSeparator"));
}

export function PayoutAccountCard({ account }: { account: PayoutAccountDto }): React.JSX.Element {
  const onboarding = safeHttpUrl(account.onboardingUrl);
  return (
    <Card
      data-testid="revenue-payout-account"
      data-provider={account.provider}
      data-enabled={String(account.payoutsEnabled)}
    >
      <CardHeader>
        <CardTitle>{t("revenue.payout.title")}</CardTitle>
        <CardDescription>{t("revenue.payout.hint")}</CardDescription>
        <CardAction>
          <StatusBadge tone={account.payoutsEnabled ? "success" : "warning"}>
            {account.payoutsEnabled ? t("revenue.payout.enabled") : t("revenue.payout.notEnabled")}
          </StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {account.instructions && <p className="text-sm whitespace-pre-line">{account.instructions}</p>}
        {onboarding && (
          <div>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={onboarding} rel="noopener" aria-label={t("revenue.payout.onboard")} />}
            >
              {t("revenue.payout.onboard")}
            </Button>
          </div>
        )}
        {!account.instructions && !onboarding && (
          <p className="text-sm text-muted-foreground">{t("revenue.payout.none")}</p>
        )}
      </CardContent>
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
    if (!valid || pending) return;
    setPending(true);
    try {
      const saved = await onSave(tiersInput(drafts, currency));
      setDrafts(tierDrafts(saved));
      setGeneration((g) => g + 1);
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
    >
      <ResponsiveGrid cols={3}>
        {drafts.map((draft) => (
          <TierFields
            key={`${draft.tier}-${generation}`}
            draft={draft}
            currency={currency}
            errors={errors[draft.tier] ?? {}}
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
          disabled={!valid || pending}
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
  onPriceValidity,
}: {
  draft: TierDraft;
  currency: string;
  errors: { name?: string; price?: string; benefits?: string };
  onChange: (patch: Partial<TierDraft>) => void;
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
          onChange={(e) => onChange({ name: e.currentTarget.value })}
        />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
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
      <Field data-invalid={errors.benefits ? true : undefined}>
        <FieldLabel htmlFor={benefitsId}>{t("revenue.tiers.benefits")}</FieldLabel>
        <Textarea
          id={benefitsId}
          data-testid={benefitsId}
          value={draft.benefits}
          maxLength={MONEY_LIMITS.tierBenefitsMaxLength}
          rows={3}
          onChange={(e) => onChange({ benefits: e.currentTarget.value })}
        />
        <FieldDescription>{t("revenue.tiers.benefitsHint")}</FieldDescription>
        {errors.benefits && <FieldError>{errors.benefits}</FieldError>}
      </Field>
    </FieldSet>
  );
}
