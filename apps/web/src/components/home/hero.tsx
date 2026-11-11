// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The top of home (D2.3, D3.1). Signed out: the display headline, "Create free account" (the
 * page's one filled CTA, `data-filled-cta`), "Browse live", a quiet "Stream on {site}" link, the
 * co-op promise strip with one hard number, and one real live stream at feature size (a poster
 * with Play, never autoplay). With nobody live the feature is the newest video instead, and with
 * no video either it is left out. Signed in, only the featured stream remains.
 */
import type { StreamCard, VodCard } from "@commonair/contracts/dto";
import { Arcs, formatDuration, formatPercent, MoneyAmount, SignalBars, useLocale } from "@commonair/ui";
import { MediaCard } from "@commonair/ui/blocks/media";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  EyeIcon,
  Shield01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { monthLabel } from "../../lib/money.ts";
import { DiscoveryStreamCard } from "../discovery/stream-cards.tsx";
import type { CoopProof } from "./model.ts";
import { track, useTrackView } from "./track.ts";

/** Where "Create free account" goes: sign-up with no particular action behind it (D2.1 intents). */
export const SIGNUP_HREF = "/signup?intent=none";
/** The creator pitch (D2.4). Not a typed route until that page lands, so a plain link. */
export const CREATORS_HREF = "/creators";

/** "90%" from the `platform.cut` share; null when the share is unknown (the copy then says less). */
export function shareLabel(share: number | null, locale: string): string | null {
  return share === null ? null : formatPercent(share, locale, { maximumFractionDigits: 1 });
}

export interface SignedOutHeroProps {
  site: string;
  featured: StreamCard | null;
  /** The newest video, for the feature when nobody is live. */
  latestVideo: VodCard | null;
  coop: CoopProof | null;
  collisions: ReadonlySet<string>;
}

export function SignedOutHero({
  site,
  featured,
  latestVideo,
  coop,
  collisions,
}: SignedOutHeroProps): React.JSX.Element {
  const { locale } = useLocale();
  useTrackView("home.hero");
  const share = shareLabel(coop?.creatorShare ?? null, locale);
  return (
    <section
      data-testid="home-welcome"
      aria-labelledby="home-hero-title"
      className="relative flex min-w-0 flex-col gap-6 overflow-hidden pt-2 md:pt-6"
    >
      <Arcs className="pointer-events-none absolute -end-24 -top-16 hidden w-96 text-brand-text opacity-10 md:block" />
      <div className="relative flex max-w-3xl flex-col gap-3 md:gap-4">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {featured && <span aria-hidden className="size-2 rounded-full bg-live" />}
          {featured ? t("d3Home.hero.eyebrow", { site }) : t("d3Home.hero.eyebrowQuiet")}
        </p>
        <h1 id="home-hero-title" className="font-display text-display text-balance">
          {t("d3Home.hero.title")}
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground md:text-lg">
          {share ? t("d3Home.hero.body", { creatorShare: share }) : t("d3Home.hero.bodyNoShare")}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          <Button
            data-testid="home-hero-signup"
            data-filled-cta=""
            variant="brand"
            size="lg"
            nativeButton={false}
            render={<a href={SIGNUP_HREF} aria-label={t("d3Home.hero.cta")} />}
            onClick={track("home.hero", "create")}
            className="w-full sm:w-auto"
          >
            {t("d3Home.hero.cta")}
          </Button>
          <Button
            data-testid="home-hero-browse"
            variant="ghost"
            size="lg"
            nativeButton={false}
            render={<Link to="/directory" />}
            onClick={track("home.hero", "click", "live")}
          >
            {t("d3Home.hero.browse")}
          </Button>
          <a
            data-testid="home-hero-stream"
            href={CREATORS_HREF}
            onClick={track("home.hero", "click", "stream")}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("d3Home.hero.stream", { site })}
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden className="size-4 rtl:-scale-x-100" />
          </a>
        </div>
      </div>
      <PromiseStrip coop={coop} share={share} />
      {featured ? (
        <div data-testid="home-hero" className="min-w-0">
          <DiscoveryStreamCard
            card={featured}
            collisions={collisions}
            size="feature"
            ctaLabel={t("d3Home.hero.watch")}
            aria-label={t("d3Home.hero.featured")}
            headingLevel={2}
            lazy={false}
          />
        </div>
      ) : latestVideo ? (
        <RecordedFeature video={latestVideo} />
      ) : null}
    </section>
  );
}

interface PromiseItem {
  key: string;
  icon: IconSvgElement;
  label: string;
  /** Dropped below 480 px, where only the owned and share items fit. */
  optional?: boolean;
}

function PromiseStrip({ coop, share }: { coop: CoopProof | null; share: string | null }): React.JSX.Element {
  const items: PromiseItem[] = [
    { key: "owned", icon: UserGroupIcon, label: t("d3Home.promise.owned") },
    ...(share ? [{ key: "share", icon: Coins01Icon, label: t("d3Home.promise.share", { creatorShare: share }) }] : []),
    { key: "fees", icon: Shield01Icon, label: t("d3Home.promise.fees"), optional: true },
    { key: "trackers", icon: EyeIcon, label: t("d3Home.promise.trackers"), optional: true },
  ];
  const earned = coop?.earned ?? null;
  return (
    <div data-testid="home-promise" className="flex min-w-0 flex-col gap-2">
      <SignalBars variant="band" className="h-1.5 w-full text-brand-text" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
        <ul aria-label={t("d3Home.promise.label")} className="flex min-w-0 flex-wrap gap-x-5 gap-y-1.5">
          {items.map((item) => (
            <li
              key={item.key}
              data-promise={item.key}
              className={
                item.optional
                  ? "inline-flex-from-xs items-center gap-1.5 text-muted-foreground"
                  : "inline-flex items-center gap-1.5 font-medium"
              }
            >
              <HugeiconsIcon icon={item.icon} strokeWidth={2} aria-hidden className="size-4 text-brand-text" />
              {item.label}
            </li>
          ))}
        </ul>
        {earned && (
          <p data-testid="home-earned" className="inline-flex items-center gap-1.5">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              aria-hidden
              className="size-4 text-brand-text"
            />
            <MoneyAmount
              value={{ cents: earned.cents, currency: earned.currency }}
              className="font-medium tabular-nums"
            />
            <span className="text-muted-foreground">
              {t("d3Home.numbers.earned", { month: monthLabel(earned.month) })}
            </span>
          </p>
        )}
        <Link
          to="/transparency"
          className="inline-flex min-h-11 items-center gap-1 text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:ms-auto"
        >
          {t("d3Home.promise.link")}
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden className="size-4 rtl:-scale-x-100" />
        </Link>
      </div>
    </div>
  );
}

/** Nobody live: the newest video in the feature's place, labelled "Video" (never "Recorded"). */
function RecordedFeature({ video }: { video: VodCard }): React.JSX.Element {
  return (
    <div data-testid="home-hero-recorded" className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {t("d3Home.hero.recorded.body", { channel: video.channel.displayName })}
      </p>
      <MediaCard
        className="max-w-3xl"
        kind="vod"
        headingLevel={2}
        lazy={false}
        media={videoMedia(video, t("d3Home.hero.recorded.badge"))}
        href={`/${video.channel.slug}/vods/${video.id}`}
        render={<Link to="/$channel/vods/$vodId" params={{ channel: video.channel.slug, vodId: video.id }} />}
      />
    </div>
  );
}

/** A video as `MediaCard` shows it. */
export function videoMedia(video: VodCard, kind?: string) {
  return {
    id: video.id,
    title: video.title,
    thumbnailUrl: video.thumbnailUrl,
    accent: video.channel.accent,
    channelName: video.channel.displayName,
    channelAvatarUrl: video.channel.avatarUrl,
    duration: formatDuration(video.durationSeconds),
    ...(kind ? { kind } : {}),
  };
}

/** Signed in: the featured stream on its own, under a plain heading. */
export function FeaturedStream({
  card,
  collisions,
}: {
  card: StreamCard;
  collisions: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <Section
      data-testid="home-hero"
      data-section="spotlight-hero"
      heading={t("d3Home.hero.featured")}
      description={t("d3Home.hero.featuredHint")}
    >
      <DiscoveryStreamCard
        card={card}
        collisions={collisions}
        size="feature"
        ctaLabel={t("d3Home.hero.watch")}
        headingLevel={3}
        lazy={false}
      />
    </Section>
  );
}
