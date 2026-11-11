// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StreamCard } from "@commonair/contracts/dto";
import { Arcs, formatMoney, formatPercent, useLocale } from "@commonair/ui";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@commonair/ui/components/accordion";
import { BreakdownBar } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import {
  Analytics01Icon,
  ArrowRight01Icon,
  Coins01Icon,
  Download01Icon,
  Link01Icon,
  SecurityCheckIcon,
  Shield01Icon,
  Tick02Icon,
  UserGroupIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { RouteSectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { DiscoveryStreamCard } from "../discovery/stream-cards.tsx";
import { ClaimField, type ClaimFieldProps } from "./claim-field.tsx";
import { FALLBACK_CURRENCY, type CoopFacts } from "./facts.ts";
import { FeeCalculator } from "./fee-calculator.tsx";
import { COMPETITOR_RATES } from "./rates.ts";

export interface CreatorsPageProps {
  /** Null when the settings did not load: the calculator shows its error with Retry. */
  facts: CoopFacts | null;
  live: StreamCard | null;
  site: string;
  /** The instance host for the claim field's prefix. */
  host: string;
  /** `features.twitchImport`: the import section shows only while the import is on (ADR 0031). */
  twitchImport: boolean;
  /** Tests pass a stub availability check. */
  check?: ClaimFieldProps["check"];
  go?: ClaimFieldProps["go"];
}

const SIGNUP_STREAM = "/signup?intent=stream";
const SIGNUP_IMPORT = "/signup?intent=import";

const linkClass =
  "underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-4 text-2xl font-semibold tracking-tight text-balance">
      {children}
    </h2>
  );
}

function Glyph({ icon }: { icon: IconSvgElement }) {
  return (
    <span aria-hidden className="mb-3 grid size-10 place-items-center bg-brand-subtle text-brand-text">
      <HugeiconsIcon icon={icon} className="size-5" strokeWidth={1.8} />
    </span>
  );
}

/** `/creators`: the pitch for streaming here, with the sourced fee calculator as its proof. */
export function CreatorsPage({
  facts,
  live,
  site,
  host,
  twitchImport,
  check,
  go,
}: CreatorsPageProps): React.JSX.Element {
  const { locale } = useLocale();
  const pct = (n: number) => formatPercent(n, locale, { maximumFractionDigits: 1 });
  const share = facts?.creatorShare ?? null;
  const creatorShare = share === null ? null : pct(share);
  const coopShare = share === null ? null : pct(1 - share);
  const payout = facts?.payout ?? null;
  const membership = facts?.membership ?? null;
  const money = (cents: number, currency = payout?.currency ?? FALLBACK_CURRENCY) =>
    formatMoney(cents, currency, locale);

  React.useEffect(() => {
    trackUi("creators.hero", "view");
    if (twitchImport) trackUi("creators.import", "view");
  }, [twitchImport]);

  const kick = COMPETITOR_RATES.find((r) => r.id === "kick");
  const twitch = COMPETITOR_RATES.find((r) => r.id === "twitch");

  return (
    <PageContainer data-testid="creators-page" width="page" className="flex flex-col gap-16 pt-8 pb-16 md:gap-20">
      {/* Hero */}
      <section
        aria-labelledby="creators-hero"
        className="relative grid items-center gap-8 overflow-hidden lg:grid-cols-2 lg:gap-12 lg:pt-8"
      >
        <Arcs className="pointer-events-none absolute -start-28 -top-20 w-90 text-brand-text opacity-5" />
        <div className="relative flex flex-col gap-4">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("d2Pages.creators.hero.eyebrow", { site })}
          </p>
          <h1 id="creators-hero" className="text-display text-balance">
            {creatorShare
              ? t("d2Pages.creators.hero.title", { creatorShare })
              : t("d2Pages.creators.hero.titleNoShare")}
          </h1>
          <p className="max-w-prose text-lg text-muted-foreground">{t("d2Pages.creators.hero.body")}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-2 max-md:flex-col">
            <Button
              variant="brand"
              size="lg"
              data-filled-cta=""
              data-testid="creators-hero-cta"
              nativeButton={false}
              className="min-h-11 px-4"
              render={
                <a
                  href={SIGNUP_STREAM}
                  aria-label={t("d2Pages.creators.hero.cta")}
                  onClick={() => trackUi("creators.hero", "click", "stream")}
                />
              }
            >
              {t("d2Pages.creators.hero.cta")}
            </Button>
            {twitchImport && (
              <Button
                variant="outline"
                size="lg"
                data-testid="creators-hero-import"
                nativeButton={false}
                className="min-h-11 px-4"
                render={
                  <a
                    href={SIGNUP_IMPORT}
                    aria-label={t("d2Pages.creators.hero.import")}
                    onClick={() => trackUi("creators.import", "click", "import")}
                  />
                }
              >
                {t("d2Pages.creators.hero.import")}
              </Button>
            )}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {(
              [
                "d2Pages.creators.hero.proof.free",
                "d2Pages.creators.hero.proof.obs",
                "d2Pages.creators.hero.proof.source",
              ] as const
            ).map((key) => (
              <li key={key} className="inline-flex items-center gap-1.5">
                <HugeiconsIcon icon={Tick02Icon} className="size-4 text-brand-text" strokeWidth={2} aria-hidden />
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
        {live && (
          <div data-testid="creators-live" className="relative min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("d2Pages.creators.hero.live", { site })}
              </p>
              <Link to="/directory" className={`text-sm text-muted-foreground ${linkClass}`}>
                {t("d2Pages.creators.hero.liveAll")}
              </Link>
            </div>
            <DiscoveryStreamCard card={live} headingLevel={3} lazy={false} showReason={false} />
          </div>
        )}
      </section>

      {/* Calculator */}
      <section id="calculator" aria-labelledby="creators-calc" className="scroll-mt-20">
        <SectionTitle id="creators-calc">{t("d2Pages.creators.calc.title")}</SectionTitle>
        <p className="-mt-1 mb-4 max-w-prose text-muted-foreground">{t("d2Pages.creators.calc.intro")}</p>
        {facts === null ? (
          <RouteSectionLoadError
            section={t("d2Pages.creators.calc.title")}
            headingLevel={3}
            data-testid="creators-calc-error"
          />
        ) : share === null ? (
          <p data-testid="creators-calc-noshare" className="text-muted-foreground">
            {t("d2Pages.creators.calc.noShare")}
          </p>
        ) : (
          <FeeCalculator creatorShare={share} payout={payout} site={site} />
        )}
      </section>

      {/* No audience gate */}
      <section aria-labelledby="creators-gate">
        <SectionTitle id="creators-gate">{t("d2Pages.creators.gate.title")}</SectionTitle>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="bg-card p-5 ring-1 ring-border">
            <Glyph icon={Coins01Icon} />
            <h3 className="text-lg font-semibold">{t("d2Pages.creators.gate.earn.title")}</h3>
            <p className="mt-1.5 text-muted-foreground">{t("d2Pages.creators.gate.earn.body")}</p>
          </div>
          <div className="bg-card p-5 ring-1 ring-border">
            <Glyph icon={Shield01Icon} />
            <h3 className="text-lg font-semibold">{t("d2Pages.creators.gate.fees.title")}</h3>
            <p className="mt-1.5 text-muted-foreground">
              {creatorShare
                ? t("d2Pages.creators.gate.fees.body", { creatorShare })
                : t("d2Pages.creators.gate.fees.bodyNoShare")}
            </p>
          </div>
          <div className="bg-card p-5 ring-1 ring-border">
            <Glyph icon={UserGroupIcon} />
            <h3 className="text-lg font-semibold">{t("d2Pages.creators.gate.owner.title")}</h3>
            <p className="mt-1.5 text-muted-foreground">
              {membership
                ? t("d2Pages.creators.gate.owner.body", {
                    hours: membership.streamerHours,
                    viewers: membership.streamerViewers,
                    days: membership.windowDays,
                  })
                : t("d2Pages.creators.gate.owner.bodyNoRules")}
            </p>
          </div>
        </div>
        {payout && (
          <p data-testid="creators-gate-payout" className="mt-3 text-sm text-muted-foreground">
            {t("d2Pages.creators.gate.payout", { minimum: money(payout.minimumCents), holdDays: payout.holdDays })}
          </p>
        )}
      </section>

      {/* Steps */}
      <section aria-labelledby="creators-steps">
        <SectionTitle id="creators-steps">{t("d2Pages.creators.steps.title", { count: STEPS.length })}</SectionTitle>
        <ol className="grid gap-px bg-border ring-1 ring-border md:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="bg-card p-5">
              <span
                aria-hidden
                className="mb-3 grid size-7 place-items-center font-semibold tabular-nums ring-1 ring-border ring-inset"
              >
                {i + 1}
              </span>
              <p className="text-lg font-semibold">{t(step.title)}</p>
              <p className="text-muted-foreground">{t(step.body)}</p>
              <p className="mt-2 text-xs text-muted-foreground">{t(step.time)}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-muted-foreground">{t("d2Pages.creators.steps.works")}</p>
      </section>

      {/* Import: only while the Twitch import is on (ADR 0031, round 2 open question 1). */}
      {twitchImport && (
        <section id="import" data-testid="creators-import" aria-labelledby="creators-import-title">
          <SectionTitle id="creators-import-title">{t("d2Pages.creators.import.title")}</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col items-start gap-3 bg-card p-6 ring-1 ring-border">
              <Glyph icon={Download01Icon} />
              <h3 className="text-lg font-semibold">{t("d2Pages.creators.import.twitch.title")}</h3>
              <p className="text-muted-foreground">{t("d2Pages.creators.import.twitch.body")}</p>
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={SIGNUP_IMPORT}
                    aria-label={t("d2Pages.creators.hero.import")}
                    onClick={() => trackUi("creators.import", "click", "import")}
                  />
                }
              >
                {t("d2Pages.creators.hero.import")}
              </Button>
            </div>
            <div className="flex flex-col items-start gap-3 bg-card p-6 ring-1 ring-border">
              <Glyph icon={ArrowRight01Icon} />
              <h3 className="text-lg font-semibold">{t("d2Pages.creators.import.move.title")}</h3>
              <p className="text-muted-foreground">{t("d2Pages.creators.import.move.body")}</p>
            </div>
          </div>
        </section>
      )}

      {/* Tools */}
      <section aria-labelledby="creators-tools">
        <SectionTitle id="creators-tools">{t("d2Pages.creators.tools.title")}</SectionTitle>
        <ul className="grid gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
          {TOOLS.map((tool) => (
            <li key={tool.title} className="flex gap-3">
              <HugeiconsIcon icon={tool.icon} className="size-6 shrink-0" strokeWidth={1.8} aria-hidden />
              <div className="min-w-0">
                <p className="text-base font-semibold">{t(tool.title)}</p>
                <p className="text-muted-foreground">{t(tool.body)}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Who sets the cut */}
      {creatorShare && coopShare && share !== null && (
        <section id="cut" aria-labelledby="creators-cut" className="scroll-mt-20">
          <div className="grid gap-4 bg-card p-6 ring-1 ring-border lg:grid-cols-2 lg:items-center lg:p-8">
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("d2Pages.creators.cut.eyebrow")}
              </p>
              <h2 id="creators-cut" className="text-2xl font-semibold tracking-tight">
                {t("d2Pages.creators.cut.title")}
              </h2>
              <p className="text-muted-foreground">{t("d2Pages.creators.cut.body")}</p>
              <Link to="/transparency" className={`self-start ${linkClass}`}>
                {t("d2Pages.creators.cut.link")}
              </Link>
            </div>
            <div className="flex flex-col gap-2">
              <BreakdownBar
                data-testid="creators-cut-split"
                label={t("d2Pages.creators.cut.eyebrow")}
                segments={[
                  { id: "creators", label: t("d2Pages.creators.cut.creatorsLabel"), value: share },
                  { id: "coop", label: t("d2Pages.creators.cut.coopLabel"), value: 1 - share },
                ]}
                formatLabel={() => t("d2Pages.creators.cut.bar", { creatorShare, coopShare })}
                formatValue={(value) => pct(value)}
                legendLayout="inline"
              />
              {typeof facts?.cutChanges === "number" && (
                <p className="text-sm text-muted-foreground">
                  {t("d2Pages.creators.cut.changes", { changes: facts.cutChanges })}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* FAQ */}
      <section aria-labelledby="creators-faq" className="max-w-215">
        <SectionTitle id="creators-faq">{t("d2Pages.creators.faq.title")}</SectionTitle>
        <Accordion data-testid="creators-faq" defaultValue={["fee"]}>
          {creatorShare && coopShare && (
            <FaqItem value="fee" q={t("d2Pages.creators.faq.fee.q")}>
              {t("d2Pages.creators.faq.fee.a", { creatorShare, coopShare })}
            </FaqItem>
          )}
          {payout && (
            <FaqItem value="paid" q={t("d2Pages.creators.faq.paid.q")}>
              {t("d2Pages.creators.faq.paid.a", { minimum: money(payout.minimumCents), holdDays: payout.holdDays })}
            </FaqItem>
          )}
          {creatorShare && kick && twitch && (
            <FaqItem value="compare" q={t("d2Pages.creators.faq.compare.q")}>
              {t("d2Pages.creators.faq.compare.a", {
                kickShare: pct(kick.subShare),
                twitchShare: pct(twitch.subShare),
                twitchAlt: pct(twitch.altSubShare ?? twitch.subShare),
                creatorShare,
              })}
            </FaqItem>
          )}
          <FaqItem value="leave" q={t("d2Pages.creators.faq.leave.q")}>
            {t("d2Pages.creators.faq.leave.a")}
            {membership?.refundableOnExit && (
              <> {t("d2Pages.creators.faq.leave.share", { shareAmount: money(membership.shareCents) })}</>
            )}
          </FaqItem>
          <FaqItem value="mature" q={t("d2Pages.creators.faq.mature.q")}>
            {t("d2Pages.creators.faq.mature.a")}{" "}
            <Link to="/guidelines" className={linkClass}>
              {t("d2Pages.creators.faq.mature.link")}
            </Link>
          </FaqItem>
          <FaqItem value="owner" q={t("d2Pages.creators.faq.owner.q", { site })}>
            {typeof membership?.minSubCents === "number"
              ? t("d2Pages.creators.faq.owner.a", { minSub: money(membership.minSubCents) })
              : t("d2Pages.creators.faq.owner.aNoSub")}
          </FaqItem>
          {creatorShare && facts?.protections && (
            <FaqItem value="change" q={t("d2Pages.creators.faq.change.q", { creatorShare })}>
              {t("d2Pages.creators.faq.change.a", {
                memberWide: pct(facts.protections.memberWide),
                streamerClass: pct(facts.protections.streamerClass),
              })}
            </FaqItem>
          )}
        </Accordion>
      </section>

      {/* Claim */}
      <section id="claim" aria-labelledby="creators-claim" className="scroll-mt-20">
        <div className="relative overflow-hidden bg-surface-sunken px-6 py-8 ring-1 ring-border ring-inset md:p-12">
          <Arcs className="pointer-events-none absolute -end-16 -bottom-16 w-75 text-muted-foreground opacity-10" />
          <p className="relative text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("d2Pages.creators.claim.eyebrow")}
          </p>
          <h2 id="creators-claim" className="relative mt-2 mb-4 text-2xl font-semibold tracking-tight">
            {t("d2Pages.creators.claim.title")}
          </h2>
          <div className="relative">
            <ClaimField host={host} check={check} go={go} />
          </div>
        </div>
      </section>
    </PageContainer>
  );
}

const STEPS = [
  {
    title: "d2Pages.creators.steps.account.title",
    body: "d2Pages.creators.steps.account.body",
    time: "d2Pages.creators.steps.account.time",
  },
  {
    title: "d2Pages.creators.steps.channel.title",
    body: "d2Pages.creators.steps.channel.body",
    time: "d2Pages.creators.steps.channel.time",
  },
  {
    title: "d2Pages.creators.steps.encoder.title",
    body: "d2Pages.creators.steps.encoder.body",
    time: "d2Pages.creators.steps.encoder.time",
  },
  {
    title: "d2Pages.creators.steps.live.title",
    body: "d2Pages.creators.steps.live.body",
    time: "d2Pages.creators.steps.live.time",
  },
] as const;

const TOOLS = [
  {
    icon: SecurityCheckIcon,
    title: "d2Pages.creators.tools.verified.title",
    body: "d2Pages.creators.tools.verified.body",
  },
  {
    icon: Analytics01Icon,
    title: "d2Pages.creators.tools.breakdown.title",
    body: "d2Pages.creators.tools.breakdown.body",
  },
  {
    icon: ViewIcon,
    title: "d2Pages.creators.tools.rehearsal.title",
    body: "d2Pages.creators.tools.rehearsal.body",
  },
  {
    icon: Link01Icon,
    title: "d2Pages.creators.tools.bundle.title",
    body: "d2Pages.creators.tools.bundle.body",
  },
] as const;

function FaqItem({ value, q, children }: { value: string; q: string; children: React.ReactNode }) {
  return (
    <AccordionItem value={value} data-testid="creators-faq-item" data-faq={value}>
      <AccordionTrigger className="text-base">{q}</AccordionTrigger>
      <AccordionContent>
        <p className="max-w-prose text-muted-foreground">{children}</p>
      </AccordionContent>
    </AccordionItem>
  );
}
