// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The About tab (F2; `channel-about`): the banner on top (when the page did not already show it),
 * the owner's co-op mark (overhaul D4.7), the bio and follower count, the category, the streamer's social links (`channel-socials`), then
 * B8-web's panels as they are. The bio is plain text with its line breaks kept, never parsed.
 */
import type { ChannelSocial } from "@commonair/contracts/shapes";
import { RelativeTime } from "@commonair/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import {
  BlueskyIcon,
  DiscordIcon,
  Github01Icon,
  Globe02Icon,
  InstagramIcon,
  Link01Icon,
  MastodonIcon,
  NewTwitterIcon,
  TiktokIcon,
  TwitchIcon,
  YoutubeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ChannelAbout } from "./channel-data.ts";
import { socialLabel } from "./channel-data.ts";
import { CategoryLink } from "./channel-meta.tsx";
import { ChannelPanels } from "./panels.tsx";
import type { ChannelPanelView } from "./panels-data.ts";
import { TrustBadge, type OwnerCoop } from "../watch-layout/watch-layout.tsx";

type Platform = ChannelSocial["platform"];

const ICONS: Record<Platform, typeof Link01Icon> = {
  website: Globe02Icon,
  mastodon: MastodonIcon,
  bluesky: BlueskyIcon,
  youtube: YoutubeIcon,
  twitch: TwitchIcon,
  x: NewTwitterIcon,
  instagram: InstagramIcon,
  tiktok: TiktokIcon,
  discord: DiscordIcon,
  github: Github01Icon,
  other: Link01Icon,
};

/** The platform's name for the link's accessible name (brand names are not translated). */
export function platformName(platform: Platform): string {
  switch (platform) {
    case "website":
      return t("fuChannel.socials.website");
    case "other":
      return t("fuChannel.socials.other");
    case "mastodon":
      return "Mastodon";
    case "bluesky":
      return "Bluesky";
    case "youtube":
      return "YouTube";
    case "twitch":
      return "Twitch";
    case "x":
      return "X";
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "discord":
      return "Discord";
    case "github":
      return "GitHub";
  }
}

/**
 * The streamer's links, in their order. `rel="me"` lets Mastodon and others verify the link back;
 * `noopener noreferrer` keeps the opened page from reaching this one or learning where it came from.
 */
export function ChannelSocials({
  name,
  socials,
}: {
  name: string;
  socials: readonly ChannelSocial[];
}): React.JSX.Element | null {
  if (socials.length === 0) return null;
  return (
    <ul
      data-testid="channel-socials"
      aria-label={t("fuChannel.socials.label", { name })}
      className="flex min-w-0 flex-col gap-1"
    >
      {socials.map((social, i) => (
        <li key={`${String(i)}:${social.url}`} className="min-w-0">
          <a
            data-testid="channel-social-link"
            data-platform={social.platform}
            href={social.url}
            target="_blank"
            rel="noopener noreferrer me"
            aria-label={t("fuChannel.socials.linkLabel", {
              platform: platformName(social.platform),
              link: socialLabel(social.url),
            })}
            className="inline-flex min-h-8 max-w-full min-w-0 items-center gap-2 rounded-none text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <HugeiconsIcon icon={ICONS[social.platform]} strokeWidth={2} aria-hidden className="size-4 shrink-0" />
            <span dir="auto" className="min-w-0 truncate">
              {socialLabel(social.url)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ChannelAboutSection({
  name,
  about,
  category,
  followers,
  panels,
  banner,
  since = null,
  coop = null,
}: {
  name: string;
  about: ChannelAbout;
  /** The polled summary's category (live broadcast's, else the channel's). */
  category: { slug: string; name: string } | null;
  /** `<FollowerCount>`. */
  followers: React.ReactNode;
  /** Already filtered (none on a suspended channel). */
  panels: readonly ChannelPanelView[];
  /** The banner, or its pending frame, or null. */
  banner?: React.ReactNode;
  /** `Channel.createdAt` (D3.8): when the channel was created; left out when unknown. */
  since?: string | null;
  /** `Channel.ownerCoop` (overhaul D4.7): the owner's co-op mark on the card, when they have one. */
  coop?: OwnerCoop | null;
}): React.JSX.Element {
  return (
    <div data-testid="channel-about" className="flex min-w-0 flex-col gap-6">
      {banner}
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold break-words">{t("channel.tabs.aboutHeading", { name })}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <TrustBadge data-testid="channel-about-trust" coop={coop} name={name} className="self-start" />
          <p className="text-sm text-muted-foreground">{followers}</p>
          {about.bio !== "" ? (
            <p data-testid="channel-about-bio" className="text-sm break-words whitespace-pre-line">
              {about.bio}
            </p>
          ) : (
            <p data-testid="channel-about-bio-empty" className="text-sm text-muted-foreground">
              {t("channel.tabs.noBio", { name })}
            </p>
          )}
          {category ? (
            <p className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
              <span>{t("channel.tabs.streamsIn")}</span>
              <CategoryLink category={category} />
            </p>
          ) : null}
          {since ? (
            <p data-testid="channel-about-since" className="text-sm text-muted-foreground">
              {t("d3Watch.about.since")} <RelativeTime date={since} />
            </p>
          ) : null}
          <ChannelSocials name={name} socials={about.socials} />
        </CardContent>
      </Card>
      <ChannelPanels panels={panels} />
    </div>
  );
}
