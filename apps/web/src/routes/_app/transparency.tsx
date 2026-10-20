// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton, SkeletonGroup } from "@commonair/ui";
import { FilterBar } from "@commonair/ui/blocks/data";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { TransparencyReport } from "../../components/money/transparency.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { parseTransparencyPeriod, transparencyPeriodOptions, type TransparencyPeriod } from "../../lib/money.ts";

/** Public: the co-op's books by month, from the ledger. */
export const Route = createFileRoute("/_app/transparency")({ component: TransparencyPage });

function TransparencyPage(): React.JSX.Element {
  const [period, setPeriod] = React.useState<TransparencyPeriod>(12);
  const report = useLoad(String(period), () => api().coop.transparency({ months: period }));
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
      {report.failed && <FormError>{t("transparency.loadFailed")}</FormError>}
      {report.data ? (
        <TransparencyReport months={report.data} />
      ) : (
        !report.failed && (
          <SkeletonGroup label={t("transparency.loading")}>
            <div className="flex flex-col gap-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </SkeletonGroup>
        )
      )}
    </PageContainer>
  );
}
