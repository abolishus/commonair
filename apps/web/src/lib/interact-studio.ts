// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/interact` (studio) logic, pure for unit tests: who may do what, the poll, prediction and goal
 * forms (bounds from `interact.*` in the contract router), payouts after a resolve and the raid
 * refusal codes (docs/testing/e8-selectors.md "Raids"). The API is the authority; these checks
 * only keep a refused request from being sent.
 */
import { GOAL_TYPES, RAID_POLICIES } from "@commonair/contracts/enums";
import { parseAmount } from "@commonair/ui/blocks/forms";
import { t, type MessageKey } from "../i18n/index.ts";
import { errorCode, type Api } from "./api.ts";
import { errorRequirement } from "./coop.ts";

export type PollDto = NonNullable<Awaited<ReturnType<Api["interact"]["polls"]["current"]>>>;
export type PredictionDto = NonNullable<Awaited<ReturnType<Api["interact"]["predictions"]["current"]>>>;
export type RaidStateDto = Awaited<ReturnType<Api["interact"]["raids"]["current"]>>;
export type RaidDto = NonNullable<RaidStateDto["raid"]>;
export type GoalDto = Awaited<ReturnType<Api["interact"]["goals"]["list"]>>[number];
export type PollCreateInput = Parameters<Api["interact"]["polls"]["create"]>[0];
export type PredictionCreateInput = Parameters<Api["interact"]["predictions"]["create"]>[0];
export type GoalCreateInput = Parameters<Api["interact"]["goals"]["create"]>[0];
export type RaidPolicy = (typeof RAID_POLICIES)[number];
export type GoalType = (typeof GOAL_TYPES)[number];

// ── Roles ─────────────────────────────────────────────────────────────────────────────────────

/** `owner` covers the channel's editors too: the API lets them do everything an owner does here. */
export type StudioRole = "owner" | "moderator";

export interface StudioRoleRow {
  user: { id: string };
  role: string;
}

/**
 * The caller's role on `channel`: their own channel is `owner`; elsewhere an `editor` row counts as
 * owner and a `moderator` row as moderator (`channels.roles.list`); anything else has no studio.
 */
export function studioRole(
  me: { id: string; channelSlug: string | null; username: string },
  channel: string,
  roles: readonly StudioRoleRow[] | null,
): StudioRole | null {
  if (channel === (me.channelSlug ?? me.username)) return "owner";
  const mine = (roles ?? []).filter((r) => r.user.id === me.id).map((r) => r.role);
  if (mine.includes("editor")) return "owner";
  if (mine.includes("moderator")) return "moderator";
  return null;
}

/** What each role sees on `/interact` (raids, the raid policy and goal changes are owner-only). */
export function interactAbilities(role: StudioRole): { raids: boolean; manageGoals: boolean } {
  return { raids: role === "owner", manageGoals: role === "owner" };
}

/** The `?channel=` search value: a lower-cased slug, or undefined for one's own channel. */
export function channelSearch(search: Record<string, unknown>): { channel?: string } {
  const raw = search.channel;
  if (typeof raw !== "string") return {};
  const slug = raw.trim().toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(slug) ? { channel: slug } : {};
}

// ── Numbers typed into a field ───────────────────────────────────────────────────────────────

/** A whole number in `[min, max]` typed as text, or null. */
export function parseBoundedInt(text: string, min: number, max: number): number | null {
  const s = text.trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export type FieldErrors<F extends string> = Partial<Record<F, string>>;
export type Checked<I, F extends string> = { ok: true; input: I } | { ok: false; errors: FieldErrors<F> };

const failed = <I, F extends string>(errors: FieldErrors<F>): Checked<I, F> => ({ ok: false, errors });

// ── Polls ────────────────────────────────────────────────────────────────────────────────────

/** `interact.polls.create` bounds. */
export const POLL_LIMITS = {
  titleMax: 60,
  choiceMax: 25,
  minChoices: 2,
  maxChoices: 5,
  minSeconds: 15,
  maxSeconds: 1800,
  extraCostMax: 1_000_000,
} as const;

export interface PollDraft {
  title: string;
  /** Always at least two entries (the first two inputs are always shown). */
  choices: string[];
  /** Seconds, as typed. */
  duration: string;
  /** Points per bought vote, as typed; 0 = none. */
  extraCost: string;
}

export const emptyPollDraft = (): PollDraft => ({ title: "", choices: ["", ""], duration: "120", extraCost: "0" });

export type PollField = "title" | "choices" | "duration" | "extraCost";

export function pollInput(channel: string, d: PollDraft): Checked<PollCreateInput, PollField> {
  const errors: FieldErrors<PollField> = {};
  const title = d.title.trim();
  if (title.length < 1 || title.length > POLL_LIMITS.titleMax)
    errors.title = t("interact.poll.error.title", { max: POLL_LIMITS.titleMax });
  const choices = d.choices.map((c) => c.trim()).filter((c) => c.length > 0);
  if (choices.length < POLL_LIMITS.minChoices || choices.length > POLL_LIMITS.maxChoices)
    errors.choices = t("interact.poll.error.choices", { min: POLL_LIMITS.minChoices, max: POLL_LIMITS.maxChoices });
  else if (choices.some((c) => c.length > POLL_LIMITS.choiceMax))
    errors.choices = t("interact.poll.error.choiceLength", { max: POLL_LIMITS.choiceMax });
  const durationSeconds = parseBoundedInt(d.duration, POLL_LIMITS.minSeconds, POLL_LIMITS.maxSeconds);
  if (durationSeconds === null)
    errors.duration = t("interact.poll.error.duration", { min: POLL_LIMITS.minSeconds, max: POLL_LIMITS.maxSeconds });
  const pointsPerExtraVote = parseBoundedInt(d.extraCost, 0, POLL_LIMITS.extraCostMax);
  if (pointsPerExtraVote === null) errors.extraCost = t("interact.poll.error.extraCost");
  if (Object.keys(errors).length > 0 || durationSeconds === null || pointsPerExtraVote === null) return failed(errors);
  return { ok: true, input: { channel, title, choices, durationSeconds, pointsPerExtraVote } };
}

export const pollTotal = (p: PollDto): number => p.choices.reduce((sum, c) => sum + c.votes, 0);
/** A share in whole percent (0 with no votes). */
export const percentOf = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);
/** Ended polls (not archived, which `current` never returns) can be archived. */
export const canArchivePoll = (p: PollDto): boolean => p.status === "completed" || p.status === "terminated";
/** A new poll may start unless one is running. */
export const canStartPoll = (p: PollDto | null): boolean => p === null || p.status !== "active";

const POLL_STATUS_KEYS: Record<PollDto["status"], MessageKey> = {
  active: "interact.poll.status.active",
  completed: "interact.poll.status.completed",
  terminated: "interact.poll.status.terminated",
  archived: "interact.poll.status.archived",
};
export const pollStatusLabel = (s: PollDto["status"]): string => t(POLL_STATUS_KEYS[s]);

// ── Predictions ──────────────────────────────────────────────────────────────────────────────

/** `interact.predictions.create` bounds. */
export const PREDICTION_LIMITS = {
  titleMax: 45,
  outcomeMax: 25,
  minOutcomes: 2,
  maxOutcomes: 10,
  minSeconds: 30,
  maxSeconds: 1800,
} as const;

export interface PredictionDraft {
  title: string;
  outcomes: string[];
  /** Betting window in seconds, as typed. */
  window: string;
}

export const emptyPredictionDraft = (): PredictionDraft => ({ title: "", outcomes: ["", ""], window: "120" });

export type PredictionField = "title" | "outcomes" | "window";

export function predictionInput(channel: string, d: PredictionDraft): Checked<PredictionCreateInput, PredictionField> {
  const errors: FieldErrors<PredictionField> = {};
  const title = d.title.trim();
  if (title.length < 1 || title.length > PREDICTION_LIMITS.titleMax)
    errors.title = t("interact.prediction.error.title", { max: PREDICTION_LIMITS.titleMax });
  const outcomes = d.outcomes.map((o) => o.trim()).filter((o) => o.length > 0);
  if (outcomes.length < PREDICTION_LIMITS.minOutcomes || outcomes.length > PREDICTION_LIMITS.maxOutcomes)
    errors.outcomes = t("interact.prediction.error.outcomes", {
      min: PREDICTION_LIMITS.minOutcomes,
      max: PREDICTION_LIMITS.maxOutcomes,
    });
  else if (outcomes.some((o) => o.length > PREDICTION_LIMITS.outcomeMax))
    errors.outcomes = t("interact.prediction.error.outcomeLength", { max: PREDICTION_LIMITS.outcomeMax });
  const windowSeconds = parseBoundedInt(d.window, PREDICTION_LIMITS.minSeconds, PREDICTION_LIMITS.maxSeconds);
  if (windowSeconds === null)
    errors.window = t("interact.prediction.error.window", {
      min: PREDICTION_LIMITS.minSeconds,
      max: PREDICTION_LIMITS.maxSeconds,
    });
  if (Object.keys(errors).length > 0 || windowSeconds === null) return failed(errors);
  return { ok: true, input: { channel, title, outcomes, windowSeconds } };
}

export const predictionPool = (p: PredictionDto): number => p.outcomes.reduce((sum, o) => sum + o.points, 0);
export const isPredictionOpen = (p: PredictionDto): boolean => p.status === "active" || p.status === "locked";
export const canStartPrediction = (p: PredictionDto | null): boolean => p === null || !isPredictionOpen(p);

export type OutcomeResult = "won" | "lost" | "refunded";

export interface OutcomePayout {
  id: string;
  result: OutcomeResult;
  /** Points paid back to this outcome's bettors (the whole pool for a winner, their own on refund). */
  paid: number;
}

/**
 * What a resolve or cancel paid per outcome, from the view: the winners split the whole pool;
 * a winner nobody bet on, or a cancel, refunds every bet. Null while the prediction is open.
 */
export function predictionPayouts(p: PredictionDto): OutcomePayout[] | null {
  if (p.status === "canceled") return p.outcomes.map((o) => ({ id: o.id, result: "refunded", paid: o.points }));
  if (p.status !== "resolved") return null;
  const winner = p.outcomes.find((o) => o.id === p.winningOutcomeId);
  if (!winner || winner.users === 0) return p.outcomes.map((o) => ({ id: o.id, result: "refunded", paid: o.points }));
  const pool = predictionPool(p);
  return p.outcomes.map((o) =>
    o.id === winner.id ? { id: o.id, result: "won", paid: pool } : { id: o.id, result: "lost", paid: 0 },
  );
}

const PREDICTION_STATUS_KEYS: Record<PredictionDto["status"], MessageKey> = {
  active: "interact.prediction.status.active",
  locked: "interact.prediction.status.locked",
  resolved: "interact.prediction.status.resolved",
  canceled: "interact.prediction.status.canceled",
};
export const predictionStatusLabel = (s: PredictionDto["status"]): string => t(PREDICTION_STATUS_KEYS[s]);

// ── Raids ────────────────────────────────────────────────────────────────────────────────────

/** `raid-error` `data-code` values: the API's precondition codes, the pending `CONFLICT` and the rest. */
export const RAID_ERROR_CODES = [
  "raid_source_offline",
  "raid_target_offline",
  "raid_suspended",
  "raid_refused",
  "raid_cooldown",
  "raid_pending",
  "raid_not_found",
  "raid_invalid",
  "raid_failed",
] as const;
export type RaidErrorCode = (typeof RAID_ERROR_CODES)[number];

const RAID_ERROR_KEYS: Record<RaidErrorCode, MessageKey> = {
  raid_source_offline: "interact.raid.error.sourceOffline",
  raid_target_offline: "interact.raid.error.targetOffline",
  raid_suspended: "interact.raid.error.suspended",
  raid_refused: "interact.raid.error.refused",
  raid_cooldown: "interact.raid.error.cooldown",
  raid_pending: "interact.raid.error.pending",
  raid_not_found: "interact.raid.error.notFound",
  raid_invalid: "interact.raid.error.invalid",
  raid_failed: "interact.raid.error.failed",
};

const isRaidErrorCode = (v: string): v is RaidErrorCode => (RAID_ERROR_CODES as readonly string[]).includes(v);

/** Why `interact.raids.start` was refused (`error.data.requirement`, as `coop.ts` reads it). */
export function raidErrorCode(err: unknown): RaidErrorCode {
  const code = errorCode(err);
  const requirement = errorRequirement(err);
  if (code === "PRECONDITION_FAILED" && requirement !== null && isRaidErrorCode(requirement)) return requirement;
  if (code === "CONFLICT") return "raid_pending";
  if (code === "NOT_FOUND") return "raid_not_found";
  if (code === "BAD_REQUEST") return "raid_invalid";
  return "raid_failed";
}

export const raidErrorMessage = (code: RaidErrorCode): string => t(RAID_ERROR_KEYS[code]);

/** The typed raid target as a slug (a leading `@` and surrounding space dropped), or null. */
export function raidTarget(text: string): string | null {
  const slug = text.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(slug) ? slug : null;
}

/** The cooldown's end while it is still running at `now`, else null. */
export function raidCooldownUntil(state: RaidStateDto, now: number): string | null {
  const until = state.cooldownEndsAt;
  return until !== null && Date.parse(until) > now ? until : null;
}

const RAID_STATUS_KEYS: Record<RaidDto["status"], MessageKey> = {
  pending: "interact.raid.status.pending",
  completed: "interact.raid.status.completed",
  canceled: "interact.raid.status.canceled",
};
export const raidStatusLabel = (s: RaidDto["status"]): string => t(RAID_STATUS_KEYS[s]);

const CANCEL_REASON_KEYS: Record<NonNullable<RaidDto["cancelReason"]>, MessageKey> = {
  owner: "interact.raid.cancelReason.owner",
  target_offline: "interact.raid.cancelReason.targetOffline",
  target_refused: "interact.raid.cancelReason.targetRefused",
  suspended: "interact.raid.cancelReason.suspended",
  source_offline: "interact.raid.cancelReason.sourceOffline",
};
export const raidCancelReasonLabel = (r: NonNullable<RaidDto["cancelReason"]>): string => t(CANCEL_REASON_KEYS[r]);

const RAID_POLICY_KEYS: Record<RaidPolicy, MessageKey> = {
  anyone: "interact.raid.policy.anyone",
  followed: "interact.raid.policy.followed",
  off: "interact.raid.policy.off",
};
export const raidPolicyLabel = (p: RaidPolicy): string => t(RAID_POLICY_KEYS[p]);
export const isRaidPolicy = (v: string): v is RaidPolicy => (RAID_POLICIES as readonly string[]).includes(v);

// ── Goals ────────────────────────────────────────────────────────────────────────────────────

export const GOAL_LIMITS = { titleMax: 60, countMax: 1_000_000_000 } as const;

export interface GoalDraft {
  type: GoalType;
  title: string;
  /** Followers or subscriptions as a count; tips in the currency's major units. */
  target: string;
}

export const emptyGoalDraft = (): GoalDraft => ({ type: "followers", title: "", target: "" });
export const isGoalType = (v: string): v is GoalType => (GOAL_TYPES as readonly string[]).includes(v);

export type GoalField = "title" | "target";

/** `interact.goals.create` input; a tips target is typed in major units and sent in minor units. */
export function goalInput(
  channel: string,
  d: GoalDraft,
  currency: string,
  locale: string,
): Checked<GoalCreateInput, GoalField> {
  const errors: FieldErrors<GoalField> = {};
  const title = d.title.trim();
  if (title.length < 1 || title.length > GOAL_LIMITS.titleMax)
    errors.title = t("interact.goal.error.title", { max: GOAL_LIMITS.titleMax });
  const target =
    d.type === "tips" ? parseAmount(d.target, currency, locale) : parseBoundedInt(d.target, 1, GOAL_LIMITS.countMax);
  if (target === null || target < 1)
    errors.target = d.type === "tips" ? t("interact.goal.error.amount") : t("interact.goal.error.count");
  if (Object.keys(errors).length > 0 || target === null) return failed(errors);
  return { ok: true, input: { channel, type: d.type, title, target } };
}

/** Progress in whole percent, capped at 100. */
export const goalPercent = (g: GoalDto): number => Math.min(100, percentOf(g.current, g.target));

const GOAL_TYPE_KEYS: Record<GoalType, MessageKey> = {
  followers: "interact.goal.type.followers",
  subscriptions: "interact.goal.type.subscriptions",
  tips: "interact.goal.type.tips",
};
export const goalTypeLabel = (type: GoalType): string => t(GOAL_TYPE_KEYS[type]);

/** Open goals first (newest first), then ended ones as the API listed them. */
export function orderedGoals(goals: readonly GoalDto[]): GoalDto[] {
  const open = goals.filter((g) => g.endedAt === null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return [...open, ...goals.filter((g) => g.endedAt !== null)];
}
