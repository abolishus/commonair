// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which media one follower gets for one go-live (ADR 0028 decision 4), and the title they may see
 * (contract step §0: the one mature rule every N1 unit uses). Pure: the page query gathers the
 * facts, this decides.
 */
import { NOTIFY_MEDIA, type NotifyMedium } from "@commonair/contracts/enums";
import { NOTIFY_DEFAULTS } from "@commonair/contracts/notify";

/** The member's stored choice for one medium: the channel override and the default (null: no row). */
export interface MediumPreference {
  channel: boolean | null;
  fallback: boolean | null;
}

export interface FollowerFacts {
  prefs: Readonly<Record<NotifyMedium, MediumPreference>>;
  /** The follow is excluded by the integrity system: it stays in-app only. */
  excluded: boolean;
  emailVerified: boolean;
  /** A demo-seed identity (`anchoredUser()`): its address is not deliverable. */
  demo: boolean;
  /** At least one `push_subscriptions` row. */
  hasPushSubscription: boolean;
}

export type Media = Record<NotifyMedium, boolean>;

/** Channel override, else the member's default, else the built-in default. */
export function preferred(medium: NotifyMedium, pref: MediumPreference): boolean {
  return pref.channel ?? pref.fallback ?? NOTIFY_DEFAULTS.go_live[medium];
}

/** The media this follower gets; `pushAvailable` is false when the instance has push off. */
export function resolveMedia(f: FollowerFacts, pushAvailable: boolean): Media {
  const want = (m: NotifyMedium) => preferred(m, f.prefs[m]);
  return {
    in_app: want("in_app"),
    email: want("email") && !f.excluded && f.emailVerified && !f.demo,
    push: want("push") && !f.excluded && pushAvailable && f.hasPushSubscription,
  };
}

/** A follower with no medium left is skipped and does not consume the cooldown. */
export const anyMedium = (m: Media): boolean => NOTIFY_MEDIA.some((k) => m[k]);

/** Payload titles are bounded by `GoLiveNotificationPayload`. */
export const MAX_TITLE_LENGTH = 140;

/**
 * The title a follower sees: "" when the broadcast or its channel is mature and the follower has
 * not confirmed 18+ (the email and push then say only "is live").
 */
export function goLiveTitle(input: {
  title: string;
  broadcastMature: boolean;
  channelMature: boolean;
  matureConfirmed: boolean;
}): string {
  if ((input.broadcastMature || input.channelMature) && !input.matureConfirmed) return "";
  return input.title.slice(0, MAX_TITLE_LENGTH);
}
