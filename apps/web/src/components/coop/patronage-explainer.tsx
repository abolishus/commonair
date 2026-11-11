// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatMoney, formatPercent, useLocale } from "@commonair/ui";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { CoopMonthDto } from "../../lib/coop.ts";
import type { SettingLike } from "../creators/facts.ts";
import { ExplainerJoin } from "./explainer-join.tsx";
import { CoopTabs } from "./nav.tsx";

const Weight = z.number().min(0).max(1);
const Formula = z.object({
  weights: z.object({
    revenue: Weight,
    streamingHours: Weight,
    relayBandwidth: Weight,
    viewerHours: Weight,
  }),
});

export type PatronageWeights = z.infer<typeof Formula>["weights"];

/** `patronage.formula` weights; null when the setting is missing or not the shape we know. */
export function patronageWeights(settings: readonly SettingLike[] | null): PatronageWeights | null {
  const parsed = Formula.safeParse(settings?.find((s) => s.key === "patronage.formula")?.value);
  return parsed.success ? parsed.data.weights : null;
}

export interface PatronageStanding {
  months: number;
  surplusCents: number;
  distributedCents: number;
  currency: string;
}

/**
 * The books over the months given (never a projection): the surplus left over and what members
 * shared. Null without months, or when they mix currencies (no honest single total).
 */
export function patronageStanding(
  months: readonly Pick<CoopMonthDto, "surplus" | "patronageDistributed">[] | null,
): PatronageStanding | null {
  if (!months || months.length === 0) return null;
  const currency = months[0]?.surplus.currency ?? "";
  if (months.some((m) => m.surplus.currency !== currency || m.patronageDistributed.currency !== currency)) return null;
  return {
    months: months.length,
    surplusCents: months.reduce((sum, m) => sum + m.surplus.cents, 0),
    distributedCents: months.reduce((sum, m) => sum + m.patronageDistributed.cents, 0),
    currency,
  };
}

const WEIGHT_LABEL: Record<keyof PatronageWeights, MessageKey> = {
  revenue: "d2Pages.patronage.formula.revenue",
  streamingHours: "d2Pages.patronage.formula.streamingHours",
  relayBandwidth: "d2Pages.patronage.formula.relayBandwidth",
  viewerHours: "d2Pages.patronage.formula.viewerHours",
};

export interface PatronageExplainerProps {
  weights: PatronageWeights | null;
  standing: PatronageStanding | null;
}

/** `/coop/patronage` for signed-out visitors: what patronage is, where it stands, how it's counted. */
export function PatronageExplainer({ weights, standing }: PatronageExplainerProps): React.JSX.Element {
  const { locale } = useLocale();
  const money = (cents: number) => formatMoney(cents, standing?.currency ?? "usd", locale);
  return (
    <PageContainer data-testid="patronage-explainer" width="default" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("coop.patronage.title")}
        description={t("d2Pages.patronage.intro")}
        tabs={<CoopTabs current="patronage" />}
      />
      <div className="flex max-w-prose flex-col gap-6">
        <Section heading={t("d2Pages.patronage.what.title")}>
          <p className="text-muted-foreground">{t("d2Pages.patronage.what.body")}</p>
        </Section>
        {standing && (
          <Section heading={t("d2Pages.patronage.now.title")} data-testid="patronage-standing">
            <div className="flex flex-col gap-2 text-muted-foreground">
              <p data-testid="patronage-standing-line" data-surplus={standing.surplusCents > 0 ? "yes" : "no"}>
                {standing.surplusCents > 0
                  ? t("d2Pages.patronage.now.surplus", {
                      months: standing.months,
                      amount: money(standing.surplusCents),
                    })
                  : t("d2Pages.patronage.now.deficit")}
              </p>
              {standing.distributedCents > 0 && (
                <p>{t("d2Pages.patronage.now.shared", { amount: money(standing.distributedCents) })}</p>
              )}
              <Link
                to="/transparency"
                className="self-start text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("d2Pages.patronage.now.link")}
              </Link>
            </div>
          </Section>
        )}
        {weights && (
          <Section heading={t("d2Pages.patronage.formula.title")} description={t("d2Pages.patronage.formula.intro")}>
            <ul data-testid="patronage-weights" className="flex list-disc flex-col gap-1 ps-5">
              {(Object.keys(WEIGHT_LABEL) as (keyof PatronageWeights)[]).map((k) => (
                <li key={k} data-weight={k}>
                  {t(WEIGHT_LABEL[k], { weight: formatPercent(weights[k], locale, { maximumFractionDigits: 1 }) })}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <ExplainerJoin
          path="/coop/patronage"
          title={t("d2Pages.patronage.join.title")}
          body={t("d2Pages.patronage.join.body")}
        />
      </div>
    </PageContainer>
  );
}
