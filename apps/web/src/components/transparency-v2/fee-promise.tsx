// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatPercent, useLocale } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import type * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { conditionText } from "../creators/fee-calculator.tsx";
import { COMPETITOR_RATES, RATES_CHECKED, type CompetitorId, type PlatformRate } from "../creators/rates.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import type { CutShares } from "./model.ts";
import type { LoadStatus } from "./report.tsx";

/** The competitor names and source labels `/creators` already translates (d2-pages). */
const PLATFORM_NAME: Record<CompetitorId, MessageKey> = {
  kick: "d2Pages.creators.platform.kick",
  youtube: "d2Pages.creators.platform.youtube",
  twitch: "d2Pages.creators.platform.twitch",
  patreon: "d2Pages.creators.platform.patreon",
  kofi: "d2Pages.creators.platform.kofi",
};
const SOURCE_LABEL: Record<CompetitorId, MessageKey> = {
  kick: "d2Pages.creators.source.kick",
  youtube: "d2Pages.creators.source.youtube",
  twitch: "d2Pages.creators.source.twitch",
  patreon: "d2Pages.creators.source.patreon",
  kofi: "d2Pages.creators.source.kofi",
};

const isCompetitor = (id: PlatformRate["id"]): id is CompetitorId => id !== "commonair";

export interface FeePromiseProps {
  /** From `platform.cut`; null when the settings did not load (the promise then says so). */
  cut: CutShares | null;
  /** The instance's name (`instance.name`), never a literal. */
  site: string;
  /** The `coop.settings` load, when it failed and `cut` is null: the promise offers Retry (F3). */
  failedLoad?: LoadStatus;
}

/**
 * The fee promise (coop-trust P3.2, CT-5): the creator share from `platform.cut`, then each
 * competitor's own published sub share with its conditions, source and "as published on" date.
 * The competitor figures are `/creators`' sourced table (`creators/rates.ts`); nothing here invents
 * a figure or claims the highest share (Kick's 95% needs a status gate, and says so).
 */
export function FeePromise({ cut, site, failedLoad }: FeePromiseProps): React.JSX.Element {
  const { locale } = useLocale();
  const pct = (n: number) => formatPercent(n, locale, { maximumFractionDigits: 1 });
  return (
    <Card data-testid="transparency-fee-promise" data-creator-share={cut?.creator ?? ""}>
      <CardHeader>
        <CardTitle>{t("d6Transparency.fee.title")}</CardTitle>
        <CardDescription className="text-sm">
          {cut
            ? t("d6Transparency.fee.promise", { creatorShare: pct(cut.creator), coopShare: pct(cut.coop) })
            : t("d6Transparency.fee.unavailable")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {cut && <p className="text-sm">{t("d6Transparency.fee.firstSub")}</p>}
        {!cut && failedLoad && (
          <SectionLoadError
            section={t("d6Transparency.fee.title")}
            load={failedLoad}
            headingLevel={3}
            data-testid="transparency-fee-error"
          />
        )}
        <a
          href="#fee-schedule"
          className="self-start text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {t("d6Transparency.fee.scheduleLink")}
        </a>
        <section aria-labelledby="transparency-fee-compare-title" className="flex flex-col gap-2">
          <h3 id="transparency-fee-compare-title" className="text-base font-semibold">
            {t("d6Transparency.fee.compareTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("d6Transparency.fee.compareHint", { checkedDate: RATES_CHECKED })}
          </p>
          <ul className="flex flex-col divide-y divide-border border border-border">
            {cut && (
              <CompareRow
                platform="commonair"
                name={t("d6Transparency.fee.ours", { site })}
                share={pct(cut.creator)}
                terms={t("d2Pages.creators.cond.commonair")}
              />
            )}
            {COMPETITOR_RATES.flatMap((rate) =>
              isCompetitor(rate.id)
                ? [
                    <CompareRow
                      key={rate.id}
                      platform={rate.id}
                      name={t(PLATFORM_NAME[rate.id])}
                      share={pct(rate.subShare)}
                      terms={conditionText(rate.id, locale)}
                      source={<SourceLine rate={rate} id={rate.id} />}
                    />,
                  ]
                : [],
            )}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}

function CompareRow({
  platform,
  name,
  share,
  terms,
  source,
}: {
  platform: string;
  name: string;
  share: string;
  terms: string;
  source?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      data-testid="transparency-fee-compare-row"
      data-platform={platform}
      className="flex min-w-0 flex-col gap-1 p-3 sm:flex-row sm:items-start sm:gap-4"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3 sm:w-1/3 sm:flex-col sm:justify-start sm:gap-0">
        <span className="text-sm font-medium break-words">{name}</span>
        <span className="shrink-0 text-lg font-semibold tabular-nums">{share}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-muted-foreground">
        <p className="break-words">{terms}</p>
        {source && <p className="text-xs break-words">{source}</p>}
      </div>
    </li>
  );
}

function SourceLine({ rate, id }: { rate: PlatformRate; id: CompetitorId }): React.JSX.Element | null {
  if (!rate.source) return null;
  return (
    <>
      {rate.source.secondary
        ? t("d6Transparency.fee.secondary", { checkedDate: RATES_CHECKED })
        : t("d6Transparency.fee.asPublished", { checkedDate: RATES_CHECKED })}{" "}
      <a
        href={rate.source.url}
        rel="noreferrer"
        target="_blank"
        className="text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t(SOURCE_LABEL[id])}
      </a>
    </>
  );
}
