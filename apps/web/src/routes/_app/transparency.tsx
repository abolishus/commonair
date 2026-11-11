// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FilterBar } from "@commonair/ui/blocks/data";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FeeSchedule } from "../../components/money/fee-schedule.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { EnforcementReport } from "../../components/transparency/enforcement-report.tsx";
import { GrowthNumbers } from "../../components/transparency/growth-numbers.tsx";
import { JuryResults } from "../../components/transparency/jury-results.tsx";
import { HowWeCount } from "../../components/transparency-v2/how-we-count.tsx";
import { cutShares, feeLastChanged } from "../../components/transparency-v2/model.ts";
import { TransparencyV2 } from "../../components/transparency-v2/report.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import {
  isTreasurer,
  parseTransparencyPeriod,
  transparencyPeriodOptions,
  type TransparencyPeriod,
} from "../../lib/money.ts";
import { titleHead } from "../../lib/page-title.ts";
import { trackUi } from "../../lib/ui-metrics.ts";

/**
 * Public: transparency v2 (overhaul D6.1): the numbers strip, the fee promise, the books by month
 * from the ledger, the deficit note, the co-op's commitments, growth numbers, the open enforcement
 * report (ADR 0019), the advisory jury (ADR 0038), "How we count" (`#how-we-count`) and the fee
 * schedule (`#fee-schedule`). Each section loads and fails on its own (F3). Treasurers also get the
 * month-note editor.
 */
export const Route = createFileRoute("/_app/transparency")({
  head: () => titleHead(t("pageTitle.transparency")),
  component: TransparencyPage,
});

function TransparencyPage(): React.JSX.Element {
  const { me, instance, config } = useBootstrap();
  const [period, setPeriod] = React.useState<TransparencyPeriod>(12);
  const books = useLoad(String(period), () => api().coop.transparency({ months: period }));
  const settings = useLoad("transparency-settings", () => api().coop.settings());
  const schedule = useLoad("transparency-fee-schedule", () => api().coop.feeSchedule());
  React.useEffect(() => trackUi("transparency", "view"), []);
  const reloadBooks = books.reload;
  const onSaveNote = React.useCallback(
    async (month: string, body: string) => {
      await api().transparency.setNote({ month, body });
      reloadBooks();
    },
    [reloadBooks],
  );
  return (
    <PageContainer data-testid="transparency" width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("transparency.title")}
        description={t("transparency.intro")}
        actions={
          <FilterBar
            filters={[
              {
                id: "transparency-period",
                label: t("transparency.periodLabel"),
                value: String(period),
                options: transparencyPeriodOptions(),
                onValueChange: (value) => setPeriod(parseTransparencyPeriod(value) ?? 12),
              },
            ]}
          />
        }
      />
      <TransparencyV2
        books={books}
        cut={cutShares(settings.data)}
        feeChanged={feeLastChanged(schedule.data)}
        settingsLoad={settings}
        scheduleLoad={schedule}
        currency={config.currency}
        site={instance.name}
        onSaveNote={isTreasurer(me) ? onSaveNote : undefined}
      />
      <FeeSchedule />
      <GrowthNumbers />
      <EnforcementReport />
      <JuryResults />
      <HowWeCount />
    </PageContainer>
  );
}
