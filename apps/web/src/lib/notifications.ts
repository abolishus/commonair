// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bell and the notification settings page (ADR 0028): the API calls behind small client
 * interfaces (so render tests pass fixtures), what an item says and links to, and the pure state
 * changes the settings page applies optimistically.
 */
import {
  PREFERENCE_MEDIA,
  type NOTIFICATION_TYPES,
  type NotifyMedium,
  type PreferenceType,
} from "@commonair/contracts/enums";
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
  /** `types`: only these (the `/inbox` filter chips); absent, every type. */
  list(cursor: string | null, types?: readonly NotificationType[]): Promise<NotificationPage>;
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
    list: (cursor, types) =>
      client().me.notifications({
        ...optionalCursor(cursor),
        limit: NOTIFICATION_PAGE_SIZE,
        ...(types && types.length > 0 ? { types: [...types] } : {}),
      }),
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

/** The preference types besides go-live, each one default per medium (overhaul wave 4, D7.3). */
export type OtherPreferenceType = Exclude<PreferenceType, "go_live">;

export interface PreferenceTypesClient {
  get(type: OtherPreferenceType): Promise<NotificationPreferencesDto>;
  set(type: OtherPreferenceType, medium: NotifyMedium, enabled: boolean): Promise<NotificationPreferencesDto>;
}

export function preferenceTypesClient(client: () => Api = api): PreferenceTypesClient {
  return {
    get: (type) => client().notifications.preferences.get({ type }),
    set: (type, medium, enabled) => client().notifications.preferences.set({ type, medium, channel: null, enabled }),
  };
}

// ------------------------------------------------------------------ the grid

/** The grid's columns, in order. */
export const GRID_MEDIA = ["in_app", "email", "push"] as const satisfies readonly NotifyMedium[];

/** Whether a type offers a medium (`PREFERENCE_MEDIA`): the others show "–". */
export const offers = (type: PreferenceType, medium: NotifyMedium): boolean => PREFERENCE_MEDIA[type].includes(medium);

/** Each choosable cell's test id: literal strings (the selector checks read source). */
export const PREFERENCE_CELL_TEST_IDS: {
  readonly [T in PreferenceType]: Partial<Record<NotifyMedium, string>>;
} = {
  go_live: { in_app: "notify-default-in_app", email: "notify-default-email", push: "notify-default-push" },
  governance: { in_app: "notify-pref-governance-in_app", email: "notify-pref-governance-email" },
  payout: { email: "notify-pref-payout-email" },
  creator: { in_app: "notify-pref-creator-in_app", email: "notify-pref-creator-email" },
  digest_weekly: { email: "notify-pref-digest_weekly-email" },
};

/**
 * Cells the grid shows locked ("Always", with the reason): media that always reach the member, so
 * `PREFERENCE_MEDIA` does not offer them. Payout notices are financial records: they always stay in
 * the inbox (decided conservatively; overhaul wave 5 dropped payout in-app from the choices).
 */
export const LOCKED_CELLS: { readonly [T in PreferenceType]?: Partial<Record<NotifyMedium, MessageKey>> } = {
  payout: { in_app: "d7Notify.locked.payoutInApp" },
};

/** The grid's rows with a choice, in order (`go_live` first: it has the per-channel overrides too). */
export const GRID_ROWS: readonly { type: PreferenceType; label: MessageKey; hint: MessageKey }[] = [
  { type: "go_live", label: "d7Notify.row.go_live", hint: "d7Notify.row.go_live.hint" },
  { type: "governance", label: "d7Notify.row.governance", hint: "w5Notify.row.governance.hint" },
  { type: "payout", label: "d7Notify.row.payout", hint: "d7Notify.row.payout.hint" },
  { type: "creator", label: "d7Notify.row.creator", hint: "d7Notify.row.creator.hint" },
  { type: "digest_weekly", label: "d7Notify.row.digest_weekly", hint: "d7Notify.row.digest_weekly.hint" },
];

/** What always reaches the inbox (no preference covers it), and why: the grid shows it locked. */
export type AlwaysRow = "moderation" | "system" | "export" | "membership" | "reports" | "moderator";

export const ALWAYS_ROWS: readonly { id: AlwaysRow; label: MessageKey; why: MessageKey }[] = [
  { id: "moderation", label: "d7Notify.always.moderation", why: "d7Notify.always.moderation.why" },
  { id: "system", label: "d7Notify.always.system", why: "d7Notify.always.system.why" },
  { id: "export", label: "d7Notify.always.export", why: "d7Notify.always.export.why" },
  { id: "membership", label: "d7Notify.always.membership", why: "d7Notify.always.membership.why" },
  { id: "reports", label: "d7Notify.always.reports", why: "d7Notify.always.reports.why" },
  { id: "moderator", label: "d7Notify.always.moderator", why: "d7Notify.always.moderator.why" },
];

// ------------------------------------------------------------------ the inbox page

/** `/inbox` filter chips. */
export const INBOX_FILTERS = ["all", "live", "coop", "account"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** The types each chip asks for (null: every type). Every type is in exactly one chip but "all". */
export const INBOX_FILTER_TYPES: Readonly<Record<InboxFilter, readonly NotificationType[] | null>> = {
  all: null,
  live: ["go_live", "raid", "vod_ready"],
  coop: ["proposal", "vote_open", "membership", "payout"],
  account: ["export_ready", "moderation", "system", "report_outcome", "moderator_added"],
};

export const isInboxFilter = (v: unknown): v is InboxFilter =>
  typeof v === "string" && (INBOX_FILTERS as readonly string[]).includes(v);

export type InboxGroup = "today" | "week" | "earlier";

/** Today (local day), this week (the 6 days before), earlier. */
export function inboxGroup(createdAt: string, now: Date): InboxGroup {
  const at = new Date(createdAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at.getTime() >= startOfToday) return "today";
  if (at.getTime() >= startOfToday - 6 * 86_400_000) return "week";
  return "earlier";
}

/** Consecutive runs of items by group, newest first (the list is already newest first). */
export function groupInbox(
  items: readonly NotificationDto[],
  now: Date,
): { group: InboxGroup; items: NotificationDto[] }[] {
  const out: { group: InboxGroup; items: NotificationDto[] }[] = [];
  for (const n of items) {
    const group = inboxGroup(n.createdAt, now);
    const last = out.at(-1);
    if (last && last.group === group) last.items.push(n);
    else out.push({ group, items: [n] });
  }
  return out;
}

// ------------------------------------------------------------------ email link sources

/**
 * `?src=` values our own email links carry (`EMAIL_LINK_SOURCES`), mirrored to keep the contracts
 * barrel out of the bundle. The web counts one (in aggregate) and strips it.
 */
const EMAIL_SOURCES = ["digest"] as const;
export type EmailSource = (typeof EMAIL_SOURCES)[number];

/** The `src` an email link carried, and the same URL without it; null when none (or not ours). */
export function emailSourceOf(href: string): { source: EmailSource; stripped: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const src = url.searchParams.get("src");
  const source = EMAIL_SOURCES.find((s) => s === src);
  if (!source) return null;
  url.searchParams.delete("src");
  return { source, stripped: url.toString() };
}

// ------------------------------------------------------------------ items

/** Where an item links. Only pages a payload names by id; never a URL from the payload. */
export type NotificationTarget =
  | { kind: "channel"; slug: string }
  | { kind: "mod"; slug: string }
  | { kind: "proposal"; id: string }
  | { kind: "appeals" }
  | { kind: "privacy" }
  | { kind: "dashboard" }
  | { kind: "membership" }
  | { kind: "vod"; slug: string; id: string };

/** A line under the label: the proposal or video title, or a payout amount (overhaul wave 4, D7.3). */
export type NotificationContext =
  | { kind: "text"; text: string }
  | { kind: "money"; cents: number; currency: string }
  | null;

export type NotificationView =
  | {
      kind: "go_live";
      slug: string;
      /** The channel's display name when the API joined it, else the slug. */
      name: string;
      avatarUrl: string | null;
      title: string;
      target: NotificationTarget;
    }
  | { kind: "generic"; label: MessageKey; target: NotificationTarget | null; context?: NotificationContext };

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
  membership: "notifications.type.membership",
  vod_ready: "notifications.type.vod_ready",
  report_outcome: "notifications.type.report_outcome",
  moderator_added: "notifications.type.moderator_added",
};

/**
 * The contract's `Slug` (api/common.ts): 3-25 of [a-z0-9_]. Mirrored, not imported: the root
 * `@commonair/contracts` barrel adds ~76 KB to the client bundle.
 */
const SLUG = /^[a-z0-9_]{3,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** An avatar URL the API built (our media origin or a provider's https avatar); anything else is dropped. */
const safeImage = (v: unknown): string | null =>
  typeof v === "string" && (/^https?:\/\//.test(v) || /^\/(?!\/)/.test(v)) ? v : null;

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
          name: p.data.displayName && p.data.displayName.trim() !== "" ? p.data.displayName : p.data.slug,
          avatarUrl: safeImage(p.data.avatarUrl),
          title: p.data.title,
          target: { kind: "channel", slug: p.data.slug },
        };
      return { kind: "generic", label: TYPE_LABEL.go_live, target: null };
    }
    case "proposal":
    case "vote_open": {
      const id = str(payload.proposalId);
      const title = str(payload.title);
      return {
        kind: "generic",
        label: TYPE_LABEL[n.type],
        target: id && UUID.test(id) ? { kind: "proposal", id } : null,
        context: title ? { kind: "text", text: title } : null,
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
      if (kind === "giveaway_won") {
        // W3-giveaways: `{kind, giveawayId, channel, rank}`; the claim goes through the streamer.
        const slug = str(payload.channel);
        return {
          kind: "generic",
          label: "notifications.kind.giveawayWon",
          target: slug && SLUG.test(slug) ? { kind: "channel", slug } : null,
        };
      }
      return { kind: "generic", label: TYPE_LABEL.system, target: null };
    case "membership":
      return { kind: "generic", label: TYPE_LABEL.membership, target: { kind: "membership" } };
    case "vod_ready": {
      // Overhaul wave 3 (D5.3): `{vodId, broadcastId, slug, title}`; links to the video.
      const slug = str(payload.slug);
      const id = str(payload.vodId);
      const title = str(payload.title);
      return {
        kind: "generic",
        label: TYPE_LABEL.vod_ready,
        target: slug && SLUG.test(slug) && id && UUID.test(id) ? { kind: "vod", slug, id } : null,
        context: title ? { kind: "text", text: title } : null,
      };
    }
    case "moderator_added": {
      // Overhaul wave 4: `{channelId, slug, role}`; links the channel's mod view.
      const slug = str(payload.slug);
      return {
        kind: "generic",
        label: payload.role === "editor" ? "d7Notify.item.editorAdded" : TYPE_LABEL.moderator_added,
        target: slug && SLUG.test(slug) ? { kind: "mod", slug } : null,
        context: slug && SLUG.test(slug) ? { kind: "text", text: slug } : null,
      };
    }
    case "report_outcome":
      // Overhaul wave 4: the outcome only, never what happened to whom.
      return {
        kind: "generic",
        label:
          payload.outcome === "action_taken"
            ? "d7Notify.item.reportActionTaken"
            : payload.outcome === "no_action"
              ? "d7Notify.item.reportNoAction"
              : TYPE_LABEL.report_outcome,
        target: null,
      };
    case "payout": {
      const cents = payload.amountCents;
      const currency = str(payload.currency);
      return {
        kind: "generic",
        label: TYPE_LABEL.payout,
        target: null,
        context:
          typeof cents === "number" && Number.isSafeInteger(cents) && currency && /^[A-Za-z]{3}$/.test(currency)
            ? { kind: "money", cents, currency }
            : null,
      };
    }
    case "raid":
      return { kind: "generic", label: TYPE_LABEL[n.type], target: null };
  }
}

/** The path a target opens (the item renders a typed `<Link>`; tests and the harness compare paths). */
export function targetPath(target: NotificationTarget): string {
  switch (target.kind) {
    case "channel":
      return `/${target.slug}`;
    case "mod":
      return `/mod/${target.slug}`;
    case "proposal":
      return `/coop/proposals/${target.id}`;
    case "appeals":
      return "/settings/appeals";
    case "privacy":
      return "/settings/privacy";
    case "dashboard":
      return "/dashboard";
    case "membership":
      return "/coop/membership";
    case "vod":
      return `/${target.slug}/vods/${target.id}`;
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

/**
 * Set one (channel, medium) cell of `prefs` to what `from` has, leaving every other cell as it is
 * now: rolls a failed change back, and takes a save's answer without undoing other pending cells.
 */
export function copyPreferenceCell(
  prefs: NotificationPreferencesDto,
  from: NotificationPreferencesDto,
  change: Pick<SetPreferenceInput, "medium" | "channel">,
): NotificationPreferencesDto {
  if (change.channel === null)
    return {
      ...prefs,
      defaults: { ...prefs.defaults, [change.medium]: from.defaults[change.medium] },
      builtIn: { ...prefs.builtIn, [change.medium]: from.builtIn[change.medium] },
    };
  const slug = change.channel;
  const old = from.channels.find((c) => c.channel.slug === slug);
  const enabled = old?.media[change.medium];
  return applyPreference(prefs, { ...change, enabled: enabled ?? null }, old?.channel);
}
