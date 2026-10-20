// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton, SkeletonGroup, useLocale } from "@commonair/ui";
import { FilterBar } from "@commonair/ui/blocks/data";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { downloadText } from "../../components/money/download.ts";
import {
  PayoutAccountCard,
  RevenueLedger,
  RevenueSources,
  RevenueStats,
  RevenueStatsSkeleton,
  RevenueTiers,
  TierEditor,
} from "../../components/money/revenue.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import {
  monthOptions,
  monthRange,
  statementCsv,
  statementFilename,
  type RevenueLineDto,
  type SubTierDto,
} from "../../lib/money.ts";

export const Route = createFileRoute("/_studio/revenue")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: RevenuePage,
});

const LEDGER_PAGE = 25;
const STATEMENT_PAGE = 100;
/** A runaway cursor must not loop forever: 100 × 100 rows is far beyond one month. */
const STATEMENT_MAX_PAGES = 100;

function RevenuePage(): React.JSX.Element {
  const { me, now } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return <RevenueView channel={me.channelSlug ?? me.username} now={now} />;
}

function RevenueView({ channel, now }: { channel: string; now: number }): React.JSX.Element {
  // From the request time, so the server render and hydration agree on "this month".
  const months = React.useMemo(() => monthOptions(now), [now]);
  const [month, setMonth] = React.useState(months[0]?.value ?? "");
  const period = periodOf(month);

  const summary = useLoad(`${channel}|${month}`, () => api().money.revenue({ channel, ...period }));
  const account = useLoad(channel, () => api().money.payoutAccount());
  const tiers = useLoad(`tiers|${channel}`, () => api().money.tiers({ channel }));
  const ledger = useLedger(channel, month);
  const currency = summary.data?.net.currency;

  return (
    <PageContainer data-testid="revenue" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("revenue.title")}
        description={t("revenue.intro")}
        actions={
          <FilterBar
            filters={[
              {
                id: "revenue-month-filter",
                label: t("revenue.month"),
                value: month,
                options: months,
                onValueChange: setMonth,
                "data-testid": "revenue-month",
              },
            ]}
          />
        }
      />
      {summary.failed && <FormError>{t("revenue.loadFailed")}</FormError>}
      {summary.data ? (
        <>
          <RevenueStats summary={summary.data} />
          <ResponsiveGrid cols={2}>
            <RevenueSources summary={summary.data} />
            <RevenueTiers summary={summary.data} />
          </ResponsiveGrid>
        </>
      ) : (
        !summary.failed && <RevenueStatsSkeleton />
      )}
      <RevenueLedger {...ledger} />
      {account.data ? (
        <PayoutAccountCard account={account.data} />
      ) : (
        !account.failed && <CardSkeleton />
      )}
      {account.failed && <FormError>{t("revenue.payout.loadFailed")}</FormError>}
      {tiers.data && currency ? (
        <TierEditor
          tiers={tiers.data}
          currency={currency}
          onSave={(next: SubTierDto[]) => api().money.setTiers({ channel, tiers: next })}
        />
      ) : (
        !tiers.failed && <CardSkeleton />
      )}
      {tiers.failed && <FormError>{t("revenue.tiers.loadFailed")}</FormError>}
    </PageContainer>
  );
}

/** The month as the API's `[from, to)` period. */
function periodOf(month: string): { from?: string; to?: string } {
  const range = monthRange(month);
  return range ? { from: range.from, to: range.to } : {};
}

function CardSkeleton(): React.JSX.Element {
  return (
    <SkeletonGroup>
      <Skeleton className="h-32 w-full" />
    </SkeletonGroup>
  );
}

interface LedgerState {
  key: string;
  lines: RevenueLineDto[] | null;
  cursor: string | null;
}

/** The month's revenue ledger, paged with "load more", and the CSV statement built from it. */
function useLedger(channel: string, month: string) {
  const { locale } = useLocale();
  const key = `${channel}|${month}`;
  const period = periodOf(month);
  const [state, setState] = React.useState<LedgerState>({ key, lines: null, cursor: null });
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    setState({ key, lines: null, cursor: null });
    api()
      .money.revenueLedger({ channel, ...periodOf(month), limit: LEDGER_PAGE })
      .then((page) => {
        if (live) setState({ key, lines: page.items, cursor: page.nextCursor });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({ key, lines: [], cursor: null });
        toastActionError(err, t("revenue.ledger.loadFailed"));
      });
    return () => {
      live = false;
    };
  }, [channel, key, month]);

  const current = state.key === key ? state : { key, lines: null, cursor: null };

  const onLoadMore = () => {
    const cursor = current.cursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api()
      .money.revenueLedger({ channel, ...period, limit: LEDGER_PAGE, cursor })
      .then((page) =>
        setState((prev) =>
          prev.key === key ? { key, lines: [...(prev.lines ?? []), ...page.items], cursor: page.nextCursor } : prev,
        ),
      )
      .catch((err: unknown) => toastActionError(err, t("revenue.ledger.loadFailed")))
      .finally(() => setLoadingMore(false));
  };

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const lines: RevenueLineDto[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < STATEMENT_MAX_PAGES; i++) {
        const page = await api().money.revenueLedger({ channel, ...period, limit: STATEMENT_PAGE, cursor });
        lines.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      downloadText(statementFilename(channel, month), statementCsv(lines, locale));
    } catch (err) {
      toastActionError(err, t("revenue.ledger.csvFailed"));
    } finally {
      setDownloading(false);
    }
  };

  return {
    lines: current.lines,
    hasMore: current.cursor !== null,
    loadingMore,
    onLoadMore,
    downloading,
    onDownload: () => void onDownload(),
  };
}
