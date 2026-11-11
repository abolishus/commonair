// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ConfirmDialog,
  EmptyState,
  RelativeTime,
  Skeleton,
  SkeletonGroup,
  formatMoney,
  formatNumber,
  useLocale,
} from "@commonair/ui";
import {
  EligibilityList,
  GovernanceOutcomeList,
  MembershipList,
  ShareCard,
  ShareInstructions,
} from "@commonair/ui/blocks/coop";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@commonair/ui/components/accordion";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  JusticeScale01Icon,
  LockIcon,
  SourceCodeIcon,
  UserGroupIcon,
  ViewOffIcon,
  VoteIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { z } from "zod";
import { t } from "../../i18n/index.ts";
import {
  basisLabel,
  canBuyShare,
  classLabel,
  exitRefundsShare,
  membersByClass,
  membershipStatusLabel,
  shareStatusLabel,
  type CoopMonthDto,
  type EligibilityDto,
  type MemberClass,
  type MembershipViewDto,
  type SettingDto,
} from "../../lib/coop.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { FirstVoteNote, type FirstVoteChoice } from "./first-vote.tsx";
import { CoopTabs } from "./nav.tsx";
import { recentDecisions } from "./overview.tsx";
import { canRejoinViewer } from "./rules.ts";
import { outcomeItem } from "./transparency.tsx";

/** What `coop.buyShare` returned with the manual provider. */
export interface ShareInstructionsDto {
  paymentId: string;
  reference: string;
  instructions: string;
  amount: { cents: number; currency: string };
}

export interface MembershipPanelProps {
  /** null while loading. */
  view: MembershipViewDto | null;
  /** From `membership.classes`; null while the settings load (or when unreadable). */
  rules: { shareCents: number; refundableOnExit: boolean } | null;
  /** Instance currency (the share's price before one exists). */
  currency: string;
  /** Set after buying; a pending share loaded later carries the same details in `view.share`. */
  instructions: ShareInstructionsDto | null;
  buying: boolean;
  onBuy: () => void | Promise<void>;
  onExit: (cls: MemberClass) => Promise<void>;
  onExitError: (err: unknown) => void;
  /** `coop.join({ class: "viewer" })`, then a refreshed view; omitted: no rejoin offered. */
  onRejoin?: () => Promise<void>;
  onRejoinError?: (err: unknown) => void;
  /** Batch 8: the page offers "Pay by card" (`share-buy-stripe`) instead of the bank-transfer buy. */
  hideBuy?: boolean;
  /** Wave 2: above the memberships (the pitch for a non-member, the first vote for a member). */
  lead?: React.ReactNode;
  /** Wave 2: below them (the rest of the pitch for a non-member). */
  after?: React.ReactNode;
}

function progressText(e: EligibilityDto, currency: string, locale: string): string {
  if (!e.progress) return "";
  if (e.progress.unit === "cents")
    return t("coop.eligibility.cents", {
      have: formatMoney(Math.round(e.progress.have), currency, locale),
      need: formatMoney(Math.round(e.progress.need), currency, locale),
    });
  return t("coop.eligibility.hours", {
    have: formatNumber(e.progress.have, locale),
    need: formatNumber(e.progress.need, locale),
  });
}

/** `/coop/membership`: memberships with exit, eligibility per class, and the member share. */
export function MembershipPanel({
  view,
  rules,
  currency,
  instructions: bought,
  buying,
  onBuy,
  onExit,
  onExitError,
  onRejoin,
  onRejoinError,
  hideBuy = false,
  lead = null,
  after = null,
}: MembershipPanelProps): React.JSX.Element {
  const { locale } = useLocale();
  const share = view?.share ?? null;
  const instructions: ShareInstructionsDto | null =
    bought ??
    (share?.status === "pending" && share.paymentId && share.reference && share.instructions
      ? {
          paymentId: share.paymentId,
          reference: share.reference,
          instructions: share.instructions,
          amount: share.amount,
        }
      : null);
  const shareStatus = instructions && !share ? "pending" : (share?.status ?? "none");
  const price = rules ? { cents: rules.shareCents, currency } : null;
  const amount = share?.amount ?? instructions?.amount ?? price;
  const shareNote =
    shareStatus === "none"
      ? t("coop.share.noteNone")
      : shareStatus === "pending"
        ? t("coop.share.notePending")
        : shareStatus === "held"
          ? rules?.refundableOnExit === false
            ? t("coop.share.noteHeldKept")
            : t("coop.share.noteHeld")
          : shareStatus === "refund_pending"
            ? t("coop.share.noteRefundPending")
            : undefined;
  return (
    <PageContainer data-testid="membership" width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("coop.membership.title")}
        description={t("coop.membership.intro")}
        tabs={<CoopTabs current="membership" />}
      />
      {lead}
      {view === null ? (
        <SkeletonGroup label={t("coop.loading")}>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </SkeletonGroup>
      ) : (
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Section heading={t("coop.membership.memberships")}>
                <MembershipList
                  label={t("coop.membership.memberships")}
                  itemProps={{ "data-testid": "membership-row" }}
                  empty={
                    <EmptyState
                      icon={UserGroupIcon}
                      headingLevel={3}
                      title={t("coop.membership.emptyTitle")}
                      description={t("coop.membership.emptyHint")}
                    />
                  }
                  items={view.memberships.map((m) => ({
                    id: m.id,
                    memberClass: m.class,
                    classLabel: classLabel(m.class),
                    status: m.status,
                    statusLabel: membershipStatusLabel(m.status),
                    basis: m.basis,
                    basisLabel: basisLabel(m.basis),
                    since: <RelativeTime date={m.joinedAt} />,
                    exit:
                      m.status === "active"
                        ? {
                            label: t("coop.exit.label"),
                            confirmTitle: t("coop.exit.title", { class: classLabel(m.class) }),
                            confirmDescription: exitRefundsShare(view, m.class, rules?.refundableOnExit ?? null)
                              ? t("coop.exit.refunded")
                              : m.class === "viewer" && view.share?.status === "held"
                                ? t("coop.exit.notRefunded")
                                : t("coop.exit.noShare"),
                            confirmLabel: t("coop.exit.confirm"),
                            destructive: true,
                            onConfirm: () => onExit(m.class),
                            onError: onExitError,
                            triggerProps: { "data-testid": `membership-exit-${m.class}` },
                            dialogProps: { "data-testid": "membership-exit-confirm" },
                          }
                        : undefined,
                  }))}
                />
                {onRejoin && canRejoinViewer(view) && (
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-muted-foreground">{t("coop.rejoin.hint")}</p>
                    <ConfirmDialog
                      trigger={
                        <Button data-testid="membership-rejoin-viewer" variant="outline" size="sm">
                          {t("coop.rejoin.label")}
                        </Button>
                      }
                      title={t("coop.rejoin.title")}
                      description={t("coop.rejoin.description")}
                      confirmLabel={t("coop.rejoin.confirm")}
                      onConfirm={onRejoin}
                      onError={onRejoinError}
                    />
                  </div>
                )}
              </Section>
              <Section heading={t("coop.eligibility.title")} description={t("coop.eligibility.intro")}>
                <EligibilityList
                  itemProps={{ "data-testid": "membership-eligibility" }}
                  items={view.eligibility.map((e) => ({
                    memberClass: e.class,
                    classLabel: classLabel(e.class),
                    eligible: e.eligible,
                    statusLabel: e.eligible ? t("coop.eligibility.eligible") : t("coop.eligibility.notYet"),
                    basis: e.basis,
                    basisLabel: e.basis ? basisLabel(e.basis) : undefined,
                    progress: e.progress
                      ? {
                          label:
                            e.progress.unit === "hours"
                              ? t("coop.eligibility.hoursLabel")
                              : t("coop.eligibility.centsLabel"),
                          have: e.progress.have,
                          need: e.progress.need,
                          unit: e.progress.unit,
                          valueText: progressText(e, currency, locale),
                        }
                      : null,
                    detail: e.detail || undefined,
                  }))}
                />
              </Section>
            </div>
          }
          aside={
            // The pitch's "Become a member" scrolls here (`#membership-options`).
            <div id="membership-options" className="scroll-mt-20">
              <ShareCard
                data-testid="membership-share"
                title={t("coop.share.title")}
                description={t("coop.share.description")}
                status={shareStatus}
                statusLabel={shareStatusLabel(shareStatus)}
                amount={amount}
                amountLabel={t("coop.share.amount")}
                note={shareNote}
                buy={
                  canBuyShare(view) && !instructions && !hideBuy
                    ? {
                        label: t("coop.share.buy"),
                        onBuy,
                        pending: buying,
                        props: { "data-testid": "membership-buy-share" },
                      }
                    : undefined
                }
                instructions={
                  instructions ? (
                    <ShareInstructions
                      data-testid="membership-share-instructions"
                      title={t("coop.share.instructionsTitle")}
                      instructions={instructions.instructions}
                      amount={instructions.amount}
                      amountLabel={t("coop.share.amount")}
                      reference={instructions.reference}
                      referenceLabel={t("coop.share.reference")}
                      copyLabel={t("coop.share.copy")}
                      copiedLabel={t("coop.share.copied")}
                      copyFailedLabel={t("coop.share.copyFailed")}
                      paymentId={instructions.paymentId}
                    />
                  ) : undefined
                }
              />
            </div>
          }
        />
      )}
      {after}
    </PageContainer>
  );
}

// ── The public pitch (overhaul wave 2, D2.5) ──────────────────────────────────────────────────

/** The settings the pitch reads (governance defaults for the fields the seed may lack). */
const PitchClasses = z.object({
  streamer: z.object({
    minStreamingHours: z.number().min(0),
    windowDays: z.number().int().min(1),
    minVerifiedViewers: z.number().int().min(1).default(2),
  }),
  viewer: z.object({
    shareCents: z.number().int().min(0),
    shareRefundableOnExit: z.boolean(),
    activeSubscriptionQualifies: z.boolean(),
    minSubscriptionCents: z.number().int().min(0).default(300),
  }),
});
const PitchCut = z.object({ streamerShare: z.number().min(0).max(1) });
const PitchOrdinary = z.object({ threshold: z.number(), quorum: z.number() });
const PitchProtections = z.object({
  memberWideThreshold: z.number(),
  streamerClassThreshold: z.number(),
  quorum: z.number(),
  streamerClassQuorum: z.number(),
});
const PitchSeats = z.object({ streamer: z.number().int(), viewer: z.number().int(), worker: z.number().int() });

/** Every number the pitch states, from the co-op's own settings: none is a literal in copy. */
export interface PitchFacts {
  shareCents: number;
  refundable: boolean;
  subQualifies: boolean;
  minSubCents: number;
  streamerHours: number;
  streamerViewers: number;
  streamerDays: number;
  /** `platform.cut` streamer share (0 to 1); null when unreadable (the line is left out). */
  creatorShare: number | null;
  ordinary: z.infer<typeof PitchOrdinary> | null;
  protections: z.infer<typeof PitchProtections> | null;
  seats: z.infer<typeof PitchSeats> | null;
}

/** The facts from `coop.settings`; null without a readable `membership.classes` (pure). */
export function pitchFacts(settings: readonly Pick<SettingDto, "key" | "value">[] | null): PitchFacts | null {
  const read = <S extends z.ZodType>(key: string, shape: S): z.output<S> | null => {
    const parsed = shape.safeParse(settings?.find((s) => s.key === key)?.value);
    return parsed.success ? parsed.data : null;
  };
  const classes = read("membership.classes", PitchClasses);
  if (!classes) return null;
  return {
    shareCents: classes.viewer.shareCents,
    refundable: classes.viewer.shareRefundableOnExit,
    subQualifies: classes.viewer.activeSubscriptionQualifies,
    minSubCents: classes.viewer.minSubscriptionCents,
    streamerHours: classes.streamer.minStreamingHours,
    streamerViewers: classes.streamer.minVerifiedViewers,
    streamerDays: classes.streamer.windowDays,
    creatorShare: read("platform.cut", PitchCut)?.streamerShare ?? null,
    ordinary: read("governance.ordinary", PitchOrdinary),
    protections: read("governance.protections", PitchProtections),
    seats: read("board.seats", PitchSeats),
  };
}

/** A share (0 to 1) as a percentage in `locale`: 0.9 → "90%", 2/3 → "66.7%". */
export function formatShare(share: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(share);
}

/** Whether `view` holds any active membership (members keep the full page; others see the pitch). */
export function isMember(view: Pick<MembershipViewDto, "memberships"> | null): boolean {
  return view?.memberships.some((m) => m.status === "active") ?? false;
}

/** The sign-up link the pitch's CTA opens: intent `join`, back to this page after verification. */
export const JOIN_SIGNUP_HREF = `/signup?intent=join&redirect=${encodeURIComponent("/coop/membership")}`;

/** The page's one filled CTA: sign up with intent `join`, or (signed in) scroll to the options. */
function PitchCta({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const click = () => trackUi("coop.membership", "click", "join");
  const label = signedIn ? t("d2Membership.pitch.cta.signedIn") : t("d2Membership.pitch.cta.signedOut");
  return (
    <Button
      data-testid="membership-pitch-cta"
      data-filled-cta=""
      variant="brand"
      size="lg"
      nativeButton={false}
      render={<a href={signedIn ? "#membership-options" : JOIN_SIGNUP_HREF} aria-label={label} onClick={click} />}
    >
      {label}
    </Button>
  );
}

export interface MembershipPitchProps {
  /** null while the settings load. */
  facts: PitchFacts | null;
  currency: string;
  siteName: string;
  /** The instance's source repository, linked from the commitments; null: no link. */
  sourceUrl: string | null;
  /** Newest first; null while loading (or when it failed: the stats and decisions are left out). */
  months: CoopMonthDto[] | null;
  /** Signed in without an active membership: the CTA scrolls to the options below the hero. */
  signedIn: boolean;
}

function Stat({ value, label, testId }: { value: React.ReactNode; label: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted p-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="-order-1 text-2xl font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/** The hero: headline, the creator share, the CTA and live numbers from the co-op's records. */
export function PitchHero({
  facts,
  months,
  signedIn,
  siteName,
  headingLevel = 1,
}: Pick<MembershipPitchProps, "facts" | "months" | "signedIn" | "siteName"> & {
  headingLevel?: 1 | 2;
}): React.JSX.Element {
  const { locale } = useLocale();
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const counts = months ? membersByClass(months) : null;
  const total = counts ? counts.streamer + counts.viewer + counts.worker : null;
  const last = months ? recentDecisions(months)[0]?.decidedAt : undefined;
  const cut = facts?.creatorShare ?? null;
  return (
    <section
      data-testid="membership-pitch-hero"
      aria-labelledby="membership-pitch-title"
      className="grid gap-6 rounded-xl border border-border bg-card p-6 md:p-10 lg:grid-cols-[3fr_2fr]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-sm font-medium text-brand-text">{t("d2Membership.pitch.eyebrow", { site: siteName })}</p>
        <Heading id="membership-pitch-title" className="font-display text-display text-balance">
          {t("d2Membership.pitch.title")}
        </Heading>
        <p className="max-w-prose text-base text-muted-foreground">
          {cut !== null
            ? t("d2Membership.pitch.body", { creatorShare: formatShare(cut, locale) })
            : t("d2Membership.pitch.bodyNoCut")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <PitchCta signedIn={signedIn} />
          <Button
            variant="ghost"
            size="lg"
            nativeButton={false}
            render={<a href="#membership-ways" aria-label={t("d2Membership.pitch.how")} />}
          >
            {t("d2Membership.pitch.how")}
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden />
          </Button>
        </div>
      </div>
      {(total !== null || cut !== null) && (
        <div className="flex min-w-0 flex-col justify-end gap-2">
          <dl
            data-testid="membership-pitch-stats"
            aria-label={t("d2Membership.pitch.stats.label")}
            className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3"
          >
            {total !== null && (
              <Stat
                testId="membership-pitch-members"
                value={formatNumber(total, locale)}
                label={t("d2Membership.pitch.stats.members", { count: total })}
              />
            )}
            {cut !== null && <Stat value={formatShare(cut, locale)} label={t("d2Membership.pitch.stats.creators")} />}
            {last && <Stat value={<RelativeTime date={last} />} label={t("d2Membership.pitch.stats.lastDecision")} />}
          </dl>
          {total !== null && <p className="text-xs text-muted-foreground">{t("d2Membership.pitch.stats.source")}</p>}
        </div>
      )}
    </section>
  );
}

function WayCard({
  testId,
  title,
  price,
  children,
}: {
  testId: string;
  title: string;
  price?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        {price && (
          <CardDescription className="text-2xl font-semibold text-foreground tabular-nums">{price}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">{children}</CardContent>
    </Card>
  );
}

function GetItem({
  icon,
  title,
  hint,
}: {
  icon: IconSvgElement;
  title: React.ReactNode;
  hint?: string;
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">{title}</p>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
    </li>
  );
}

/** Below the hero: the ways in, what members get, the commitments, recent decisions and the FAQ. */
export function PitchDetails({
  facts,
  currency,
  siteName,
  sourceUrl,
  months,
}: Omit<MembershipPitchProps, "signedIn">): React.JSX.Element | null {
  const { locale } = useLocale();
  if (!facts) return null;
  const share = formatMoney(facts.shareCents, currency, locale);
  const minSub = formatMoney(facts.minSubCents, currency, locale);
  const decisions = months ? recentDecisions(months) : [];
  const surplus = months?.[0]?.surplus.cents ?? null;
  return (
    <div className="flex flex-col gap-10">
      <Section id="membership-ways" className="scroll-mt-20" heading={t("d2Membership.ways.title")}>
        <div className="grid gap-4 md:grid-cols-3">
          <WayCard testId="membership-way-viewer" title={t("d2Membership.way.viewer.title")} price={share}>
            <p>
              {facts.refundable
                ? t("d2Membership.way.viewer.share", { shareAmount: share })
                : t("d2Membership.way.viewer.shareKept", { shareAmount: share })}
            </p>
            {facts.subQualifies && (
              <p className="text-muted-foreground">{t("d2Membership.way.viewer.sub", { minSub })}</p>
            )}
          </WayCard>
          <WayCard testId="membership-way-streamer" title={t("d2Membership.way.streamer.title")}>
            <p>{t("d2Membership.way.streamer.body", { hours: facts.streamerHours, viewers: facts.streamerViewers })}</p>
            <p className="text-muted-foreground">
              {t("d2Membership.way.streamer.window", { days: facts.streamerDays })}
            </p>
          </WayCard>
          <WayCard testId="membership-way-worker" title={t("d2Membership.way.worker.title")}>
            <p>{t("d2Membership.way.worker.body")}</p>
            <p className="text-muted-foreground">{t("d2Membership.way.worker.hint")}</p>
          </WayCard>
        </div>
      </Section>
      <Section heading={t("d2Membership.gets.title")}>
        <ul className="grid gap-4 md:grid-cols-2">
          <GetItem icon={VoteIcon} title={t("d2Membership.gets.vote")} hint={t("d2Membership.gets.voteHint")} />
          <GetItem
            icon={UserGroupIcon}
            title={t("d2Membership.gets.board")}
            hint={facts.seats ? t("d2Membership.gets.boardHint", { ...facts.seats }) : undefined}
          />
          <GetItem
            icon={JusticeScale01Icon}
            title={t("d2Membership.gets.jury")}
            hint={t("d2Membership.gets.juryHint")}
          />
          <GetItem icon={BookOpen01Icon} title={t("d2Membership.gets.books")} hint={t("d2Membership.gets.booksHint")} />
        </ul>
        <AlertCallout
          data-testid="membership-pitch-patronage"
          className="max-w-3xl"
          description={
            <p>
              {surplus !== null && surplus <= 0 ? t("d2Membership.patronageNone") : t("d2Membership.patronage")}{" "}
              <Link to="/transparency" className="underline underline-offset-4">
                {t("d2Membership.books")}
              </Link>
            </p>
          }
        />
      </Section>
      <Section heading={t("d2Membership.commitments.title")}>
        <ul className="grid gap-4 md:grid-cols-2">
          <GetItem icon={LockIcon} title={t("d2Membership.commitments.cut")} />
          <GetItem icon={BookOpen01Icon} title={t("d2Membership.commitments.books")} />
          <GetItem icon={ViewOffIcon} title={t("d2Membership.commitments.trackers")} />
          <GetItem
            icon={SourceCodeIcon}
            title={
              sourceUrl ? (
                <a href={sourceUrl} className="underline underline-offset-4" rel="noopener">
                  {t("d2Membership.commitments.source")}
                </a>
              ) : (
                t("d2Membership.commitments.source")
              )
            }
          />
        </ul>
      </Section>
      {decisions.length > 0 && (
        <Section
          heading={t("d2Membership.decisions.title")}
          action={
            <Button
              variant="ghost"
              size="xs"
              nativeButton={false}
              render={<Link to="/coop/proposals" search={{ status: "decided" }} />}
            >
              {t("d2Membership.decisions.all")}
            </Button>
          }
        >
          <GovernanceOutcomeList
            data-testid="membership-pitch-decisions"
            label={t("d2Membership.decisions.title")}
            items={decisions.map(outcomeItem)}
          />
        </Section>
      )}
      <Section heading={t("d2Membership.faq.title")}>
        <Accordion data-testid="membership-faq" className="max-w-3xl">
          <AccordionItem value="refund">
            <AccordionTrigger>{t("d2Membership.faq.refund.q", { shareAmount: share })}</AccordionTrigger>
            <AccordionContent>
              {facts.refundable ? t("d2Membership.faq.refund.a") : t("d2Membership.faq.refund.aKept")}
            </AccordionContent>
          </AccordionItem>
          {facts.subQualifies && (
            <AccordionItem value="sub">
              <AccordionTrigger>{t("d2Membership.faq.sub.q")}</AccordionTrigger>
              <AccordionContent>{t("d2Membership.faq.sub.a", { minSub })}</AccordionContent>
            </AccordionItem>
          )}
          {facts.ordinary && facts.protections && (
            <AccordionItem value="vote">
              <AccordionTrigger>{t("d2Membership.faq.vote.q")}</AccordionTrigger>
              <AccordionContent data-testid="membership-faq-vote">
                <p>
                  {t("d2Membership.faq.vote.ordinary", {
                    quorum: formatShare(facts.ordinary.quorum, locale),
                    threshold: formatShare(facts.ordinary.threshold, locale),
                  })}
                </p>
                <p className="mt-2">
                  {t("d2Membership.faq.vote.protected", {
                    quorum: formatShare(facts.protections.quorum, locale),
                    threshold: formatShare(facts.protections.memberWideThreshold, locale),
                    streamerQuorum: formatShare(facts.protections.streamerClassQuorum, locale),
                    streamerThreshold: formatShare(facts.protections.streamerClassThreshold, locale),
                  })}
                </p>
              </AccordionContent>
            </AccordionItem>
          )}
          <AccordionItem value="first">
            <AccordionTrigger>{t("d2Membership.faq.first.q")}</AccordionTrigger>
            <AccordionContent>{t("d2Membership.faq.first.a")}</AccordionContent>
          </AccordionItem>
          <AccordionItem value="streamer">
            <AccordionTrigger>{t("d2Membership.faq.streamer.q")}</AccordionTrigger>
            <AccordionContent>
              {t("d2Membership.faq.streamer.a", {
                hours: facts.streamerHours,
                viewers: facts.streamerViewers,
                days: facts.streamerDays,
                site: siteName,
              })}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
    </div>
  );
}

/** The closing band's line: the share, and the sub route when the co-op counts subs. */
export function endLine(facts: PitchFacts, currency: string, locale: string): string {
  const shareAmount = formatMoney(facts.shareCents, currency, locale);
  const minSub = formatMoney(facts.minSubCents, currency, locale);
  if (!facts.subQualifies)
    return facts.refundable
      ? t("d2Membership.end.shareOnly", { shareAmount })
      : t("d2Membership.end.shareOnlyKept", { shareAmount });
  return facts.refundable
    ? t("d2Membership.end.body", { shareAmount, minSub })
    : t("d2Membership.end.bodyKept", { shareAmount, minSub });
}

/** The closing band for a signed-out visitor: the headline again and the CTA. */
function PitchEnd({ facts, currency }: { facts: PitchFacts; currency: string }): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <section
      aria-labelledby="membership-pitch-end"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 md:flex-row md:items-center md:justify-between md:p-10"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h2 id="membership-pitch-end" className="font-display text-2xl font-semibold text-balance">
          {t("d2Membership.pitch.title")}
        </h2>
        <p className="text-muted-foreground">{endLine(facts, currency, locale)}</p>
      </div>
      <PitchCta signedIn={false} />
    </section>
  );
}

/** `/coop/membership` for a signed-out visitor: the whole pitch. */
export function MembershipPitch(props: MembershipPitchProps): React.JSX.Element {
  React.useEffect(() => {
    trackUi("coop.membership", "view");
  }, []);
  return (
    <PageContainer data-testid="membership-pitch" width="wide" className="flex flex-col gap-10 py-8">
      <CoopTabs current="membership" />
      {props.facts === null ? (
        <SkeletonGroup label={t("coop.loading")}>
          <Skeleton className="h-72 w-full" />
        </SkeletonGroup>
      ) : (
        <>
          <PitchHero {...props} />
          <PitchDetails {...props} />
          <PitchEnd facts={props.facts} currency={props.currency} />
        </>
      )}
    </PageContainer>
  );
}

/** For a signed-in non-member, above today's panel: the hero and the subscription route in. */
export function MembershipPitchLead(props: MembershipPitchProps): React.JSX.Element {
  const { locale } = useLocale();
  React.useEffect(() => {
    trackUi("coop.membership", "view");
  }, []);
  const facts = props.facts;
  return (
    <div data-testid="membership-pitch" className="flex flex-col gap-4">
      <PitchHero {...props} headingLevel={2} />
      {facts?.subQualifies && (
        <Card data-testid="membership-pitch-sub" size="sm">
          <CardHeader>
            <CardTitle>
              <h3>
                {t("d2Membership.options.subTitle", { minSub: formatMoney(facts.minSubCents, props.currency, locale) })}
              </h3>
            </CardTitle>
            <CardDescription>{t("d2Membership.options.subBody")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/directory" />}>
              {t("d2Membership.options.findChannel")}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** For a member, above today's panel: their first vote from the real electorate. */
export function MemberVoteCard({ choice }: { choice: FirstVoteChoice | null }): React.JSX.Element | null {
  if (!choice) return null;
  return (
    <Card data-testid="membership-first-vote" size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("d2Membership.member.voteTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <FirstVoteNote choice={choice} />
      </CardContent>
    </Card>
  );
}
