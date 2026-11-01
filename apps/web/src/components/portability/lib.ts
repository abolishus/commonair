// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the portability pages (ADR 0037; docs/testing/b7-selectors.md "Portability"):
 * link states, expiry choices, the import preview's choices and standing badge, and the message
 * keys for every reason code the API and the worker answer with.
 */
import type { MessageKey } from "../../i18n/index.ts";

export interface MoveLinkDto {
  id: string;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  conversions: number;
}

export type LinkState = "active" | "revoked" | "expired";

export function linkState(link: Pick<MoveLinkDto, "revokedAt" | "expiresAt">, nowMs: number): LinkState {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && Date.parse(link.expiresAt) <= nowMs) return "expired";
  return "active";
}

export const LINK_STATE_KEYS: Record<LinkState, MessageKey> = {
  active: "portability.links.state.active",
  revoked: "portability.links.state.revoked",
  expired: "portability.links.state.expired",
};

/** Expiry choices for a new link, in days; `never` is no expiry. */
export const EXPIRY_CHOICES = ["never", "7", "30", "90"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

export const EXPIRY_KEYS: Record<ExpiryChoice, MessageKey> = {
  never: "portability.links.expiry.never",
  "7": "portability.links.expiry.days7",
  "30": "portability.links.expiry.days30",
  "90": "portability.links.expiry.days90",
};

export function expiresAtFor(choice: ExpiryChoice, nowMs: number): string | null {
  if (choice === "never") return null;
  return new Date(nowMs + Number(choice) * 86_400_000).toISOString();
}

/** Links shown first: active, newest first; then the rest, newest first. */
export function sortLinks(links: readonly MoveLinkDto[], nowMs: number): MoveLinkDto[] {
  const rank = (l: MoveLinkDto) => (linkState(l, nowMs) === "active" ? 0 : 1);
  return [...links].sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The "moved to" address the API accepts: https, no user name or password, at most 500 characters. */
export function isValidMovedTo(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 500) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname !== "";
}

// Imports ---------------------------------------------------------------------------------------

export type ImportItemKind = "channel" | "panel" | "emote" | "schedule";
export interface ImportItemDto {
  kind: ImportItemKind;
  ref: string;
  label: string;
  outcome: "imported" | "skipped" | "rejected" | null;
  reason: string | null;
}
export interface ImportDto {
  id: string;
  source: "commonair" | "twitch";
  status: "previewed" | "queued" | "running" | "done" | "failed";
  standingVerified: boolean | null;
  standingIssuer: string | null;
  preview: { channel: Record<string, unknown>; items: ImportItemDto[] };
  result: ImportItemDto[] | null;
  assertedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ImportChoices {
  channel: boolean;
  panels: boolean;
  emotes: string[];
}

/** An item the preview already knows cannot be imported (a taken code, the schedule). */
export const isSelectable = (i: ImportItemDto): boolean => i.outcome === null && i.kind !== "schedule";

/** Everything selectable is chosen by default. */
export function defaultChoices(items: readonly ImportItemDto[]): ImportChoices {
  return {
    channel: items.some((i) => i.kind === "channel" && isSelectable(i)),
    panels: items.some((i) => i.kind === "panel" && isSelectable(i)),
    emotes: items.filter((i) => i.kind === "emote" && isSelectable(i)).map((i) => i.ref),
  };
}

export function isChosen(choices: ImportChoices, item: ImportItemDto): boolean {
  if (!isSelectable(item)) return false;
  if (item.kind === "channel") return choices.channel;
  if (item.kind === "panel") return choices.panels;
  if (item.kind === "emote") return choices.emotes.includes(item.ref);
  return false;
}

/** Toggle one item; panels go together (they replace the channel's panels as a set). */
export function toggleChoice(choices: ImportChoices, item: ImportItemDto): ImportChoices {
  if (item.kind === "channel") return { ...choices, channel: !choices.channel };
  if (item.kind === "panel") return { ...choices, panels: !choices.panels };
  if (item.kind === "emote")
    return {
      ...choices,
      emotes: choices.emotes.includes(item.ref)
        ? choices.emotes.filter((c) => c !== item.ref)
        : [...choices.emotes, item.ref],
    };
  return choices;
}

export type StandingBadge = "verified" | "unverified" | "refused";

/** The preview's standing badge (a refusal comes as an error reason, see `importErrorReason`). */
export function standingBadge(dto: Pick<ImportDto, "standingVerified" | "status">, refused: boolean): StandingBadge {
  if (refused) return "refused";
  return dto.standingVerified === true ? "verified" : "unverified";
}

export const STANDING_KEYS: Record<StandingBadge, MessageKey> = {
  verified: "portability.import.standing.verified",
  unverified: "portability.import.standing.unverified",
  refused: "portability.import.standing.refused",
};

/** Reasons that mean the bundle's own statement refused the import. */
export const STANDING_REFUSALS = new Set(["standing_suspended", "standing_legal_hold"]);

/** The reason code of a refused preview (`BAD_REQUEST` with `data.reason`), if any. */
export function importErrorReason(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const reason = (data as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

const REASON_KEYS: Record<string, MessageKey> = {
  not_chosen: "portability.reason.notChosen",
  code_taken: "portability.reason.codeTaken",
  emote_limit: "portability.reason.emoteLimit",
  upload_rejected: "portability.reason.uploadRejected",
  unsupported_type: "portability.reason.unsupportedType",
  missing_file: "portability.reason.missingFile",
  invalid_code: "portability.reason.invalidCode",
  carried_not_applied: "portability.reason.carriedNotApplied",
  standing_suspended: "portability.reason.standingSuspended",
  standing_legal_hold: "portability.reason.standingLegalHold",
  importer_legal_hold: "portability.reason.importerLegalHold",
  channel_suspended: "portability.reason.channelSuspended",
  archive_missing: "portability.reason.archiveMissing",
  archive_changed: "portability.reason.archiveChanged",
  import_failed: "portability.reason.importFailed",
  preview_failed: "portability.reason.previewFailed",
};

/** A reason code's message; bundle read errors (`bundle_*`) share one. */
export function reasonKey(reason: string | null): MessageKey | null {
  if (reason === null) return null;
  if (reason.startsWith("bundle_")) return "portability.reason.badBundle";
  return REASON_KEYS[reason] ?? "portability.reason.other";
}

export const ITEM_KIND_KEYS: Record<ImportItemKind, MessageKey> = {
  channel: "portability.import.kind.channel",
  panel: "portability.import.kind.panel",
  emote: "portability.import.kind.emote",
  schedule: "portability.import.kind.schedule",
};

export const OUTCOME_KEYS: Record<NonNullable<ImportItemDto["outcome"]>, MessageKey> = {
  imported: "portability.import.outcome.imported",
  skipped: "portability.import.outcome.skipped",
  rejected: "portability.import.outcome.rejected",
};

/** Poll the import while the worker applies it. */
export const IMPORT_POLL_MS = 2_000;
export const isImportRunning = (dto: Pick<ImportDto, "status">): boolean =>
  dto.status === "queued" || dto.status === "running";

// Landing ---------------------------------------------------------------------------------------

export type LandingState = "active" | "revoked" | "expired" | "unknown";
