// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/bot` (studio) logic, pure for unit tests: the settings, command, timer, variable and points
 * forms (bounds from `BotConfig`, `BotCommand`, `BotTimer` and `bot.*` in the contract), the
 * error-code mapping and the song-request link rule (shown as a link, never fetched or embedded).
 */
import { BOT_BUILTIN_COMMANDS, POINTS_ADJUST_REASONS, USER_LEVELS } from "@commonair/contracts/enums";
import type { BotConfig } from "@commonair/contracts/shapes";
import { t, type MessageKey } from "../i18n/index.ts";
import { errorCode, type Api } from "./api.ts";
import { errorRequirement } from "./coop.ts";
import { type Checked, type FieldErrors, parseBoundedInt } from "./interact-studio.ts";

export type BotSettingsDto = Awaited<ReturnType<Api["bot"]["settings"]>>;
export type BotCommandDto = Awaited<ReturnType<Api["bot"]["commands"]["list"]>>[number];
export type BotTimerDto = Awaited<ReturnType<Api["bot"]["timers"]["list"]>>[number];
export type BotVariableDto = Awaited<ReturnType<Api["bot"]["variables"]["list"]>>[number];
export type SongRequestDto = Awaited<ReturnType<Api["bot"]["songRequests"]["list"]>>[number];
export type LoyaltyRowDto = Awaited<ReturnType<Api["bot"]["points"]["leaderboard"]>>[number];
export type BotSettingsInput = Parameters<Api["bot"]["updateSettings"]>[0];
export type CommandUpsertInput = Parameters<Api["bot"]["commands"]["upsert"]>[0];
export type TimerUpsertInput = Parameters<Api["bot"]["timers"]["upsert"]>[0];
export type VariableSetInput = Parameters<Api["bot"]["variables"]["set"]>[0];
export type PointsAdjustInput = Parameters<Api["bot"]["points"]["adjust"]>[0];
export type UserLevel = (typeof USER_LEVELS)[number];
export type AdjustReason = (typeof POINTS_ADJUST_REASONS)[number];

/** What a moderator may do on `/bot`: everything but the settings (owner and editors only). */
export const botAbilities = (role: "owner" | "moderator"): { settings: boolean } => ({ settings: role === "owner" });

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

export const BOT_LIMITS = {
  displayNameMax: 25,
  pointsNameMax: 20,
  timeoutMax: 1_209_600,
  srMin: 1,
  srMax: 200,
} as const;

export interface BotSettingsDraft {
  enabled: boolean;
  displayName: string;
  spam: boolean;
  links: boolean;
  caps: boolean;
  /** Filter timeout in seconds, as typed. */
  timeout: string;
  pointsEnabled: boolean;
  pointsName: string;
  srEnabled: boolean;
  /** Song request queue size, as typed. */
  srMax: string;
}

export function botSettingsDraft(s: BotSettingsDto): BotSettingsDraft {
  const c = s.config;
  return {
    enabled: s.enabled,
    displayName: c.displayName,
    spam: c.filters.spam.enabled,
    links: c.filters.links.enabled,
    caps: c.filters.caps.enabled,
    timeout: String(c.filters.timeoutSeconds),
    pointsEnabled: c.loyalty.enabled,
    pointsName: c.loyalty.pointsName,
    srEnabled: c.songRequests.enabled,
    srMax: String(c.songRequests.maxQueue),
  };
}

export type BotSettingsField = "displayName" | "timeout" | "pointsName" | "srMax";

/**
 * `bot.updateSettings` input: the draft over the loaded config, so the knobs this page does not
 * show (allowlist, caps ratio, repeated characters) keep their stored values.
 */
export function botSettingsInput(
  channel: string,
  d: BotSettingsDraft,
  base: BotConfig,
): Checked<BotSettingsInput, BotSettingsField> {
  const errors: FieldErrors<BotSettingsField> = {};
  const displayName = d.displayName.trim();
  if (displayName.length < 1 || displayName.length > BOT_LIMITS.displayNameMax)
    errors.displayName = t("bot.settings.error.displayName", { max: BOT_LIMITS.displayNameMax });
  const pointsName = d.pointsName.trim();
  if (pointsName.length < 1 || pointsName.length > BOT_LIMITS.pointsNameMax)
    errors.pointsName = t("bot.settings.error.pointsName", { max: BOT_LIMITS.pointsNameMax });
  const timeoutSeconds = parseBoundedInt(d.timeout, 0, BOT_LIMITS.timeoutMax);
  if (timeoutSeconds === null) errors.timeout = t("bot.settings.error.timeout", { max: BOT_LIMITS.timeoutMax });
  const maxQueue = parseBoundedInt(d.srMax, BOT_LIMITS.srMin, BOT_LIMITS.srMax);
  if (maxQueue === null) errors.srMax = t("bot.settings.error.srMax", { min: BOT_LIMITS.srMin, max: BOT_LIMITS.srMax });
  if (Object.keys(errors).length > 0 || timeoutSeconds === null || maxQueue === null) return { ok: false, errors };
  const config: BotConfig = {
    displayName,
    filters: {
      spam: { ...base.filters.spam, enabled: d.spam },
      links: { ...base.filters.links, enabled: d.links },
      caps: { ...base.filters.caps, enabled: d.caps },
      timeoutSeconds,
    },
    loyalty: { enabled: d.pointsEnabled, pointsName },
    songRequests: { enabled: d.srEnabled, maxQueue },
  };
  return { ok: true, input: { channel, enabled: d.enabled, config } };
}

/** The bot account the save created (shown once, on the first enable), else null. */
export function createdBotAccount(before: BotSettingsDto, after: BotSettingsDto): string | null {
  return before.botUser === null && after.botUser !== null ? after.botUser.username : null;
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────

export const COMMAND_LIMITS = {
  nameMax: 25,
  aliasesMax: 5,
  responseMax: 500,
  cooldownMax: 3600,
  costMax: 1_000_000,
} as const;

const COMMAND_NAME = /^[a-z0-9_]{1,25}$/;

export interface CommandDraft {
  name: string;
  /** Comma-separated. */
  aliases: string;
  response: string;
  level: UserLevel;
  cooldown: string;
  cost: string;
  enabled: boolean;
}

export const emptyCommandDraft = (): CommandDraft => ({
  name: "",
  aliases: "",
  response: "",
  level: "everyone",
  cooldown: "5",
  cost: "0",
  enabled: true,
});

export const commandDraft = (c: BotCommandDto): CommandDraft => ({
  name: c.name,
  aliases: c.aliases.join(", "),
  response: c.response,
  level: c.userLevel,
  cooldown: String(c.cooldownSeconds),
  cost: String(c.costPoints),
  enabled: c.enabled,
});

/** A typed command name without its `!`, lower-cased. */
export const commandName = (text: string): string => text.trim().replace(/^!+/, "").toLowerCase();

/** The comma-separated aliases as names, empty entries dropped, duplicates removed. */
export function parseAliases(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map(commandName)
        .filter((a) => a.length > 0),
    ),
  ];
}

export type CommandField = "name" | "aliases" | "response" | "cooldown" | "cost";

const isBuiltin = (name: string): boolean => (BOT_BUILTIN_COMMANDS as readonly string[]).includes(name);

export function commandInput(channel: string, d: CommandDraft): Checked<CommandUpsertInput, CommandField> {
  const errors: FieldErrors<CommandField> = {};
  const name = commandName(d.name);
  if (!COMMAND_NAME.test(name)) errors.name = t("bot.command.error.name", { max: COMMAND_LIMITS.nameMax });
  else if (isBuiltin(name)) errors.name = t("bot.command.error.builtin");
  const aliases = parseAliases(d.aliases).filter((a) => a !== name);
  if (aliases.length > COMMAND_LIMITS.aliasesMax)
    errors.aliases = t("bot.command.error.aliasCount", { max: COMMAND_LIMITS.aliasesMax });
  else if (aliases.some((a) => !COMMAND_NAME.test(a))) errors.aliases = t("bot.command.error.alias");
  else if (aliases.some(isBuiltin)) errors.aliases = t("bot.command.error.builtin");
  const response = d.response.trim();
  if (response.length < 1 || response.length > COMMAND_LIMITS.responseMax)
    errors.response = t("bot.command.error.response", { max: COMMAND_LIMITS.responseMax });
  const cooldownSeconds = parseBoundedInt(d.cooldown, 0, COMMAND_LIMITS.cooldownMax);
  if (cooldownSeconds === null) errors.cooldown = t("bot.command.error.cooldown", { max: COMMAND_LIMITS.cooldownMax });
  const costPoints = parseBoundedInt(d.cost, 0, COMMAND_LIMITS.costMax);
  if (costPoints === null) errors.cost = t("bot.command.error.cost");
  if (Object.keys(errors).length > 0 || cooldownSeconds === null || costPoints === null) return { ok: false, errors };
  return {
    ok: true,
    input: {
      channel,
      name,
      aliases,
      response,
      userLevel: d.level,
      cooldownSeconds,
      costPoints,
      enabled: d.enabled,
    },
  };
}

/** `command-error` text for a refused save. */
export function commandSaveError(err: unknown): string {
  const code = errorCode(err);
  if (code === "CONFLICT") return t("bot.command.error.conflict");
  if (code === "PRECONDITION_FAILED" && errorRequirement(err) === "bot_command_limit")
    return t("bot.command.error.limit");
  if (code === "BAD_REQUEST") return t("bot.command.error.invalid");
  if (code === "FORBIDDEN") return t("bot.error.forbidden");
  return t("bot.command.error.failed");
}

const LEVEL_KEYS: Record<UserLevel, MessageKey> = {
  everyone: "bot.level.everyone",
  follower: "bot.level.follower",
  subscriber: "bot.level.subscriber",
  vip: "bot.level.vip",
  moderator: "bot.level.moderator",
  broadcaster: "bot.level.broadcaster",
};
export const userLevelLabel = (level: UserLevel): string => t(LEVEL_KEYS[level]);
export const isUserLevel = (v: string): v is UserLevel => (USER_LEVELS as readonly string[]).includes(v);

/** The template variables of docs/streamers/channel-bot.md, with what each becomes. */
export const BOT_TEMPLATE_VARIABLES: readonly { token: string; key: MessageKey }[] = [
  { token: "${user}", key: "bot.variables.help.user" },
  { token: "${touser}", key: "bot.variables.help.touser" },
  { token: "${count}", key: "bot.variables.help.count" },
  { token: "${channel}", key: "bot.variables.help.channel" },
  { token: "${uptime}", key: "bot.variables.help.uptime" },
  { token: "${points}", key: "bot.variables.help.points" },
  { token: "${pointsName}", key: "bot.variables.help.pointsName" },
  { token: "${var:name}", key: "bot.variables.help.var" },
];

// ── Timers ───────────────────────────────────────────────────────────────────────────────────

export const TIMER_LIMITS = {
  nameMax: 50,
  messageMax: 500,
  intervalMin: 1,
  intervalMax: 1440,
  linesMin: 1,
  linesMax: 1000,
} as const;

export interface TimerDraft {
  /** Set when editing (`bot.timers.upsert` updates by id). */
  id?: string;
  name: string;
  message: string;
  interval: string;
  minLines: string;
  enabled: boolean;
}

export const emptyTimerDraft = (): TimerDraft => ({
  name: "",
  message: "",
  interval: "15",
  minLines: "5",
  enabled: true,
});

export const timerDraft = (tm: BotTimerDto): TimerDraft => ({
  id: tm.id,
  name: tm.name,
  message: tm.message,
  interval: String(tm.intervalMinutes),
  minLines: String(tm.minChatLines),
  enabled: tm.enabled,
});

export type TimerField = "name" | "message" | "interval" | "minLines";

export function timerInput(channel: string, d: TimerDraft): Checked<TimerUpsertInput, TimerField> {
  const errors: FieldErrors<TimerField> = {};
  const name = d.name.trim();
  if (name.length < 1 || name.length > TIMER_LIMITS.nameMax)
    errors.name = t("bot.timer.error.name", { max: TIMER_LIMITS.nameMax });
  const message = d.message.trim();
  if (message.length < 1 || message.length > TIMER_LIMITS.messageMax)
    errors.message = t("bot.timer.error.message", { max: TIMER_LIMITS.messageMax });
  const intervalMinutes = parseBoundedInt(d.interval, TIMER_LIMITS.intervalMin, TIMER_LIMITS.intervalMax);
  if (intervalMinutes === null)
    errors.interval = t("bot.timer.error.interval", { min: TIMER_LIMITS.intervalMin, max: TIMER_LIMITS.intervalMax });
  const minChatLines = parseBoundedInt(d.minLines, TIMER_LIMITS.linesMin, TIMER_LIMITS.linesMax);
  if (minChatLines === null)
    errors.minLines = t("bot.timer.error.minLines", { min: TIMER_LIMITS.linesMin, max: TIMER_LIMITS.linesMax });
  if (Object.keys(errors).length > 0 || intervalMinutes === null || minChatLines === null) return { ok: false, errors };
  const input: TimerUpsertInput = { channel, name, message, intervalMinutes, minChatLines, enabled: d.enabled };
  if (d.id !== undefined) input.id = d.id;
  return { ok: true, input };
}

/** Text for a refused timer save. */
export function timerSaveError(err: unknown): string {
  if (errorCode(err) === "PRECONDITION_FAILED" && errorRequirement(err) === "bot_timer_limit")
    return t("bot.timer.error.limit");
  if (errorCode(err) === "FORBIDDEN") return t("bot.error.forbidden");
  return t("bot.timer.error.failed");
}

// ── Variables ────────────────────────────────────────────────────────────────────────────────

export const VARIABLE_LIMITS = { nameMax: 30, valueMax: 500 } as const;

export interface VariableDraft {
  name: string;
  value: string;
}

export type VariableField = "name" | "value";

export function variableInput(channel: string, d: VariableDraft): Checked<VariableSetInput, VariableField> {
  const errors: FieldErrors<VariableField> = {};
  const name = d.name.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,30}$/.test(name)) errors.name = t("bot.variable.error.name", { max: VARIABLE_LIMITS.nameMax });
  if (d.value.length > VARIABLE_LIMITS.valueMax)
    errors.value = t("bot.variable.error.value", { max: VARIABLE_LIMITS.valueMax });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: { channel, name, value: d.value } };
}

/** Text for a refused variable save. */
export function variableSaveError(err: unknown): string {
  if (errorCode(err) === "PRECONDITION_FAILED" && errorRequirement(err) === "bot_variable_limit")
    return t("bot.variable.error.limit");
  return t("bot.variable.error.failed");
}

// ── Song requests ────────────────────────────────────────────────────────────────────────────

/**
 * The `href` for a requested link: only `http(s)` URLs become links (opened in a new tab with
 * `rel="noopener noreferrer nofollow"`); anything else is shown as text. Nothing is ever fetched.
 */
export function songLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** The queue first (oldest first, the order they play in), then played and skipped, newest first. */
export function orderedSongRequests(rows: readonly SongRequestDto[]): SongRequestDto[] {
  const queued = rows.filter((r) => r.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = rows.filter((r) => r.status !== "queued").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...queued, ...done];
}

const SONG_STATUS_KEYS: Record<SongRequestDto["status"], MessageKey> = {
  queued: "bot.sr.status.queued",
  played: "bot.sr.status.played",
  skipped: "bot.sr.status.skipped",
};
export const songStatusLabel = (s: SongRequestDto["status"]): string => t(SONG_STATUS_KEYS[s]);

// ── Points ───────────────────────────────────────────────────────────────────────────────────

export const ADJUST_LIMIT = 1_000_000;

export interface AdjustDraft {
  username: string;
  /** Signed whole points, as typed. */
  delta: string;
  reason: AdjustReason;
}

export const emptyAdjustDraft = (): AdjustDraft => ({ username: "", delta: "", reason: "reward" });

export type AdjustField = "username" | "delta";

export function adjustInput(channel: string, d: AdjustDraft): Checked<PointsAdjustInput, AdjustField> {
  const errors: FieldErrors<AdjustField> = {};
  const username = d.username.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(username)) errors.username = t("bot.points.error.username");
  const delta = parseBoundedInt(d.delta, -ADJUST_LIMIT, ADJUST_LIMIT);
  if (delta === null || delta === 0) errors.delta = t("bot.points.error.delta", { max: ADJUST_LIMIT });
  if (Object.keys(errors).length > 0 || delta === null) return { ok: false, errors };
  return { ok: true, input: { channel, username, delta, reason: d.reason } };
}

/** The inline text for a refused adjust (`insufficient_points` when a deduction would go below 0). */
export function adjustError(err: unknown): string {
  const code = errorCode(err);
  if (code === "PRECONDITION_FAILED" && errorRequirement(err) === "insufficient_points")
    return t("bot.points.error.insufficient");
  if (code === "NOT_FOUND") return t("bot.points.error.notFound");
  if (code === "BAD_REQUEST") return t("bot.points.error.invalid");
  if (code === "FORBIDDEN") return t("bot.error.forbidden");
  return t("bot.points.error.failed");
}

const REASON_KEYS: Record<AdjustReason, MessageKey> = {
  correction: "bot.points.reason.correction",
  reward: "bot.points.reason.reward",
  penalty: "bot.points.reason.penalty",
  other: "bot.points.reason.other",
};
export const adjustReasonLabel = (r: AdjustReason): string => t(REASON_KEYS[r]);
export const isAdjustReason = (v: string): v is AdjustReason =>
  (POINTS_ADJUST_REASONS as readonly string[]).includes(v);
