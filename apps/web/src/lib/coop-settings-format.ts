// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Plain-language governance settings (overhaul D6.2, coop-trust CT-4): one spec per known setting
 * key (the keys `packages/db/src/seed.ts` seeds and `packages/governance` reads), naming its theme,
 * its title and the fields a member can read and edit. Every value is formatted through the
 * catalog and the `@commonair/ui` formatters (percent, money, units), never `toFixed` or JSON.
 *
 * Unknown keys, and values that are not the shape we know, still render: a generic formatter
 * shows flat values as they are stored and everything else as "Custom value", with the raw JSON
 * left to a "Technical details" disclosure. Nothing here decides a rule: the database validates
 * every change, this only reads.
 */
import { NO_VALUE, formatInteger, formatMoney, formatNumber, formatPercent, formatUnit } from "@commonair/ui";
import { t, type MessageKey } from "../i18n/index.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────────────────────

export type Path = readonly string[];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at `path`, or undefined when any step is missing or not an object. */
export function readPath(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const step of path) {
    if (!isRecord(cur) || !(step in cur)) return undefined;
    cur = cur[step];
  }
  return cur;
}

/** A copy of `root` with `value` at `path` (missing objects on the way are created). */
export function writePath(root: unknown, path: Path, value: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(root) ? { ...root } : {};
  const [head, ...rest] = path;
  if (head === undefined) return base;
  base[head] = rest.length === 0 ? value : writePath(base[head], rest, value);
  return base;
}

/** Structural equality for JSON values (key order does not matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

/** Every leaf path of a JSON value (arrays and primitives are leaves; `[]` for a non-object). */
export function leafPaths(value: unknown, prefix: Path = []): string[][] {
  if (!isRecord(value)) return [[...prefix]];
  const keys = Object.keys(value);
  if (keys.length === 0) return [[...prefix]];
  return keys.flatMap((k) => leafPaths(value[k], [...prefix, k]));
}

// ── Field kinds ───────────────────────────────────────────────────────────────────────────────

export type FieldKind =
  /** A fraction shown as a percent (0.9 → "90%"). */
  | "percent"
  /** A classifier score from 0 to 1, shown as a plain number (0.97). */
  | "score"
  /** Durations stored in that unit. */
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "months"
  /** Integer minor units of the currency at `currencyPath` (default USD). */
  | "money"
  | "integer"
  | "boolean"
  | "text"
  /** A five-field cron expression, described in words when it is a common shape. */
  | "cron"
  /** A list of setting keys, shown by their titles. */
  | "keys";

export interface FieldSpec {
  /** Stable id (the path joined by dots). */
  id: string;
  path: Path;
  label: MessageKey;
  kind: FieldKind;
  /** money: where the currency code lives in the same setting. */
  currencyPath?: Path;
  /** Read-only: always `1 - <complementOf>` (the co-op share of the cut). */
  complementOf?: Path;
  /** Inclusive bounds in the stored unit (the database enforces its own). */
  min?: number;
  max?: number;
}

/** The database's cap on every governance period (migration 0002): 90 days. */
export const MAX_PERIOD_SECONDS = 7_776_000;

const field = (path: string, label: MessageKey, kind: FieldKind, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  id: path,
  path: path.split("."),
  label,
  kind,
  ...extra,
});

const share = { min: 0, max: 1 } as const;
const period = { min: 0, max: MAX_PERIOD_SECONDS } as const;
const count = { min: 0 } as const;

// ── Themes ────────────────────────────────────────────────────────────────────────────────────

export const SETTING_THEMES = [
  "money",
  "governance",
  "membership",
  "discovery",
  "safety",
  "features",
  "other",
] as const;
export type SettingTheme = (typeof SETTING_THEMES)[number];

const THEME_KEYS: Record<SettingTheme, MessageKey> = {
  money: "d6Governance.theme.money",
  governance: "d6Governance.theme.governance",
  membership: "d6Governance.theme.membership",
  discovery: "d6Governance.theme.discovery",
  safety: "d6Governance.theme.safety",
  features: "d6Governance.theme.features",
  other: "d6Governance.theme.other",
};
const THEME_HINT_KEYS: Record<SettingTheme, MessageKey> = {
  money: "d6Governance.theme.moneyHint",
  governance: "d6Governance.theme.governanceHint",
  membership: "d6Governance.theme.membershipHint",
  discovery: "d6Governance.theme.discoveryHint",
  safety: "d6Governance.theme.safetyHint",
  features: "d6Governance.theme.featuresHint",
  other: "d6Governance.theme.otherHint",
};

export const themeLabel = (theme: SettingTheme): string => t(THEME_KEYS[theme]);
export const themeHint = (theme: SettingTheme): string => t(THEME_HINT_KEYS[theme]);

// ── Formatting one field ──────────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A fraction as a percent with at most one decimal: 0.9 → "90%", 2/3 → "66.7%". */
export const percentText = (fraction: number, locale: string): string =>
  formatPercent(fraction, locale, { maximumFractionDigits: 1 });

const unitText = (value: number, unit: string, locale: string): string =>
  formatUnit(value, unit, locale, { unitDisplay: "long", maximumFractionDigits: 1 });

const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;

export type DurationUnit = "days" | "hours" | "minutes" | "seconds";
export const DURATION_UNIT_SECONDS: Record<DurationUnit, number> = {
  days: DAY,
  hours: HOUR,
  minutes: MINUTE,
  seconds: 1,
};

/** The largest unit that divides the duration evenly (zero reads in days). */
export function durationUnit(seconds: number): DurationUnit {
  if (seconds === 0 || seconds % DAY === 0) return "days";
  if (seconds % HOUR === 0) return "hours";
  if (seconds % MINUTE === 0) return "minutes";
  return "seconds";
}

const INTL_UNIT: Record<DurationUnit, string> = { days: "day", hours: "hour", minutes: "minute", seconds: "second" };

/** 1_209_600 → "14 days", 5_400 → "90 minutes". */
export function durationText(seconds: number, locale: string): string {
  const unit = durationUnit(seconds);
  return unitText(seconds / DURATION_UNIT_SECONDS[unit], INTL_UNIT[unit], locale);
}

/** A period as an adjective, from seconds: "14-day" (en), "de 14 días" (es). */
function periodAdjective(seconds: number, locale: string): string {
  const unit = durationUnit(seconds);
  const amount = seconds / DURATION_UNIT_SECONDS[unit];
  const n = formatNumber(amount, locale);
  switch (unit) {
    case "days":
      return t("d6Governance.fmt.periodDays", { count: amount, n });
    case "hours":
      return t("d6Governance.fmt.periodHours", { count: amount, n });
    case "minutes":
      return t("d6Governance.fmt.periodMinutes", { count: amount, n });
    case "seconds":
      return t("d6Governance.fmt.periodSeconds", { count: amount, n });
  }
}

const CRON_FIELD = /^(\*|\d{1,2})$/;

/**
 * Common five-field cron shapes in words ("Monthly on day 1 at 03:00 UTC"); anything else reads
 * "On the schedule {expression}" so nothing is hidden.
 */
export function describeCron(expression: string, locale: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length === 5 && parts.every((p) => CRON_FIELD.test(p))) {
    const [minute = "*", hour = "*", dom = "*", month = "*", dow = "*"] = parts;
    const pad = (s: string) => s.padStart(2, "0");
    const at = hour !== "*" && minute !== "*" ? `${pad(hour)}:${pad(minute)}` : null;
    if (month === "*" && at) {
      if (dom !== "*" && dow === "*")
        return t("d6Governance.fmt.cronMonthly", { day: formatInteger(Number(dom), locale), time: at });
      if (dom === "*" && dow !== "*" && Number(dow) <= 7)
        return t("d6Governance.fmt.cronWeekly", { time: at, weekday: String(Number(dow) % 7) });
      if (dom === "*" && dow === "*") return t("d6Governance.fmt.cronDaily", { time: at });
    }
    if (month === "*" && dom === "*" && dow === "*" && hour === "*" && minute !== "*")
      return t("d6Governance.fmt.cronHourly", { minute: formatInteger(Number(minute), locale) });
  }
  return t("d6Governance.fmt.cronRaw", { expression });
}

const onOff = (v: boolean): string => (v ? t("d6Governance.fmt.on") : t("d6Governance.fmt.off"));

/** The currency a money field is in: the setting's own code when it has one, else USD. */
function currencyOf(spec: FieldSpec, root: unknown): string {
  const code = spec.currencyPath ? readPath(root, spec.currencyPath) : undefined;
  return typeof code === "string" && /^[a-z]{3}$/i.test(code) ? code : "usd";
}

/** A primitive as stored, for unknown shapes: numbers through the locale, objects as null. */
export function genericValueText(value: unknown, locale: string): string | null {
  if (value === null || value === undefined) return NO_VALUE;
  if (typeof value === "number") return formatNumber(value, locale);
  if (typeof value === "boolean") return onOff(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => ["string", "number", "boolean"].includes(typeof v)))
    return value.map((v) => genericValueText(v, locale) ?? "").join(t("common.listSeparator"));
  return null;
}

/**
 * One field of a setting in words, or null when the field is missing. A field of the wrong type
 * is shown as stored (or "Custom value") rather than guessed.
 */
export function formatField(spec: FieldSpec, root: unknown, locale: string): string | null {
  const raw = readPath(root, spec.path);
  if (raw === undefined) return null;
  const n = num(raw);
  const fallback = () => genericValueText(raw, locale) ?? t("d6Governance.fmt.custom");
  switch (spec.kind) {
    case "percent":
      return n === null ? fallback() : percentText(n, locale);
    case "score":
      return n === null ? fallback() : formatNumber(n, locale);
    case "seconds":
      return n === null || n < 0 ? fallback() : durationText(n, locale);
    case "minutes":
      return n === null ? fallback() : unitText(n, "minute", locale);
    case "hours":
      return n === null ? fallback() : unitText(n, "hour", locale);
    case "days":
      return n === null ? fallback() : unitText(n, "day", locale);
    case "months":
      return n === null ? fallback() : unitText(n, "month", locale);
    case "money":
      return n === null || !Number.isInteger(n) ? fallback() : formatMoney(n, currencyOf(spec, root), locale);
    case "integer":
      return n === null ? fallback() : formatNumber(n, locale);
    case "boolean":
      return typeof raw === "boolean" ? onOff(raw) : fallback();
    case "text":
      return typeof raw === "string" ? textValue(spec, raw) : fallback();
    case "cron":
      return typeof raw === "string" ? describeCron(raw, locale) : fallback();
    case "keys":
      return Array.isArray(raw) && raw.every((k) => typeof k === "string")
        ? raw.map((k) => settingTitle(k)).join(t("common.listSeparator"))
        : fallback();
  }
}

/** Known words for text fields (the payout schedule, the currency code); others as stored. */
function textValue(spec: FieldSpec, raw: string): string {
  if (spec.id === "schedule") {
    if (raw === "monthly") return t("d6Governance.fmt.scheduleMonthly");
    if (raw === "weekly") return t("d6Governance.fmt.scheduleWeekly");
  }
  if (spec.id === "currency") return raw.toUpperCase();
  if (spec.id === "worker.appointedBy" && raw === "board") return t("d6Governance.fmt.appointedByBoard");
  return raw;
}

// ── The settings we know ──────────────────────────────────────────────────────────────────────

interface SettingSpec {
  theme: Exclude<SettingTheme, "other">;
  title: MessageKey;
  fields: readonly FieldSpec[];
  /** The one-line summary; null when a field it needs is missing or malformed (the field list is used). */
  summary?: (value: unknown, locale: string) => string | null;
}

/** All of `paths` as finite numbers, or null. */
function nums<const K extends string>(value: unknown, paths: Record<K, string>): Record<K, number> | null {
  const out = {} as Record<K, number>;
  for (const [name, path] of Object.entries(paths) as [K, string][]) {
    const n = num(readPath(value, path.split(".")));
    if (n === null) return null;
    out[name] = n;
  }
  return out;
}

const TWO_THIRDS = 2 / 3;

/** A member-wide threshold: "two thirds", "a simple majority" (0.5) or "60%". */
function thresholdWords(fraction: number, locale: string): string {
  if (Math.abs(fraction - TWO_THIRDS) < 0.001) return t("d6Governance.fmt.twoThirds");
  if (fraction === 0.5) return t("d6Governance.fmt.simpleMajority");
  return t("d6Governance.fmt.percentYes", { percent: percentText(fraction, locale) });
}

const PAYOUT_MINIMUM = field("minimumCents", "d6Governance.field.payoutMinimum", "money", {
  ...count,
  currencyPath: ["currency"],
});
const PAYOUT_SCHEDULE = field("schedule", "d6Governance.field.payoutSchedule", "text");

const SPECS: Record<string, SettingSpec> = {
  "platform.cut": {
    theme: "money",
    title: "d6Governance.setting.platformCut",
    fields: [
      field("streamerShare", "d6Governance.field.streamerShare", "percent", share),
      field("coopShare", "d6Governance.field.coopShare", "percent", { ...share, complementOf: ["streamerShare"] }),
    ],
    summary: (v, locale) => {
      const n = nums(v, { creator: "streamerShare", coop: "coopShare" });
      return n
        ? t("d6Governance.summary.platformCut", {
            creator: percentText(n.creator, locale),
            coop: percentText(n.coop, locale),
          })
        : null;
    },
  },
  "patronage.formula": {
    theme: "money",
    title: "d6Governance.setting.patronageFormula",
    fields: [
      field("weights.revenue", "d6Governance.field.weightRevenue", "percent", share),
      field("weights.streamingHours", "d6Governance.field.weightStreamingHours", "percent", share),
      field("weights.relayBandwidth", "d6Governance.field.weightRelayBandwidth", "percent", share),
      field("weights.viewerHours", "d6Governance.field.weightViewerHours", "percent", share),
      field("weights.dailyStreamingHourCap", "d6Governance.field.dailyStreamingHourCap", "hours", count),
      field("weights.viewerHoursChannelCap", "d6Governance.field.viewerHoursChannelCap", "percent", share),
      field("version", "d6Governance.field.formulaVersion", "text"),
    ],
    summary: (v, locale) => {
      const n = nums(v, {
        revenue: "weights.revenue",
        hours: "weights.streamingHours",
        relay: "weights.relayBandwidth",
        viewers: "weights.viewerHours",
      });
      return n
        ? t("d6Governance.summary.patronageFormula", {
            revenue: percentText(n.revenue, locale),
            hours: percentText(n.hours, locale),
            relay: percentText(n.relay, locale),
            viewers: percentText(n.viewers, locale),
          })
        : null;
    },
  },
  "payout.rules": {
    theme: "money",
    title: "d6Governance.setting.payoutRules",
    fields: [
      PAYOUT_MINIMUM,
      PAYOUT_SCHEDULE,
      field("holdDays", "d6Governance.field.holdDays", "days", count),
      field("currency", "d6Governance.field.currency", "text"),
      field("splitShortfallWriteOffDays", "d6Governance.field.splitShortfallWriteOffDays", "days", count),
      field("splitNewRecipientHoldDays", "d6Governance.field.splitNewRecipientHoldDays", "days", count),
      field("splitRecipientMinAccountAgeDays", "d6Governance.field.splitRecipientMinAccountAgeDays", "days", count),
    ],
    summary: (v, locale) => {
      const n = nums(v, { minimum: "minimumCents", hold: "holdDays" });
      const schedule = readPath(v, ["schedule"]);
      if (!n || typeof schedule !== "string" || !Number.isInteger(n.minimum)) return null;
      return t("d6Governance.summary.payoutRules", {
        minimum: formatMoney(n.minimum, currencyOf(PAYOUT_MINIMUM, v), locale),
        schedule: textValue(PAYOUT_SCHEDULE, schedule),
        hold: unitText(n.hold, "day", locale),
      });
    },
  },
  "membership.classes": {
    theme: "membership",
    title: "d6Governance.setting.membershipClasses",
    fields: [
      field("streamer.minStreamingHours", "d6Governance.field.streamerHours", "hours", count),
      field("streamer.windowDays", "d6Governance.field.streamerWindow", "days", { min: 1 }),
      field("streamer.minVerifiedViewers", "d6Governance.field.streamerViewers", "integer", { min: 1 }),
      field("streamer.lapseGraceDays", "d6Governance.field.streamerGrace", "days", { min: 0, max: 365 }),
      field("viewer.shareCents", "d6Governance.field.viewerShare", "money", count),
      field("viewer.shareRefundableOnExit", "d6Governance.field.viewerShareRefundable", "boolean"),
      field("viewer.activeSubscriptionQualifies", "d6Governance.field.viewerSubQualifies", "boolean"),
      field("viewer.minSubscriptionCents", "d6Governance.field.viewerMinSub", "money", count),
      field("worker.appointedBy", "d6Governance.field.workerAppointedBy", "text"),
    ],
    summary: (v, locale) => {
      const n = nums(v, {
        hours: "streamer.minStreamingHours",
        days: "streamer.windowDays",
        share: "viewer.shareCents",
      });
      if (!n || !Number.isInteger(n.share)) return null;
      return t("d6Governance.summary.membershipClasses", {
        hours: unitText(n.hours, "hour", locale),
        days: unitText(n.days, "day", locale),
        share: formatMoney(n.share, "usd", locale),
      });
    },
  },
  "shares.cardPayments": {
    theme: "membership",
    title: "d6Governance.setting.sharesCardPayments",
    fields: [field("enabled", "d6Governance.field.enabled", "boolean")],
    summary: (v) => {
      const on = readPath(v, ["enabled"]);
      if (typeof on !== "boolean") return null;
      return on ? t("d6Governance.summary.sharesCardOn") : t("d6Governance.summary.sharesCardOff");
    },
  },
  "governance.ordinary": {
    theme: "governance",
    title: "d6Governance.setting.governanceOrdinary",
    fields: [
      field("quorum", "d6Governance.field.quorum", "percent", { min: 0, max: 0.5 }),
      field("threshold", "d6Governance.field.threshold", "percent", { min: 0.5, max: 0.99 }),
      field("discussionSeconds", "d6Governance.field.discussion", "seconds", period),
      field("votingSeconds", "d6Governance.field.voting", "seconds", period),
      field("minVotingSeconds", "d6Governance.field.minVoting", "seconds", period),
    ],
    summary: (v, locale) => {
      const n = nums(v, {
        quorum: "quorum",
        threshold: "threshold",
        discussion: "discussionSeconds",
        voting: "votingSeconds",
      });
      return n
        ? t("d6Governance.summary.governanceOrdinary", {
            quorum: percentText(n.quorum, locale),
            threshold: thresholdWords(n.threshold, locale),
            discussion: periodAdjective(n.discussion, locale),
            voting: periodAdjective(n.voting, locale),
          })
        : null;
    },
  },
  "governance.protections": {
    theme: "governance",
    title: "d6Governance.setting.governanceProtections",
    fields: [
      field("memberWideThreshold", "d6Governance.field.memberWideThreshold", "percent", { min: 0.5, max: 1 }),
      field("streamerClassThreshold", "d6Governance.field.streamerClassThreshold", "percent", { min: 0.5, max: 0.99 }),
      field("quorum", "d6Governance.field.quorum", "percent", { min: 0, max: 0.5 }),
      field("streamerClassQuorum", "d6Governance.field.streamerClassQuorum", "percent", { min: 0, max: 0.5 }),
      field("councilReviewSeconds", "d6Governance.field.councilReview", "seconds", period),
      field("minVotingSeconds", "d6Governance.field.minVoting", "seconds", period),
      field("protectedKeys", "d6Governance.field.protectedKeys", "keys"),
    ],
    summary: (v, locale) => {
      const n = nums(v, {
        member: "memberWideThreshold",
        streamer: "streamerClassThreshold",
        quorum: "quorum",
        review: "councilReviewSeconds",
      });
      if (!n) return null;
      return t("d6Governance.summary.governanceProtections", {
        member: thresholdWords(n.member, locale),
        streamer:
          n.streamer === 0.5
            ? t("d6Governance.fmt.streamerMajority")
            : t("d6Governance.fmt.streamerMoreThan", { percent: percentText(n.streamer, locale) }),
        quorum: percentText(n.quorum, locale),
        review: periodAdjective(n.review, locale),
      });
    },
  },
  "board.seats": {
    theme: "governance",
    title: "d6Governance.setting.boardSeats",
    fields: [
      field("streamer", "d6Governance.field.boardStreamer", "integer", count),
      field("viewer", "d6Governance.field.boardViewer", "integer", count),
      field("worker", "d6Governance.field.boardWorker", "integer", count),
      field("termMonths", "d6Governance.field.termMonths", "months", { min: 1 }),
    ],
    summary: (v, locale) => {
      const n = nums(v, { streamer: "streamer", viewer: "viewer", worker: "worker", term: "termMonths" });
      return n
        ? t("d6Governance.summary.boardSeats", {
            streamer: n.streamer,
            viewer: n.viewer,
            worker: n.worker,
            term: unitText(n.term, "month", locale),
          })
        : null;
    },
  },
  "council.config": {
    theme: "governance",
    title: "d6Governance.setting.councilConfig",
    fields: [
      field("size", "d6Governance.field.councilSize", "integer", { min: 1, max: 100 }),
      field("minStreamingHours", "d6Governance.field.councilHours", "hours", count),
      field("eligibilityWindowDays", "d6Governance.field.councilWindow", "days", { min: 1, max: 3660 }),
      field("recomputeCron", "d6Governance.field.recompute", "cron"),
    ],
    summary: (v, locale) => {
      const n = nums(v, { size: "size", hours: "minStreamingHours", days: "eligibilityWindowDays" });
      return n
        ? t("d6Governance.summary.councilConfig", {
            size: n.size,
            hours: unitText(n.hours, "hour", locale),
            days: unitText(n.days, "day", locale),
          })
        : null;
    },
  },
  "discovery.ranking": {
    theme: "discovery",
    title: "d6Governance.setting.discoveryRanking",
    fields: [
      field("spotlightSlots", "d6Governance.field.spotlightSlots", "integer", count),
      field("spotlightMaxViewers", "d6Governance.field.spotlightMaxViewers", "integer", count),
      field("spotlightRotationMinutes", "d6Governance.field.spotlightRotation", "minutes", count),
      field("newChannelMaxAgeDays", "d6Governance.field.newChannelAge", "days", count),
      field("weights.viewers", "d6Governance.field.weightViewers", "percent", share),
      field("weights.freshness", "d6Governance.field.weightFreshness", "percent", share),
      field("weights.followMomentum", "d6Governance.field.weightFollowMomentum", "percent", share),
      field("weights.smallChannelBoost", "d6Governance.field.weightSmallChannel", "percent", share),
    ],
    summary: (v, locale) => {
      const n = nums(v, { slots: "spotlightSlots", max: "spotlightMaxViewers", minutes: "spotlightRotationMinutes" });
      return n
        ? t("d6Governance.summary.discoveryRanking", {
            slots: n.slots,
            max: formatNumber(n.max, locale),
            minutes: unitText(n.minutes, "minute", locale),
          })
        : null;
    },
  },
  "integrity.thresholds": {
    theme: "safety",
    title: "d6Governance.setting.integrityThresholds",
    fields: [
      field("sessionExcludeScore", "d6Governance.field.sessionExcludeScore", "score", share),
      field("followBurstPerMinute", "d6Governance.field.followBurst", "integer", count),
      field("relayOverReportTolerance", "d6Governance.field.relayTolerance", "percent", share),
      field("maxSessionsPerDevice", "d6Governance.field.maxSessions", "integer", count),
      field("gateUnlocksPerAddress", "d6Governance.field.gateUnlocks", "integer", count),
      field("gateFallbackAccountAgeDays", "d6Governance.field.gateAccountAge", "days", count),
    ],
    summary: (v, locale) => {
      const n = nums(v, { score: "sessionExcludeScore", sessions: "maxSessionsPerDevice" });
      return n
        ? t("d6Governance.summary.integrityThresholds", { score: formatNumber(n.score, locale), sessions: n.sessions })
        : null;
    },
  },
  "moderation.thresholds": {
    theme: "safety",
    title: "d6Governance.setting.moderationThresholds",
    fields: [
      field("t1.sexual", "d6Governance.field.t1Sexual", "score", share),
      field("t1.graphic_violence", "d6Governance.field.t1Violence", "score", share),
      field("t1.weapons", "d6Governance.field.t1Weapons", "score", share),
      field("t1.self_harm", "d6Governance.field.t1SelfHarm", "score", share),
      field("t2.sexual", "d6Governance.field.t2Sexual", "score", share),
      field("sampleSeconds", "d6Governance.field.sampleSeconds", "seconds", { min: 1 }),
    ],
    summary: (v, locale) => {
      const n = nums(v, { sample: "sampleSeconds", t2: "t2.sexual" });
      return n
        ? t("d6Governance.summary.moderationThresholds", {
            sample: durationText(n.sample, locale),
            t2: formatNumber(n.t2, locale),
          })
        : null;
    },
  },
  "jury.enabled": {
    theme: "safety",
    title: "d6Governance.setting.juryEnabled",
    fields: [field("enabled", "d6Governance.field.enabled", "boolean")],
    summary: (v) => {
      const on = readPath(v, ["enabled"]);
      if (typeof on !== "boolean") return null;
      return on ? t("d6Governance.summary.juryOn") : t("d6Governance.summary.juryOff");
    },
  },
  "jury.panelSize": {
    theme: "safety",
    title: "d6Governance.setting.juryPanelSize",
    fields: [field("panelSize", "d6Governance.field.panelSize", "integer", { min: 1 })],
    summary: (v) => {
      const n = nums(v, { size: "panelSize" });
      return n ? t("d6Governance.summary.juryPanelSize", { count: n.size }) : null;
    },
  },
  "jury.casesPerPanel": {
    theme: "safety",
    title: "d6Governance.setting.juryCasesPerPanel",
    fields: [field("casesPerPanel", "d6Governance.field.casesPerPanel", "integer", { min: 1 })],
    summary: (v) => {
      const n = nums(v, { cases: "casesPerPanel" });
      return n ? t("d6Governance.summary.juryCasesPerPanel", { count: n.cases }) : null;
    },
  },
  "interact.points.accrual": {
    theme: "features",
    title: "d6Governance.setting.pointsAccrual",
    fields: [
      field("pointsPerBlock", "d6Governance.field.pointsPerBlock", "integer", count),
      field("blockMinutes", "d6Governance.field.blockMinutes", "minutes", { min: 1 }),
      field("dailyCapPerChannel", "d6Governance.field.dailyCap", "integer", count),
    ],
    summary: (v, locale) => {
      const n = nums(v, { points: "pointsPerBlock", minutes: "blockMinutes", cap: "dailyCapPerChannel" });
      return n
        ? t("d6Governance.summary.pointsAccrual", {
            points: n.points,
            minutes: unitText(n.minutes, "minute", locale),
            cap: formatNumber(n.cap, locale),
          })
        : null;
    },
  },
  "notifications.goLive": {
    theme: "features",
    title: "d6Governance.setting.goLive",
    fields: [
      field("cooldownHours", "d6Governance.field.cooldownHours", "hours", count),
      field("emailDigestMinutes", "d6Governance.field.emailDigestMinutes", "minutes", count),
    ],
    summary: (v, locale) => {
      const n = nums(v, { hours: "cooldownHours", minutes: "emailDigestMinutes" });
      return n
        ? t("d6Governance.summary.goLive", {
            hours: unitText(n.hours, "hour", locale),
            minutes: unitText(n.minutes, "minute", locale),
          })
        : null;
    },
  },
  "captions.defaultEnabled": {
    theme: "features",
    title: "d6Governance.setting.captionsDefault",
    fields: [field("enabled", "d6Governance.field.enabled", "boolean")],
    summary: (v) => {
      const on = readPath(v, ["enabled"]);
      if (typeof on !== "boolean") return null;
      return on ? t("d6Governance.summary.captionsOn") : t("d6Governance.summary.captionsOff");
    },
  },
};

/** Every key this module formats in words (the seeded settings). */
export const KNOWN_SETTING_KEYS: readonly string[] = Object.keys(SPECS);

export const isKnownSetting = (key: string): boolean => key in SPECS;

/** The fields of a known key ([] for unknown keys). */
export const settingFieldSpecs = (key: string): readonly FieldSpec[] => SPECS[key]?.fields ?? [];

export const settingTheme = (key: string): SettingTheme => SPECS[key]?.theme ?? "other";

/** "Creator share of revenue" for `platform.cut`; an unknown key reads as itself. */
export function settingTitle(key: string): string {
  const spec = SPECS[key];
  return spec ? t(spec.title) : key;
}

export interface FieldText {
  id: string;
  label: string;
  text: string;
}

/** The known fields present in the value, in words; for unknown keys every flat leaf as stored. */
export function settingFields(key: string, value: unknown, locale: string): FieldText[] {
  const spec = SPECS[key];
  if (spec)
    return spec.fields.flatMap((f) => {
      const text = formatField(f, value, locale);
      return text === null ? [] : [{ id: f.id, label: t(f.label), text }];
    });
  if (!isRecord(value)) return [];
  return leafPaths(value).map((path) => {
    const id = path.join(".");
    return { id, label: id, text: genericValueText(readPath(value, path), locale) ?? t("d6Governance.fmt.custom") };
  });
}

/**
 * The one line a member reads: "Creators keep 90% · co-op 10%". Falls back to the known fields
 * joined, then to a flat value as stored, then to "Custom value".
 */
export function settingSummary(key: string, value: unknown, locale: string): string {
  const spec = SPECS[key];
  const line = spec?.summary?.(value, locale);
  if (line) return line;
  if (spec) {
    const fields = settingFields(key, value, locale);
    if (fields.length > 0)
      return fields
        .map((f) => t("d6Governance.fmt.fieldValue", { label: f.label, value: f.text }))
        .join(t("d6Governance.fmt.separator"));
  }
  const flat = genericValueText(value, locale);
  if (flat !== null) return flat;
  if (isRecord(value)) {
    const leaves = leafPaths(value);
    const texts = leaves.map((path) => genericValueText(readPath(value, path), locale));
    if (leaves.length > 0 && leaves.length <= 8 && texts.every((x) => x !== null))
      return leaves
        .map((path, i) => t("d6Governance.fmt.fieldValue", { label: path.join("."), value: texts[i] ?? "" }))
        .join(t("d6Governance.fmt.separator"));
  }
  return t("d6Governance.fmt.custom");
}

// ── Before → after ────────────────────────────────────────────────────────────────────────────

export interface FieldDiff {
  id: string;
  label: string;
  /** null when the field is not in that value. */
  from: string | null;
  to: string | null;
  changed: boolean;
}

export interface SettingDiff {
  key: string;
  title: string;
  fromSummary: string;
  toSummary: string;
  /** Changed fields first-class; unchanged known fields are left out. */
  fields: FieldDiff[];
  /** Something changed that no known field covers (technical details only). */
  otherChanged: boolean;
  changed: boolean;
}

/** "90% → 85%": what a change does to one setting, field by field. */
export function settingDiff(key: string, from: unknown, to: unknown, locale: string): SettingDiff {
  const spec = SPECS[key];
  const changed = !sameValue(from, to);
  const base = {
    key,
    title: settingTitle(key),
    fromSummary: settingSummary(key, from, locale),
    toSummary: settingSummary(key, to, locale),
    changed,
  };
  if (spec) {
    const fields = spec.fields
      .map((f) => ({
        id: f.id,
        label: t(f.label),
        from: formatField(f, from, locale),
        to: formatField(f, to, locale),
        changed: !sameValue(readPath(from, f.path), readPath(to, f.path)),
      }))
      .filter((d) => d.changed);
    const known = new Set(spec.fields.map((f) => f.id));
    const leaves = [...leafPaths(from), ...leafPaths(to)].filter((p) => p.length > 0 && !known.has(p.join(".")));
    const otherChanged =
      (!isRecord(from) || !isRecord(to)) && changed
        ? fields.length === 0
        : leaves.some((p) => !sameValue(readPath(from, p), readPath(to, p)));
    return { ...base, fields, otherChanged };
  }
  if (!isRecord(from) && !isRecord(to)) {
    const a = genericValueText(from, locale);
    const b = genericValueText(to, locale);
    return {
      ...base,
      fields: changed && a !== null && b !== null ? [{ id: "", label: key, from: a, to: b, changed }] : [],
      otherChanged: changed && (a === null || b === null),
    };
  }
  const paths = new Map<string, Path>();
  for (const p of [...leafPaths(from), ...leafPaths(to)]) if (p.length > 0) paths.set(p.join("."), p);
  const fields: FieldDiff[] = [];
  let otherChanged = false;
  for (const [id, path] of paths) {
    const a = readPath(from, path);
    const b = readPath(to, path);
    if (sameValue(a, b)) continue;
    const at = a === undefined ? null : genericValueText(a, locale);
    const bt = b === undefined ? null : genericValueText(b, locale);
    if ((a !== undefined && at === null) || (b !== undefined && bt === null)) otherChanged = true;
    else fields.push({ id, label: id, from: at, to: bt, changed: true });
  }
  return { ...base, fields, otherChanged };
}

// ── Editing ───────────────────────────────────────────────────────────────────────────────────

/** A percent typed by a member (85 or 85.5) as the stored fraction (0.85, 0.855), at most 4 decimals. */
export const fractionFromPercent = (percent: number): number => Math.round(percent * 100) / 10_000;

/** The stored fraction as the percent a member edits (0.855 → 85.5). */
export const percentFromFraction = (fraction: number): number => Math.round(fraction * 10_000) / 100;

/** The complement of a share, rounded like a typed share (1 - 0.85 → 0.15, not 0.15000000000000002). */
export const complementShare = (fraction: number): number => Math.round((1 - fraction) * 10_000) / 10_000;

/**
 * `value` with `spec`'s field set to `next`, and every read-only complement of that field kept in
 * step (the co-op share follows the creator share).
 */
export function applyField(key: string, value: unknown, spec: FieldSpec, next: unknown): Record<string, unknown> {
  let out = writePath(value, spec.path, next);
  for (const other of settingFieldSpecs(key))
    if (other.complementOf && sameValue(other.complementOf, spec.path) && typeof next === "number")
      out = writePath(out, other.path, complementShare(next));
  return out;
}

export type FieldError = "required" | "notNumber" | "notWhole" | "tooLow" | "tooHigh";

/** Why a stored field value would be refused here, before the database decides. */
export function fieldError(spec: FieldSpec, raw: unknown): FieldError | null {
  if (spec.kind === "boolean") return typeof raw === "boolean" ? null : "required";
  if (spec.kind === "text" || spec.kind === "cron")
    return typeof raw === "string" && raw.trim() !== "" ? null : "required";
  if (spec.kind === "keys") return null;
  const n = num(raw);
  if (raw === undefined || raw === null) return "required";
  if (n === null) return "notNumber";
  const whole = ["money", "integer", "seconds", "days", "months"].includes(spec.kind);
  if (whole && !Number.isInteger(n)) return "notWhole";
  if (spec.min !== undefined && n < spec.min) return "tooLow";
  if (spec.max !== undefined && n > spec.max) return "tooHigh";
  return null;
}

/**
 * Whether the typed editor can own the value: a known key whose value is an object. Fields of
 * the wrong type still get their editor (and its error); only a value of another shape (a number,
 * a list, unparseable JSON) is left to the JSON editor.
 */
export function typedEditable(key: string, value: unknown): boolean {
  return key in SPECS && isRecord(value);
}

/** The bound a field error names, in the field's own unit for the message. */
export function fieldBoundText(spec: FieldSpec, which: "min" | "max", locale: string): string {
  const bound = which === "min" ? spec.min : spec.max;
  if (bound === undefined) return "";
  return formatField({ ...spec, path: ["v"] }, { v: bound }, locale) ?? String(bound);
}
