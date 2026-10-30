// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FeeScheduleEntry } from "@commonair/contracts/dto";
import { EmptyState, RelativeTime, formatMoney, formatNumber, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import type { z } from "zod";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import { useLoad } from "./use-load.ts";

export type FeeScheduleEntryDto = z.infer<typeof FeeScheduleEntry>;

const loadSchedule = (): Promise<FeeScheduleEntryDto[]> => api().coop.feeSchedule();

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A setting's value in words; null when it is not the shape this page knows (shown as a dash). */
export function feeScheduleValue(entry: FeeScheduleEntryDto, locale: string): string | null {
  const v = entry.value;
  if (entry.key === "platform.cut") {
    const creator = num(v.streamerShare);
    const coop = num(v.coopShare);
    if (creator === null || coop === null) return null;
    const percent = (share: number) => formatNumber(Math.round(share * 1000) / 10, locale);
    return t("feeSchedule.cut", { creator: percent(creator), coop: percent(coop) });
  }
  const minimum = num(v.minimumCents);
  const days = num(v.holdDays);
  const currency = typeof v.currency === "string" ? v.currency : null;
  if (minimum === null || days === null || currency === null) return null;
  return t("feeSchedule.payout", { minimum: formatMoney(minimum, currency, locale), days });
}

export interface FeeScheduleTableProps {
  /** null while loading. */
  entries: FeeScheduleEntryDto[] | null;
}

/** Every decided change, newest first, then the founding values (`coop.feeSchedule` order). */
export function FeeScheduleTable({ entries }: FeeScheduleTableProps): React.JSX.Element {
  const { locale } = useLocale();
  const columns: DataTableColumn<FeeScheduleEntryDto>[] = [
    {
      id: "date",
      header: t("feeSchedule.date"),
      cell: ({ row }) =>
        row.original.changedAt ? <RelativeTime date={row.original.changedAt} /> : t("feeSchedule.founding"),
    },
    {
      id: "setting",
      header: t("feeSchedule.setting"),
      cell: ({ row }) => (row.original.key === "platform.cut" ? t("feeSchedule.key.cut") : t("feeSchedule.key.payout")),
    },
    {
      id: "value",
      header: t("feeSchedule.value"),
      cell: ({ row }) => feeScheduleValue(row.original, locale) ?? "",
    },
    {
      id: "decision",
      header: t("feeSchedule.decision"),
      cell: ({ row }) =>
        row.original.proposalId ? (
          <Link
            to="/coop/proposals/$id"
            params={{ id: row.original.proposalId }}
            className="underline underline-offset-4"
          >
            {t("feeSchedule.proposal")}
          </Link>
        ) : (
          t("feeSchedule.noProposal")
        ),
    },
  ];
  return (
    <DataTable
      caption={t("feeSchedule.caption")}
      columns={columns}
      rows={entries ?? []}
      loading={entries === null}
      loadingRows={2}
      getRowId={(e, i) => e.id ?? `seed-${e.key}-${i}`}
      rowProps={(e) => ({
        "data-testid": "fee-schedule-row",
        "data-key": e.key,
        "data-changed-at": e.changedAt ?? "",
      })}
      empty={<EmptyState title={t("feeSchedule.empty")} headingLevel={3} />}
    />
  );
}

/** The public fee schedule on `/transparency` (`coop.feeSchedule`), anchored at `#fee-schedule`. */
export function FeeSchedule({
  load = loadSchedule,
}: { load?: () => Promise<FeeScheduleEntryDto[]> } = {}): React.JSX.Element | null {
  const loaded = useLoad("fee-schedule", load);
  return (
    <Section
      id="fee-schedule"
      data-testid="fee-schedule"
      heading={t("feeSchedule.title")}
      description={t("feeSchedule.intro")}
      className="scroll-mt-20"
    >
      {loaded.failed ? (
        <FormError>{t("feeSchedule.loadFailed")}</FormError>
      ) : (
        <FeeScheduleTable entries={loaded.data} />
      )}
    </Section>
  );
}
