// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, formatMoney, formatNumber, formatPercent, useLocale } from "@commonair/ui";
import { Progress } from "@commonair/ui/components/progress";
import { Slider } from "@commonair/ui/components/slider";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";
import { cn } from "@commonair/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import type { PayoutFacts } from "./facts.ts";
import {
  AVERAGE_TIP_CENTS,
  CALC_LIMITS,
  CARD_PROCESSING,
  COMPETITOR_RATES,
  RATES_CHECKED,
  SUBSCRIBER_PRESETS,
  barShare,
  calculate,
  type CalcInput,
  type CalcRow,
  type CompetitorId,
  type PlatformRate,
} from "./rates.ts";

/** Competitor figures are US-dollar rates; the calculator quotes every row in dollars. */
const CURRENCY = "usd";

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

const rateOf = (id: CompetitorId): PlatformRate => {
  const rate = COMPETITOR_RATES.find((r) => r.id === id);
  // The table lists every competitor id; a missing one is a programming error caught by the tests.
  if (!rate) throw new Error(`no rate for ${id}`);
  return rate;
};

/** The condition a competitor's rate needs, with its figures formatted from the rate table. */
export function conditionText(id: CompetitorId, locale: string): string {
  const pct = (n: number) => formatPercent(n, locale, { maximumFractionDigits: 1 });
  const rate = rateOf(id);
  const card = {
    cardRate: pct(CARD_PROCESSING.rate),
    cardFixed: formatMoney(CARD_PROCESSING.fixedCents, CURRENCY, locale),
  };
  switch (id) {
    case "kick":
      return t("d2Pages.creators.cond.kick", {
        share: pct(rate.subShare),
        price: formatMoney(rate.fixedSubPriceCents ?? 0, CURRENCY, locale),
        tipShare: pct(rate.tipShare ?? 0),
      });
    case "youtube":
      return t("d2Pages.creators.cond.youtube", { share: pct(rate.subShare) });
    case "twitch":
      return t("d2Pages.creators.cond.twitch", { share: pct(rate.subShare), altShare: pct(rate.altSubShare ?? 0) });
    case "patreon":
      return t("d2Pages.creators.cond.patreon", { fee: pct(1 - rate.subShare), ...card });
    case "kofi":
      return t("d2Pages.creators.cond.kofi", { fee: pct(1 - rate.subShare), ...card });
  }
}

export interface FeeCalculatorProps {
  /** `platform.cut` `streamerShare`. */
  creatorShare: number;
  payout: PayoutFacts | null;
  site: string;
  initial?: Partial<CalcInput>;
}

/** The honest fee calculator: CommonAir first, every competitor row sourced and dated. */
export function FeeCalculator({ creatorShare, payout, site, initial = {} }: FeeCalculatorProps): React.JSX.Element {
  const { locale } = useLocale();
  const [input, setInput] = React.useState<CalcInput>({
    subscribers: initial.subscribers ?? CALC_LIMITS.subscribers.initial,
    subPriceCents: initial.subPriceCents ?? CALC_LIMITS.subPriceCents.initial,
    tipsCents: initial.tipsCents ?? CALC_LIMITS.tipsCents.initial,
  });
  const used = React.useRef(false);
  const update = (patch: Partial<CalcInput>) => {
    if (!used.current) {
      used.current = true;
      trackUi("creators.calc", "used");
    }
    setInput((prev) => ({ ...prev, ...patch }));
  };
  const rows = calculate(creatorShare, input);
  const ours = rows[0] as CalcRow;
  const money = (cents: number) => formatMoney(cents, CURRENCY, locale);
  const pct = (n: number) => formatPercent(n, locale, { maximumFractionDigits: 1 });
  const kick = rateOf("kick");
  const twitch = rateOf("twitch");
  const ids = React.useId();

  return (
    <div data-testid="fee-calculator" className="grid gap-px bg-border ring-1 ring-border lg:grid-cols-3">
      <form
        aria-label={t("d2Pages.creators.calc.inputs")}
        onSubmit={(e) => e.preventDefault()}
        className="flex min-w-0 flex-col gap-5 bg-surface-sunken p-5"
      >
        <CalcSlider
          id={`${ids}-subs`}
          label={t("d2Pages.creators.calc.subs")}
          display={formatNumber(input.subscribers, locale)}
          limits={CALC_LIMITS.subscribers}
          value={input.subscribers}
          onChange={(subscribers) => update({ subscribers })}
          testId="calc-subscribers"
        >
          <ToggleGroup
            aria-label={t("d2Pages.creators.calc.presets")}
            variant="outline"
            spacing={1}
            className="flex-wrap"
            value={
              (SUBSCRIBER_PRESETS as readonly number[]).includes(input.subscribers) ? [String(input.subscribers)] : []
            }
            onValueChange={(values) => {
              const n = Number(values[0]);
              if (Number.isFinite(n) && values.length > 0) update({ subscribers: n });
            }}
          >
            {SUBSCRIBER_PRESETS.map((n) => (
              <ToggleGroupItem
                key={n}
                value={String(n)}
                data-testid="calc-preset"
                className="min-h-8 px-2.5 text-sm tabular-nums max-md:min-h-10"
              >
                {formatNumber(n, locale)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CalcSlider>
        <CalcSlider
          id={`${ids}-price`}
          label={t("d2Pages.creators.calc.price")}
          display={money(input.subPriceCents)}
          limits={CALC_LIMITS.subPriceCents}
          value={input.subPriceCents}
          onChange={(subPriceCents) => update({ subPriceCents })}
          testId="calc-price"
        >
          <p className="text-sm text-muted-foreground">
            {t("d2Pages.creators.calc.priceHint", { price: money(kick.fixedSubPriceCents ?? 0) })}
          </p>
        </CalcSlider>
        <CalcSlider
          id={`${ids}-tips`}
          label={t("d2Pages.creators.calc.tips")}
          display={money(input.tipsCents)}
          limits={CALC_LIMITS.tipsCents}
          value={input.tipsCents}
          onChange={(tipsCents) => update({ tipsCents })}
          testId="calc-tips"
        />
        <p className="text-sm text-muted-foreground">{t("d2Pages.creators.calc.private")}</p>
      </form>

      <div className="min-w-0 bg-card p-5 md:px-7 md:py-6 lg:col-span-2">
        <div aria-live="polite" aria-atomic="true">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("d2Pages.creators.calc.ours", { site })}
          </p>
          <p data-testid="calc-ours" data-cents={ours.netCents} className="mt-1 text-3xl font-semibold tabular-nums">
            {t("d2Pages.creators.calc.result", { amount: money(ours.netCents) })}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("d2Pages.creators.calc.detail", {
              gross: money(ours.grossCents),
              coop: money(ours.grossCents - ours.netCents),
            })}
          </p>
        </div>

        <ul aria-label={t("d2Pages.creators.calc.compare")} className="mt-5 flex flex-col">
          {rows.map((row, index) => (
            <CalcRowItem
              key={row.id}
              row={row}
              rows={rows}
              first={index === 0}
              name={row.id === "commonair" ? site : t(PLATFORM_NAME[row.id])}
              badge={row.id === "commonair" ? t("d2Pages.creators.calc.yourShare", { share: pct(creatorShare) }) : null}
              condition={row.id === "commonair" ? t("d2Pages.creators.cond.commonair") : conditionText(row.id, locale)}
              source={row.id === "commonair" ? null : <SourceLine id={row.id} />}
              alt={
                row.altNetCents === null
                  ? null
                  : t("d2Pages.creators.calc.alt", {
                      amount: money(row.altNetCents),
                      share: pct(twitch.altSubShare ?? 0),
                    })
              }
            />
          ))}
        </ul>

        <ol
          data-testid="calc-notes"
          className="mt-4 flex list-decimal flex-col gap-1.5 ps-5 text-sm text-muted-foreground"
        >
          <li>{t("d2Pages.creators.note.ours", { site, creatorShare: pct(creatorShare) })}</li>
          {payout && (
            <li>
              {t("d2Pages.creators.note.payout", {
                minimum: formatMoney(payout.minimumCents, payout.currency, locale),
                holdDays: payout.holdDays,
              })}
            </li>
          )}
          <li>{t("d2Pages.creators.note.sources", { checkedDate: RATES_CHECKED })}</li>
          {kick.subShare > creatorShare && (
            <li data-testid="calc-note-kick">{t("d2Pages.creators.note.kick", { share: pct(kick.subShare) })}</li>
          )}
          <li>{t("d2Pages.creators.note.twitch", { defaultShare: pct(twitch.subShare) })}</li>
          <li>
            {t("d2Pages.creators.note.assumptions", {
              cardRate: pct(CARD_PROCESSING.rate),
              cardFixed: money(CARD_PROCESSING.fixedCents),
              tip: money(AVERAGE_TIP_CENTS),
            })}
          </li>
          <li>{t("d2Pages.creators.note.estimate")}</li>
          <li>
            {t("d2Pages.creators.note.vote", { creatorShare: pct(creatorShare) })}{" "}
            <Link
              to="/transparency"
              className="text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("d2Pages.creators.note.voteLink")}
            </Link>
          </li>
        </ol>
      </div>
    </div>
  );
}

interface CalcSliderProps {
  id: string;
  label: string;
  display: string;
  limits: { min: number; max: number; step: number };
  value: number;
  onChange: (value: number) => void;
  testId: string;
  children?: React.ReactNode;
}

function CalcSlider({ id, label, display, limits, value, onChange, testId, children }: CalcSliderProps) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId} data-value={value}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={id} className="font-medium">
          {label}
        </span>
        <output aria-labelledby={id} className="text-base font-semibold tabular-nums">
          {display}
        </output>
      </div>
      <Slider
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={[value]}
        getAriaLabel={() => label}
        getAriaValueText={() => display}
        onValueChange={(v) => {
          const n = Array.isArray(v) ? v[0] : v;
          if (typeof n === "number") onChange(n);
        }}
      />
      {children}
    </div>
  );
}

interface CalcRowItemProps {
  row: CalcRow;
  rows: readonly CalcRow[];
  first: boolean;
  name: string;
  badge: string | null;
  condition: string;
  source: React.ReactNode;
  alt: string | null;
}

function CalcRowItem({ row, rows, first, name, badge, condition, source, alt }: CalcRowItemProps) {
  const ours = row.id === "commonair";
  return (
    <li
      data-testid="calc-row"
      data-platform={row.id}
      data-cents={row.netCents}
      className={cn("flex flex-col gap-1 py-3", !first && "border-t border-border")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={cn("flex min-w-0 flex-wrap items-center gap-2", ours ? "font-semibold" : "font-medium")}>
          {name}
          {badge && (
            <span className="inline-flex min-h-6 items-center px-1.5 text-xs ring-1 ring-border ring-inset">
              {badge}
            </span>
          )}
        </div>
        <div className="shrink-0 text-end text-base font-semibold">
          <MoneyAmount value={{ cents: row.netCents, currency: CURRENCY }} />
          {alt && <div className="text-xs font-normal text-muted-foreground">{alt}</div>}
        </div>
      </div>
      {/* Decorative: the amount beside it is the figure. */}
      <Progress
        aria-hidden
        value={Math.round(barShare(row.netCents, rows) * 100)}
        className={cn("motion-reduce:*:*:transition-none", !ours && "opacity-60")}
      />
      <p className="text-sm text-muted-foreground">
        {condition} {source}
      </p>
    </li>
  );
}

function SourceLine({ id }: { id: CompetitorId }) {
  const rate = rateOf(id);
  if (!rate.source) return null;
  const link = (
    <a
      href={rate.source.url}
      rel="noreferrer"
      target="_blank"
      className="text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t(SOURCE_LABEL[id])}
    </a>
  );
  return (
    <>
      {rate.source.secondary
        ? t("d2Pages.creators.calc.secondary", { platform: t(PLATFORM_NAME[id]), checkedDate: RATES_CHECKED })
        : t("d2Pages.creators.calc.checked", { checkedDate: RATES_CHECKED })}{" "}
      {link}
    </>
  );
}
