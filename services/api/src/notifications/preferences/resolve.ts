// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resolve a member's stored preference rows into `NotificationPreferences` (ADR 0028 decision 4):
 * a default per medium (their row, else `NOTIFY_DEFAULTS`), and the channel overrides of channels
 * they still follow. Pure: `notifications.preferences.get` and `set`'s response share it.
 */
import { NOTIFY_MEDIA, type NotifyMedium, type PREFERENCE_TYPES } from "@commonair/contracts/enums";
import { NOTIFY_DEFAULTS } from "@commonair/contracts/notify";

export type PreferenceType = (typeof PREFERENCE_TYPES)[number];

export interface PreferenceRow {
  /** null: the member's default for this medium. */
  channelId: string | null;
  medium: NotifyMedium;
  enabled: boolean;
}

export interface FollowedChannel {
  id: string;
  slug: string;
  displayName: string;
}

export interface ResolvedPreferences {
  type: PreferenceType;
  defaults: Record<NotifyMedium, boolean>;
  builtIn: Record<NotifyMedium, boolean>;
  channels: { channel: FollowedChannel; media: Partial<Record<NotifyMedium, boolean>> }[];
  emailVerified: boolean;
}

export interface ResolveInput {
  type: PreferenceType;
  rows: readonly PreferenceRow[];
  /** Channels the member follows, by id. Override rows for any other channel are left out. */
  followed: ReadonlyMap<string, FollowedChannel>;
  emailVerified: boolean;
}

export function resolvePreferences(input: ResolveInput): ResolvedPreferences {
  const builtIns = NOTIFY_DEFAULTS[input.type];
  const defaults = { ...builtIns };
  const builtIn: Record<NotifyMedium, boolean> = { in_app: true, email: true, push: true };
  const overrides = new Map<string, Partial<Record<NotifyMedium, boolean>>>();
  for (const row of input.rows) {
    if (row.channelId === null) {
      defaults[row.medium] = row.enabled;
      builtIn[row.medium] = false;
      continue;
    }
    if (!input.followed.has(row.channelId)) continue;
    const media = overrides.get(row.channelId) ?? {};
    media[row.medium] = row.enabled;
    overrides.set(row.channelId, media);
  }
  const channels = [...overrides.entries()]
    .flatMap(([id, media]) => {
      const channel = input.followed.get(id);
      return channel ? [{ channel, media: orderedMedia(media) }] : [];
    })
    // Stable for clients and tests: by slug (unique).
    .sort((a, b) => (a.channel.slug < b.channel.slug ? -1 : a.channel.slug > b.channel.slug ? 1 : 0));
  return { type: input.type, defaults, builtIn, channels, emailVerified: input.emailVerified };
}

function orderedMedia(media: Partial<Record<NotifyMedium, boolean>>): Partial<Record<NotifyMedium, boolean>> {
  const out: Partial<Record<NotifyMedium, boolean>> = {};
  for (const m of NOTIFY_MEDIA) if (media[m] !== undefined) out[m] = media[m];
  return out;
}

/** Whether a medium reaches the member for one channel: the override, else their default. */
export function enabledFor(
  prefs: Pick<ResolvedPreferences, "defaults" | "channels">,
  channelId: string,
  medium: NotifyMedium,
): boolean {
  const override = prefs.channels.find((c) => c.channel.id === channelId)?.media[medium];
  return override ?? prefs.defaults[medium];
}
