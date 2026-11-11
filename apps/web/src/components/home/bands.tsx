// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Home's two closing bands (D3.1): the co-op band (what the co-op promises, with the numbers it
 * can back) and the start-streaming band. Neither uses the brand fill: the page's one filled CTA
 * is the hero's. Numbers that did not load are left out rather than guessed.
 */
import { Arcs, MoneyAmount, SignalBars, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { CheckmarkCircle02Icon, Coins01Icon, Book02Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { monthLabel } from "../../lib/money.ts";
import { CREATORS_HREF, shareLabel } from "./hero.tsx";
import type { CoopProof } from "./model.ts";
import { track, useTrackView } from "./track.ts";

function Fact({ icon, children }: { icon: IconSvgElement; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-text" />
      <span>{children}</span>
    </li>
  );
}

export function CoopBand({ coop }: { coop: CoopProof | null }): React.JSX.Element {
  const { locale } = useLocale();
  useTrackView("home.coopBand");
  const share = shareLabel(coop?.creatorShare ?? null, locale);
  const earned = coop?.earned ?? null;
  return (
    <section
      data-testid="home-coop-band"
      aria-labelledby="home-coop-title"
      className="grid min-w-0 gap-6 bg-card p-6 ring-1 ring-border lg:grid-cols-2 lg:items-center lg:p-8"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm font-medium text-muted-foreground">{t("d3Home.coopBand.eyebrow")}</p>
        <h2 id="home-coop-title" className="font-display text-2xl font-semibold text-balance md:text-3xl">
          {t("d3Home.coopBand.title")}
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          {share && <Fact icon={Coins01Icon}>{t("d3Home.coopBand.share", { creatorShare: share })}</Fact>}
          <Fact icon={CheckListIcon}>{t("d3Home.coopBand.vote")}</Fact>
          <Fact icon={Book02Icon}>{t("d3Home.coopBand.books")}</Fact>
        </ul>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            data-testid="home-coop-cta"
            variant="outline"
            nativeButton={false}
            render={<Link to="/coop" />}
            onClick={track("home.coopBand", "click", "join")}
          >
            {t("d3Home.coopBand.cta")}
          </Button>
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link to="/transparency" />}
            onClick={track("home.coopBand", "click")}
          >
            {t("d3Home.coopBand.booksLink")}
          </Button>
        </div>
      </div>
      {(share || earned) && (
        <div className="flex min-w-0 flex-col gap-2">
          <dl className="grid grid-cols-1 gap-px bg-border ring-1 ring-border sm:grid-cols-2">
            {share && (
              <div className="flex flex-col gap-1 bg-background p-4">
                <dt className="order-2 text-sm text-muted-foreground">{t("d3Home.coopBand.shareStat")}</dt>
                <dd className="order-1 text-2xl font-semibold tabular-nums">{share}</dd>
              </div>
            )}
            {earned && (
              <div data-testid="home-coop-earned" className="flex flex-col gap-1 bg-background p-4">
                <dt className="order-2 text-sm text-muted-foreground">
                  {t("d3Home.numbers.earned", { month: monthLabel(earned.month) })}
                </dt>
                <dd className="order-1 text-2xl font-semibold">
                  <MoneyAmount value={{ cents: earned.cents, currency: earned.currency }} className="tabular-nums" />
                </dd>
              </div>
            )}
          </dl>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} aria-hidden className="size-3.5" />
            {t("d3Home.coopBand.source")}
          </p>
        </div>
      )}
    </section>
  );
}

export function StreamBand({ site, creatorShare }: { site: string; creatorShare: number | null }): React.JSX.Element {
  const { locale } = useLocale();
  useTrackView("home.streamBand");
  const share = shareLabel(creatorShare, locale);
  return (
    <section
      data-testid="home-stream-band"
      aria-labelledby="home-stream-title"
      className="relative grid min-w-0 gap-4 overflow-hidden bg-muted/40 px-6 py-8 ring-1 ring-border md:grid-cols-[1fr_auto] md:items-center md:p-10"
    >
      <Arcs className="pointer-events-none absolute -end-12 top-1/2 hidden w-48 -translate-y-1/2 text-muted-foreground opacity-10 md:block" />
      <div className="relative flex min-w-0 flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{t("d3Home.streamBand.eyebrow")}</p>
        <h2 id="home-stream-title" className="font-display text-2xl font-semibold text-balance md:text-3xl">
          {t("d3Home.streamBand.title")}
        </h2>
        <p className="text-muted-foreground">
          {share ? t("d3Home.streamBand.body", { creatorShare: share }) : t("d3Home.streamBand.bodyNoShare")}
        </p>
      </div>
      <div className="relative">
        <Button
          data-testid="home-stream-cta"
          variant="outline"
          size="lg"
          nativeButton={false}
          render={<a href={CREATORS_HREF} aria-label={t("d3Home.streamBand.cta", { site })} />}
          onClick={track("home.streamBand", "click", "stream")}
        >
          {t("d3Home.streamBand.cta", { site })}
        </Button>
      </div>
      <SignalBars variant="band" className="absolute inset-x-0 bottom-0 h-1 w-full text-brand-text" />
    </section>
  );
}
