// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for `/import` (ADR 0031; docs/testing/b7-selectors.md "Twitch import"): the shapes
 * the page reads from `twitchImport.*`, the default choices, which emotes can be chosen, and the
 * message keys for every outcome and reason code the API and the worker answer with.
 */
import type { MessageKey } from "../../i18n/index.ts";

export interface ImportItemDto {
  kind: "channel" | "panel" | "emote" | "schedule";
  ref: string;
  label: string;
  outcome: "imported" | "skipped" | "rejected" | null;
  reason: string | null;
}

export interface TwitchImportDto {
  id: string;
  source: "commonair" | "twitch";
  status: "previewed" | "queued" | "running" | "done" | "failed";
  preview: { channel: Record<string, unknown>; items: ImportItemDto[] };
  result: ImportItemDto[] | null;
  assertedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TwitchImportStatusDto {
  available: boolean;
  connected: boolean;
  twitchLogin: string | null;
  latest: TwitchImportDto | null;
}

export interface ScheduleEntry {
  startsAt: string;
  endsAt: string | null;
  title: string;
  category: string | null;
}

/** The preview's channel fields, read defensively (the record is untyped on the wire). */
export interface PreviewFields {
  state: "ready" | "expired" | "pending";
  twitchLogin: string;
  title: string;
  description: string;
  tags: string[];
  language: string;
  category: string | null;
  matureSuggested: boolean;
  schedule: ScheduleEntry[];
  /** Twitch emote code → CommonAir tier (null when not offered). */
  tiers: Map<string, number | null>;
  expiresAt: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function previewFields(dto: Pick<TwitchImportDto, "preview">): PreviewFields {
  const c = dto.preview.channel;
  const state = c.state === "ready" || c.state === "expired" ? c.state : "pending";
  const tiers = new Map<string, number | null>();
  if (Array.isArray(c.emotes))
    for (const e of c.emotes as { code?: unknown; tier?: unknown }[])
      if (typeof e?.code === "string") tiers.set(e.code, typeof e.tier === "number" ? e.tier : null);
  const schedule = Array.isArray(c.schedule)
    ? (c.schedule as Partial<ScheduleEntry>[]).flatMap((s) =>
        typeof s?.startsAt === "string"
          ? [{ startsAt: s.startsAt, endsAt: s.endsAt ?? null, title: str(s.title), category: s.category ?? null }]
          : [],
      )
    : [];
  return {
    state,
    twitchLogin: str(c.twitchLogin),
    title: str(c.title),
    description: str(c.description),
    tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [],
    language: str(c.language),
    category: typeof c.category === "string" && c.category ? c.category : null,
    matureSuggested: c.matureSuggested === true,
    schedule,
    tiers,
    expiresAt: typeof c.expiresAt === "string" ? c.expiresAt : null,
  };
}

/** The channel fields chosen one by one (`ImportChoices.fields`, batch 8). */
export const CHANNEL_FIELDS = ["title", "category", "tags", "language", "description", "mature"] as const;
export type ChannelField = (typeof CHANNEL_FIELDS)[number];

export const FIELD_KEYS: Record<ChannelField, MessageKey> = {
  title: "twitchImport.field.title",
  category: "twitchImport.field.category",
  tags: "twitchImport.field.tags",
  language: "twitchImport.field.language",
  description: "twitchImport.field.description",
  mature: "twitchImport.field.mature",
};

export interface TwitchChoices {
  channel: boolean;
  /** Absent: every channel field (the default); present: only those set to true. */
  fields?: Partial<Record<ChannelField, boolean>>;
  emotes: string[];
}

/** The channel's current values, beside the imported ones in the preview. */
export interface CurrentFields {
  title: string;
  category: string | null;
  tags: string[];
  language: string;
  description: string;
  mature: boolean;
}

/** `channels.get`'s fields as the preview compares them. */
export function currentFields(c: {
  title: string;
  description: string;
  category: { name: string } | null;
  tags: string[];
  language: string;
  mature: boolean;
}): CurrentFields {
  return {
    title: c.title,
    category: c.category?.name ?? null,
    tags: c.tags,
    language: c.language,
    description: c.description,
    mature: c.mature,
  };
}

/** Whether a field is chosen (every field is, until one is unticked). */
export const fieldOn = (choices: TwitchChoices, field: ChannelField): boolean => choices.fields?.[field] ?? true;

export function toggleField(choices: TwitchChoices, field: ChannelField): TwitchChoices {
  const all = Object.fromEntries(CHANNEL_FIELDS.map((f) => [f, fieldOn(choices, f)])) as Record<ChannelField, boolean>;
  return { ...choices, fields: { ...all, [field]: !all[field] } };
}

/** The channel item applies something: it is chosen and at least one field is. */
const channelApplies = (choices: TwitchChoices): boolean =>
  choices.channel && CHANNEL_FIELDS.some((f) => fieldOn(choices, f));

/** What `twitchImport.start` sends; `fields` only once the streamer has changed one. */
export function startChoices(choices: TwitchChoices): {
  channel: boolean;
  fields?: Partial<Record<ChannelField, boolean>>;
  panels: false;
  emotes: string[];
} {
  return {
    channel: choices.channel,
    ...(choices.fields ? { fields: { ...choices.fields } } : {}),
    panels: false,
    emotes: choices.emotes,
  };
}

/** An emote the preview offers (not skipped). */
export const isOffered = (i: ImportItemDto): boolean => i.kind === "emote" && i.outcome === null;

/** Everything offered is chosen by default. */
export function defaultChoices(items: readonly ImportItemDto[]): TwitchChoices {
  return { channel: items.some((i) => i.kind === "channel"), emotes: items.filter(isOffered).map((i) => i.ref) };
}

export function toggleEmote(choices: TwitchChoices, code: string): TwitchChoices {
  return {
    ...choices,
    emotes: choices.emotes.includes(code) ? choices.emotes.filter((c) => c !== code) : [...choices.emotes, code],
  };
}

/** Start is possible with something chosen, and with the assertion when emotes are. */
export const canStart = (choices: TwitchChoices, asserted: boolean): boolean =>
  (channelApplies(choices) || choices.emotes.length > 0) && (choices.emotes.length === 0 || asserted);

export const isRunning = (dto: Pick<TwitchImportDto, "status">): boolean =>
  dto.status === "queued" || dto.status === "running";

/** Poll while the worker applies an import. */
export const POLL_MS = 2_000;

// Outcomes of the authorization (`/import?twitch=…`) -------------------------------------------

export const CALLBACK_OUTCOMES = ["connected", "denied", "invalid", "mismatch", "failed"] as const;
export type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number];

export const parseOutcome = (v: unknown): CallbackOutcome | null =>
  typeof v === "string" && (CALLBACK_OUTCOMES as readonly string[]).includes(v) ? (v as CallbackOutcome) : null;

export const OUTCOME_KEYS: Record<CallbackOutcome, MessageKey> = {
  connected: "twitchImport.outcome.connected",
  denied: "twitchImport.outcome.denied",
  invalid: "twitchImport.outcome.invalid",
  mismatch: "twitchImport.outcome.mismatch",
  failed: "twitchImport.outcome.failed",
};

// Items and reasons ------------------------------------------------------------------------------

export const RESULT_KEYS: Record<NonNullable<ImportItemDto["outcome"]>, MessageKey> = {
  imported: "twitchImport.result.imported",
  skipped: "twitchImport.result.skipped",
  rejected: "twitchImport.result.rejected",
};

export const KIND_KEYS: Record<ImportItemDto["kind"], MessageKey> = {
  channel: "twitchImport.kind.channel",
  panel: "twitchImport.kind.panel",
  emote: "twitchImport.kind.emote",
  schedule: "twitchImport.kind.schedule",
};

const REASON_KEYS: Record<string, MessageKey> = {
  not_chosen: "twitchImport.reason.notChosen",
  code_taken: "twitchImport.reason.codeTaken",
  emote_limit: "twitchImport.reason.emoteLimit",
  upload_rejected: "twitchImport.reason.uploadRejected",
  unsupported_type: "twitchImport.reason.unsupportedType",
  missing_file: "twitchImport.reason.imageUnavailable",
  invalid_code: "twitchImport.reason.invalidCode",
  duplicate_code: "twitchImport.reason.duplicateCode",
  bits_emote: "twitchImport.reason.bitsEmote",
  unsupported_emote_type: "twitchImport.reason.unsupportedEmoteType",
  carried_not_applied: "twitchImport.reason.carriedNotApplied",
  importer_legal_hold: "twitchImport.reason.unavailableForAccount",
  channel_suspended: "twitchImport.reason.channelSuspended",
  twitch_import_unavailable: "twitchImport.reason.turnedOff",
};

/** A reason code's message; unknown codes share one. */
export function reasonKey(reason: string | null): MessageKey | null {
  if (reason === null) return null;
  return REASON_KEYS[reason] ?? "twitchImport.reason.other";
}

/** "Followers" for tier 0, "Tier n" otherwise. */
export function tierKey(tier: number): { key: MessageKey; vars?: Record<string, number> } {
  return tier === 0 ? { key: "twitchImport.emotes.tierFollower" } : { key: "twitchImport.emotes.tier", vars: { tier } };
}
