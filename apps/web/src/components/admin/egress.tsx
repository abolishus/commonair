// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DELIVERY_SOURCES } from "@commonair/contracts/enums";
import { EmptyState, SkeletonGroup, SkeletonText, formatBytes, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn, StatCard, StatGrid } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Chart01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { egressClient, type EgressClient, type EgressReportDto } from "./client.ts";
import { checkEgressRange, defaultEgressInputs } from "./forms.ts";
import { sourceLabel } from "./labels.ts";

/** Mirrors the API cap on listed broadcasts (`EGRESS_BROADCAST_CAP`). */
export const EGRESS_BROADCAST_CAP = 200;

const total = (bytes: Record<string, number>) => DELIVERY_SOURCES.reduce((a, s) => a + (bytes[s] ?? 0), 0);

type BroadcastRow = EgressReportDto["byBroadcast"][number];

function columns(locale: string): DataTableColumn<BroadcastRow>[] {
  return [
    {
      id: "channel",
      header: t("admin.egress.channel"),
      cell: ({ row: { original: b } }) => <span className="font-medium">{b.channelSlug}</span>,
    },
    ...DELIVERY_SOURCES.map((s): DataTableColumn<BroadcastRow> => ({
      id: s,
      header: sourceLabel(s),
      align: "numeric",
      cell: ({ row: { original: b } }) => formatBytes(b.bytes[s], locale),
    })),
    {
      id: "total",
      header: t("admin.egress.total"),
      align: "numeric",
      cell: ({ row: { original: b } }) => formatBytes(total(b.bytes), locale),
    },
  ];
}

/** `/admin/egress`: a range (UTC, default the last 24 h), totals by source, and bytes per broadcast. */
export function EgressPage({
  client: clientProp,
  now,
}: {
  client?: EgressClient;
  /** The default range ends here (tests pin it). */
  now?: Date;
}): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? egressClient());
  const [inputs, setInputs] = React.useState(() => defaultEgressInputs(now ?? new Date()));
  const initial = checkEgressRange(inputs.from, inputs.to);
  const [range, setRange] = React.useState<{ from: string; to: string } | null>(
    initial.ok ? { from: initial.from, to: initial.to } : null,
  );
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const fromId = React.useId();
  const toId = React.useId();
  const report = useLoad(range ? `${range.from}|${range.to}` : "none", () =>
    range ? client.report(range) : Promise.reject(new Error("no range")),
  );

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const check = checkEgressRange(inputs.from, inputs.to);
    if (!check.ok) {
      setRangeError(
        check.error === "invalid"
          ? t("admin.egress.rangeInvalid")
          : check.error === "order"
            ? t("admin.egress.rangeOrder")
            : t("admin.egress.rangeTooLong"),
      );
      return;
    }
    setRangeError(null);
    if (range && range.from === check.from && range.to === check.to) report.reload();
    else setRange({ from: check.from, to: check.to });
  };

  return (
    <div data-testid="egress" className="flex flex-col gap-6">
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field>
            <FieldLabel htmlFor={fromId}>{t("admin.egress.from")}</FieldLabel>
            <Input
              id={fromId}
              data-testid="egress-from"
              type="datetime-local"
              value={inputs.from}
              aria-invalid={rangeError !== null || undefined}
              onChange={(e) => {
                const from = e.currentTarget.value;
                setInputs((p) => ({ ...p, from }));
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={toId}>{t("admin.egress.to")}</FieldLabel>
            <Input
              id={toId}
              data-testid="egress-to"
              type="datetime-local"
              value={inputs.to}
              aria-invalid={rangeError !== null || undefined}
              onChange={(e) => {
                const to = e.currentTarget.value;
                setInputs((p) => ({ ...p, to }));
              }}
            />
          </Field>
          <Button data-testid="egress-load" type="submit">
            {t("admin.egress.load")}
          </Button>
        </div>
        {rangeError ? (
          <FieldError>{rangeError}</FieldError>
        ) : (
          <FieldDescription>{t("admin.egress.rangeHint")}</FieldDescription>
        )}
      </form>
      <EgressResult report={report.data} failed={report.failed} onRetry={report.reload} />
    </div>
  );
}

export function EgressResult({
  report,
  failed,
  onRetry,
}: {
  report: EgressReportDto | null;
  failed: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  if (failed)
    return (
      <div data-testid="egress-error" className="flex flex-col items-start gap-3">
        <FormError>{t("admin.egress.loadFailed")}</FormError>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("admin.egress.retry")}
        </Button>
      </div>
    );
  if (report === null)
    return (
      <SkeletonGroup label={t("admin.egress.loading")}>
        <SkeletonText lines={5} />
      </SkeletonGroup>
    );
  const sources = DELIVERY_SOURCES;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="egress-totals">
        <h2 id="egress-totals" className="text-sm font-medium">
          {t("admin.egress.totals")}
        </h2>
        <StatGrid cols={4}>
          {sources.map((s) => (
            <StatCard
              key={s}
              size="sm"
              data-testid="egress-total"
              data-source={s}
              data-bytes={report.totals[s]}
              label={sourceLabel(s)}
              value={formatBytes(report.totals[s], locale)}
            />
          ))}
        </StatGrid>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="egress-broadcasts">
        <h2 id="egress-broadcasts" className="text-sm font-medium">
          {t("admin.egress.broadcasts")}
        </h2>
        {report.byBroadcast.length === 0 ? (
          <EmptyState
            data-testid="egress-empty"
            icon={Chart01Icon}
            title={t("admin.egress.empty")}
            description={t("admin.egress.emptyHint")}
            headingLevel={3}
          />
        ) : (
          <DataTable
            caption={t("admin.egress.broadcasts")}
            columns={columns(locale)}
            rows={report.byBroadcast}
            getRowId={(b) => b.broadcastId}
            rowProps={(b) => ({
              "data-testid": "egress-row",
              "data-broadcast-id": b.broadcastId,
              "data-channel": b.channelSlug,
              "data-origin": b.bytes.origin,
              "data-relay": b.bytes.relay,
              "data-p2p": b.bytes.p2p,
              "data-cdn": b.bytes.cdn,
            })}
            footer={
              report.byBroadcast.length >= EGRESS_BROADCAST_CAP ? (
                <p className="text-xs text-muted-foreground">
                  {t("admin.egress.capped", { count: EGRESS_BROADCAST_CAP })}
                </p>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}
