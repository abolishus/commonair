// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bell and the notification settings page (ADR 0028): the API calls behind small client
 * interfaces (so render tests pass fixtures), what an item says and links to, and the pure state
 * changes the settings page applies optimistically.
 */
import type { NOTIFICATION_TYPES, NotifyMedium } from "@commonair/contracts/enums";
import { GoLiveNotificationPayload } from "@commonair/contracts/notify";
import type { MessageKey } from "../i18n/keys/index.gen.ts";
import { type Api, api } from "./api.ts";

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationPage = Awaited<ReturnType<Api["me"]["notifications"]>>;
export type NotificationDto = NotificationPage["items"][number];
export type NotificationPreferencesDto = Awaited<ReturnType<Api["notifications"]["preferences"]["get"]>>;
export type FollowPage = Awaited<ReturnType<Api["me"]["follows"]>>;
export type FollowDto = FollowPage["items"][number];
export interface UnreadCount {
  count: number;
  capped: boolean;
}

/** The badge polls this often while the tab is visible (and on focus). */
export const UNREAD_POLL_MS = 60_000;
/** A focus right after a poll does not ask again. */
export const UNREAD_MIN_GAP_MS = 5_000;
/** The popover shows the newest 20, then pages. */
export const NOTIFICATION_PAGE_SIZE = 20;
export const FOLLOWS_PAGE_SIZE = 50;

export interface InboxClient {
  unreadCount(): Promise<UnreadCount>;
  list(cursor: string | null): Promise<NotificationPage>;
  /** No ids: every unread notification. */
  markRead(ids?: string[]): Promise<void>;
}

export interface SetPreferenceInput {
  medium: NotifyMedium;
  /** null: the member's default. */
  channel: string | null;
  /** null: remove the channel override. */
  enabled: boolean | null;
}

export interface SettingsClient {
  preferences(): Promise<NotificationPreferencesDto>;
  setPreference(input: SetPreferenceInput): Promise<NotificationPreferencesDto>;
  follows(cursor: string | null): Promise<FollowPage>;
  /** The per-channel bell (`follows.notify`). */
  setBell(channel: string, notify: boolean): Promise<void>;
}

const optionalCursor = (cursor: string | null) => (cursor === null ? {} : { cursor });

export function inboxClient(client: () => Api = api): InboxClient {
  return {
    unreadCount: () => client().notifications.unreadCount(),
    list: (cursor) => client().me.notifications({ ...optionalCursor(cursor), limit: NOTIFICATION_PAGE_SIZE }),
    markRead: async (ids) => {
      await client().me.markNotificationsRead(ids === undefined ? {} : { ids });
    },
  };
}

export function settingsClient(client: () => Api = api): SettingsClient {
  return {
    preferences: () => client().notifications.preferences.get({ type: "go_live" }),
    setPreference: (input) => client().notifications.preferences.set({ type: "go_live", ...input }),
    follows: (cursor) => client().me.follows({ ...optionalCursor(cursor), limit: FOLLOWS_PAGE_SIZE }),
    setBell: async (channel, notify) => {
      await client().channels.follow({ channel, notify });
    },
  };
}

// ------------------------------------------------------------------ items

/** Where an item links. Only pages a payload names by id; never a URL from the payload. */
export type NotificationTarget =
  | { kind: "channel"; slug: string }
  | { kind: "proposal"; id: string }
  | { kind: "appeals" }
  | { kind: "privacy" }
  | { kind: "dashboard" };

export type NotificationView =
  | { kind: "go_live"; slug: string; title: string; target: NotificationTarget }
  | { kind: "generic"; label: MessageKey; target: NotificationTarget | null };

/** One label per type: literal keys, so the catalog checks see every one. */
const TYPE_LABEL: Record<NotificationType, MessageKey> = {
  go_live: "notifications.type.go_live",
  raid: "notifications.type.raid",
  proposal: "notifications.type.proposal",
  vote_open: "notifications.type.vote_open",
  export_ready: "notifications.type.export_ready",
  payout: "notifications.type.payout",
  moderation: "notifications.type.moderation",
  system: "notifications.type.system",
};

const SLUG = /^[a-z0-9_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * What an item shows and links to. Payload text is only ever rendered as React text, never as
 * HTML; slugs and ids are checked before they become a link.
 */
export function describeNotification(n: Pick<NotificationDto, "type" | "payload">): NotificationView {
  const payload = n.payload;
  const kind = str(payload.kind);
  switch (n.type) {
    case "go_live": {
      const p = GoLiveNotificationPayload.safeParse(payload);
      if (p.success && SLUG.test(p.data.slug))
        return {
          kind: "go_live",
          slug: p.data.slug,
          title: p.data.title,
          target: { kind: "channel", slug: p.data.slug },
        };
      return { kind: "generic", label: TYPE_LABEL.go_live, target: null };
    }
    case "proposal":
    case "vote_open": {
      const id = str(payload.proposalId);
      return {
        kind: "generic",
        label: TYPE_LABEL[n.type],
        target: id && UUID.test(id) ? { kind: "proposal", id } : null,
      };
    }
    case "export_ready":
      return { kind: "generic", label: TYPE_LABEL.export_ready, target: { kind: "privacy" } };
    case "moderation":
      // A statement of reasons (sor-deliver); staff notices (reports, NCII) have no page of theirs here.
      if (kind === "enforcement_statement")
        return { kind: "generic", label: "notifications.kind.statement", target: { kind: "appeals" } };
      return { kind: "generic", label: TYPE_LABEL.moderation, target: null };
    case "system":
      if (kind === "discord_webhook_removed")
        return { kind: "generic", label: "notifications.kind.discordWebhookRemoved", target: { kind: "dashboard" } };
      if (kind === "stream_key_leaked")
        return { kind: "generic", label: "notifications.kind.streamKeyLeaked", target: { kind: "dashboard" } };
      return { kind: "generic", label: TYPE_LABEL.system, target: null };
    case "raid":
    case "payout":
      return { kind: "generic", label: TYPE_LABEL[n.type], target: null };
  }
}

/** The path a target opens (the item renders a typed `<Link>`; tests and the harness compare paths). */
export function targetPath(target: NotificationTarget): string {
  switch (target.kind) {
    case "channel":
      return `/${target.slug}`;
    case "proposal":
      return `/coop/proposals/${target.id}`;
    case "appeals":
      return "/settings/appeals";
    case "privacy":
      return "/settings/privacy";
    case "dashboard":
      return "/dashboard";
  }
}

/** Mark ids read locally (after the API agreed, or optimistically). */
export function markItemsRead(
  items: readonly NotificationDto[],
  ids: readonly string[] | null,
  at: string,
): NotificationDto[] {
  return items.map((n) => (n.readAt === null && (ids === null || ids.includes(n.id)) ? { ...n, readAt: at } : n));
}

/** Append a page, dropping ids already shown (a row inserted between pages shifts nothing). */
export function appendPage(items: readonly NotificationDto[], next: readonly NotificationDto[]): NotificationDto[] {
  const seen = new Set(items.map((n) => n.id));
  return [...items, ...next.filter((n) => !seen.has(n.id))];
}

/** One fewer unread after reading an item. A capped count is unknown below the cap: ask again. */
export function afterReadingOne(u: UnreadCount): UnreadCount | null {
  if (u.capped) return null;
  return { count: Math.max(0, u.count - 1), capped: false };
}

// ------------------------------------------------------------------ settings

export type OverrideChoice = "default" | "on" | "off";
export type ChannelMedium = Exclude<NotifyMedium, "in_app">;

/** A channel's override for one medium, as the select shows it. */
export function overrideChoice(prefs: NotificationPreferencesDto, slug: string, medium: ChannelMedium): OverrideChoice {
  const v = prefs.channels.find((c) => c.channel.slug === slug)?.media[medium];
  return v === undefined ? "default" : v ? "on" : "off";
}

export function choiceEnabled(choice: OverrideChoice): boolean | null {
  return choice === "default" ? null : choice === "on";
}

export function isOverrideChoice(v: unknown): v is OverrideChoice {
  return v === "default" || v === "on" || v === "off";
}

/**
 * The preferences with one change applied, as the server would answer: a default stops being built
 * in; an override is set or removed (a channel row with no media left disappears).
 */
export function applyPreference(
  prefs: NotificationPreferencesDto,
  change: SetPreferenceInput,
  channel?: { id: string; slug: string; displayName: string },
): NotificationPreferencesDto {
  if (change.channel === null) {
    if (change.enabled === null) return prefs;
    return {
      ...prefs,
      defaults: { ...prefs.defaults, [change.medium]: change.enabled },
      builtIn: { ...prefs.builtIn, [change.medium]: false },
    };
  }
  const slug = change.channel;
  const existing = prefs.channels.find((c) => c.channel.slug === slug);
  const others = prefs.channels.filter((c) => c.channel.slug !== slug);
  const media = { ...existing?.media };
  if (change.enabled === null) delete media[change.medium];
  else media[change.medium] = change.enabled;
  const info = existing?.channel ?? channel;
  if (!info || Object.keys(media).length === 0) return { ...prefs, channels: others };
  return {
    ...prefs,
    channels: [...others, { channel: info, media }].sort((a, b) =>
      a.channel.slug < b.channel.slug ? -1 : a.channel.slug > b.channel.slug ? 1 : 0,
    ),
  };
}

/** Restore one (channel, medium) cell of `prefs` to what `before` had, leaving every other cell as it is now. */
export function revertPreference(
  prefs: NotificationPreferencesDto,
  before: NotificationPreferencesDto,
  change: Pick<SetPreferenceInput, "medium" | "channel">,
): NotificationPreferencesDto {
  if (change.channel === null)
    return {
      ...prefs,
      defaults: { ...prefs.defaults, [change.medium]: before.defaults[change.medium] },
      builtIn: { ...prefs.builtIn, [change.medium]: before.builtIn[change.medium] },
    };
  const slug = change.channel;
  const old = before.channels.find((c) => c.channel.slug === slug);
  const enabled = old?.media[change.medium];
  return applyPreference(prefs, { ...change, enabled: enabled ?? null }, old?.channel);
}
