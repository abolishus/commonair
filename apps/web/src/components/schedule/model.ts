// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel schedule on the web (overhaul wave 5): the calendar links, the studio editor's draft
 * (to and from `channels.schedule.*`), its checks, and the viewer-local labels the channel page
 * shows. Pure, unit-tested.
 *
 * Weekly slots are in the schedule's own time zone (the server expands them); one-off dates are
 * typed in the browser's own time zone (`<input type="datetime-local">`), so no zone arithmetic
 * runs here.
 */
import { SCHEDULE_FEED_PATH, SCHEDULE_RULES } from "@commonair/contracts/enums";
import type * as D from "@commonair/contracts/dto";
import type { z } from "zod";
import type { MessageKey } from "../../i18n/index.ts";

export type ChannelSchedule = z.infer<typeof D.ChannelSchedule>;
export type ChannelScheduleInput = z.infer<typeof D.ChannelScheduleInput>;
export type ScheduleOccurrence = ChannelSchedule["upcoming"][number];

// ── Calendar links ─────────────────────────────────────────────────────────────────────────────

/** The first-party feed (`ChannelSchedule.feedPath`); the channel page knows it without a request. */
export const scheduleFeedPath = SCHEDULE_FEED_PATH;
/** "Add to calendar": the next stream alone, as a download. */
export const nextStreamIcsPath = (slug: string) => `${scheduleFeedPath(slug)}?next=1`;

/** "Subscribe in calendar": the feed on the `webcal:` scheme, which calendar apps subscribe to. */
export function webcalUrl(publicUrl: string, slug: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base.replace(/^https?:/, "webcal:")}${scheduleFeedPath(slug)}`;
}

// ── Time zones ─────────────────────────────────────────────────────────────────────────────────

/** The zones the picker offers (the saved and the browser's zone are added when missing). */
export const TIME_ZONES: readonly string[] = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Vancouver",
  "America/Phoenix",
  "America/Denver",
  "America/Edmonton",
  "America/Chicago",
  "America/Mexico_City",
  "America/Winnipeg",
  "America/Regina",
  "America/New_York",
  "America/Toronto",
  "America/Bogota",
  "America/Lima",
  "America/Halifax",
  "America/Santiago",
  "America/St_Johns",
  "America/Argentina/Buenos_Aires",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Africa/Lagos",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Africa/Johannesburg",
  "Africa/Cairo",
  "Europe/Athens",
  "Europe/Helsinki",
  "Europe/Kyiv",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Nairobi",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Manila",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Australia/Perth",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Adelaide",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
];

/** The picker's options: the list plus `extra` zones it lacks, each once, list order first. */
export function timeZoneOptions(...extra: (string | null | undefined)[]): string[] {
  const out = [...TIME_ZONES];
  for (const z of extra) if (z && !out.includes(z)) out.push(z);
  return out;
}

/** "America/Argentina/Buenos_Aires" → "America / Argentina / Buenos Aires". */
export const timeZoneLabel = (zone: string) => zone.replace(/_/g, " ").replace(/\//g, " / ");

interface TemporalLike {
  Temporal?: { Now?: { timeZoneId?: () => string } };
}

/**
 * The browser's IANA zone where the runtime says it (Temporal), else a guess from the clock's
 * winter and summer offsets among common zones, else UTC. The creator can always pick another.
 */
export function browserTimeZone(
  env: { now?: Date; temporal?: TemporalLike["Temporal"] } = { temporal: (globalThis as TemporalLike).Temporal },
): string {
  try {
    const id = env.temporal?.Now?.timeZoneId?.();
    if (id) return id;
  } catch {
    // Fall through to the guess.
  }
  const year = (env.now ?? new Date()).getFullYear();
  // getTimezoneOffset is minutes behind UTC (Toronto in winter: 300).
  const jan = -new Date(year, 0, 15).getTimezoneOffset();
  const jul = -new Date(year, 6, 15).getTimezoneOffset();
  return OFFSET_GUESSES[`${jan}|${jul}`] ?? "UTC";
}

/** Winter|summer offsets (minutes east of UTC) to the most likely zone. */
const OFFSET_GUESSES: Readonly<Record<string, string>> = {
  "-600|-600": "Pacific/Honolulu",
  "-540|-480": "America/Anchorage",
  "-480|-420": "America/Los_Angeles",
  "-420|-420": "America/Phoenix",
  "-420|-360": "America/Denver",
  "-360|-300": "America/Chicago",
  "-360|-360": "America/Mexico_City",
  "-300|-240": "America/Toronto",
  "-300|-300": "America/Bogota",
  "-240|-180": "America/Halifax",
  "-180|-240": "America/Santiago",
  "-210|-150": "America/St_Johns",
  "-180|-180": "America/Sao_Paulo",
  "0|0": "UTC",
  "0|60": "Europe/London",
  "60|60": "Africa/Lagos",
  "60|120": "Europe/Paris",
  "120|120": "Africa/Johannesburg",
  "120|180": "Europe/Helsinki",
  "180|180": "Europe/Istanbul",
  "240|240": "Asia/Dubai",
  "300|300": "Asia/Karachi",
  "330|330": "Asia/Kolkata",
  "360|360": "Asia/Dhaka",
  "420|420": "Asia/Bangkok",
  "480|480": "Asia/Singapore",
  "540|540": "Asia/Tokyo",
  "570|630": "Australia/Adelaide",
  "600|600": "Australia/Brisbane",
  "660|600": "Australia/Sydney",
  "780|720": "Pacific/Auckland",
};

// ── Durations ──────────────────────────────────────────────────────────────────────────────────

/** The lengths the picker offers, in minutes (the saved one is added when missing). */
export const DURATIONS: readonly number[] = [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];

export function durationOptions(current?: number): number[] {
  const out = new Set(DURATIONS);
  if (
    current !== undefined &&
    Number.isInteger(current) &&
    current >= SCHEDULE_RULES.minDurationMinutes &&
    current <= SCHEDULE_RULES.maxDurationMinutes
  )
    out.add(current);
  return [...out].sort((a, b) => a - b);
}

// ── Local times ────────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** "19:30" of a Date in the browser's zone (24-hour, as the schedule is written). */
export const localHhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** ISO weekday (1 = Monday) of a Date in the browser's zone. */
export const localIsoWeekday = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());

/** The `datetime-local` value of an instant, in the browser's zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${localHhmm(d)}`;
}

/** The instant of a `datetime-local` value read in the browser's zone, or null. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const WEEKDAY_KEYS: readonly MessageKey[] = [
  "w5Schedule.weekday.1",
  "w5Schedule.weekday.2",
  "w5Schedule.weekday.3",
  "w5Schedule.weekday.4",
  "w5Schedule.weekday.5",
  "w5Schedule.weekday.6",
  "w5Schedule.weekday.7",
];

/** The weekday's name key, ISO numbering (1 = Monday); out of range reads as Monday. */
export const weekdayKey = (weekday: number): MessageKey => WEEKDAY_KEYS[weekday - 1] ?? "w5Schedule.weekday.1";

// ── The editor's draft ─────────────────────────────────────────────────────────────────────────

export interface SlotDraft {
  /** Stable React key and error key. */
  key: string;
  weekday: number;
  startLocal: string;
  durationMinutes: number;
  title: string;
  categoryId: string | null;
  /** As saved, so skips stay valid only while the slot keeps its day, time and zone. */
  saved: { id: string; weekday: number; startLocal: string } | null;
}

export interface OneOffDraft {
  key: string;
  /** `datetime-local`, browser zone. */
  startsAtLocal: string;
  durationMinutes: number;
  title: string;
  categoryId: string | null;
  /**
   * As saved. A saved one-off that has started but not ended is still listed; it keeps its
   * start unless the creator moves it, so it never blocks saving the rest of the schedule.
   */
  saved: { startsAt: string; startsAtLocal: string } | null;
}

/** A skipped occurrence of a saved slot (`ScheduleOneOff.cancelsSlotId`). */
export interface SkipDraft {
  slotId: string;
  startsAt: string;
  durationMinutes: number;
}

export interface ScheduleDraft {
  timezone: string;
  /** The saved zone: a changed zone moves every occurrence, so the skips go. */
  savedTimezone: string | null;
  slots: SlotDraft[];
  oneOffs: OneOffDraft[];
  skips: SkipDraft[];
}

let keySeq = 0;
export const draftKey = (prefix: string) => `${prefix}${++keySeq}`;

export function draftFromSchedule(s: ChannelSchedule | null, fallbackZone: string): ScheduleDraft {
  if (!s) return { timezone: fallbackZone, savedTimezone: null, slots: [], oneOffs: [], skips: [] };
  // A channel without a schedule reads as UTC: start it in the creator's own zone instead.
  const empty = s.slots.length === 0 && s.oneOffs.length === 0;
  return {
    timezone: empty && s.timezone === "UTC" ? fallbackZone : s.timezone,
    savedTimezone: s.timezone,
    slots: s.slots.map((slot) => ({
      key: draftKey("slot"),
      weekday: slot.weekday,
      startLocal: slot.startLocal,
      durationMinutes: slot.durationMinutes,
      title: slot.title ?? "",
      categoryId: slot.category?.id ?? null,
      saved: { id: slot.id, weekday: slot.weekday, startLocal: slot.startLocal },
    })),
    oneOffs: s.oneOffs
      .filter((o) => o.cancelsSlotId === null)
      .map((o) => ({
        key: draftKey("oneoff"),
        startsAtLocal: toLocalInput(o.startsAt),
        durationMinutes: o.durationMinutes,
        title: o.title ?? "",
        categoryId: o.category?.id ?? null,
        saved: { startsAt: o.startsAt, startsAtLocal: toLocalInput(o.startsAt) },
      })),
    skips: s.oneOffs.flatMap((o) =>
      o.cancelsSlotId === null
        ? []
        : [{ slotId: o.cancelsSlotId, startsAt: o.startsAt, durationMinutes: o.durationMinutes }],
    ),
  };
}

export const newSlot = (weekday = 5): SlotDraft => ({
  key: draftKey("slot"),
  weekday,
  startLocal: "19:00",
  durationMinutes: 120,
  title: "",
  categoryId: null,
  saved: null,
});

export const newOneOff = (now: Date): OneOffDraft => {
  // Tomorrow at 19:00, browser time.
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 19, 0);
  return {
    key: draftKey("oneoff"),
    startsAtLocal: toLocalInput(d.toISOString()),
    durationMinutes: 120,
    title: "",
    categoryId: null,
    saved: null,
  };
};

/** The saved start while the one-off has not been moved (an in-progress one may stay), else null. */
const unmovedStart = (o: OneOffDraft): string | null =>
  o.saved !== null && o.saved.startsAtLocal === o.startsAtLocal ? o.saved.startsAt : null;

/** The skips that still name an occurrence: the slot is unchanged and the zone too. */
export function liveSkips(d: ScheduleDraft): { skip: SkipDraft; slotIndex: number }[] {
  if (d.savedTimezone !== d.timezone) return [];
  return d.skips.flatMap((skip) => {
    const slotIndex = d.slots.findIndex(
      (s) => s.saved?.id === skip.slotId && s.saved.weekday === s.weekday && s.saved.startLocal === s.startLocal,
    );
    return slotIndex < 0 ? [] : [{ skip, slotIndex }];
  });
}

/** Room left for one-offs: skips share the `maxOneOffs` limit with them. */
export const oneOffRoom = (d: ScheduleDraft) => SCHEDULE_RULES.maxOneOffs - d.oneOffs.length - liveSkips(d).length;

export type DraftErrors = Record<string, MessageKey>;

/** Field errors keyed `<draft key>.<field>` (and `timezone`); empty when the draft can be saved. */
export function draftErrors(d: ScheduleDraft, now: Date, zones: readonly string[]): DraftErrors {
  const errors: DraftErrors = {};
  if (!zones.includes(d.timezone)) errors.timezone = "w5Schedule.error.timezone";
  for (const s of d.slots) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.startLocal)) errors[`${s.key}.start`] = "w5Schedule.error.start";
    if (s.title.trim().length > SCHEDULE_RULES.titleMax) errors[`${s.key}.title`] = "w5Schedule.error.title";
  }
  for (const o of d.oneOffs) {
    const at = fromLocalInput(o.startsAtLocal);
    if (at === null) errors[`${o.key}.startsAt`] = "w5Schedule.error.startsAt";
    else if (unmovedStart(o) === null && Date.parse(at) <= now.getTime())
      errors[`${o.key}.startsAt`] = "w5Schedule.error.past";
    if (o.title.trim().length > SCHEDULE_RULES.titleMax) errors[`${o.key}.title`] = "w5Schedule.error.title";
  }
  return errors;
}

const titleOrNull = (title: string) => (title.trim() === "" ? null : title.trim());

/** The `channels.schedule.set` body; call only when `draftErrors` is empty. */
export function draftToInput(d: ScheduleDraft): ChannelScheduleInput {
  return {
    timezone: d.timezone,
    slots: d.slots.map((s) => ({
      weekday: s.weekday,
      startLocal: s.startLocal,
      durationMinutes: s.durationMinutes,
      title: titleOrNull(s.title),
      categoryId: s.categoryId,
    })),
    oneOffs: [
      ...d.oneOffs.map((o) => ({
        // Unmoved: the saved instant itself, not a minute-precision round trip.
        startsAt: unmovedStart(o) ?? fromLocalInput(o.startsAtLocal) ?? "",
        durationMinutes: o.durationMinutes,
        title: titleOrNull(o.title),
        categoryId: o.categoryId,
        cancelsSlot: null,
      })),
      ...liveSkips(d).map(({ skip, slotIndex }) => ({
        startsAt: skip.startsAt,
        durationMinutes: skip.durationMinutes,
        title: null,
        categoryId: null,
        cancelsSlot: slotIndex,
      })),
    ],
  };
}

/** Skip or un-skip one occurrence of a saved slot. */
export function toggleSkip(d: ScheduleDraft, slotId: string, startsAt: string, durationMinutes: number): ScheduleDraft {
  const has = d.skips.some((s) => s.slotId === slotId && s.startsAt === startsAt);
  return {
    ...d,
    skips: has
      ? d.skips.filter((s) => !(s.slotId === slotId && s.startsAt === startsAt))
      : [...d.skips, { slotId, startsAt, durationMinutes }],
  };
}

/** The saved upcoming list plus the skipped occurrences, soonest first, for the "Coming up" list. */
export function comingUp(
  saved: ChannelSchedule,
  d: ScheduleDraft,
  now: Date,
): { startsAt: string; endsAt: string; title: string | null; slotId: string | null; skipped: boolean }[] {
  const minute = 60_000;
  const rows = [
    ...saved.upcoming.map((o) => ({
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      title: o.title,
      slotId: o.slotId,
      skipped: d.skips.some((s) => s.slotId === o.slotId && s.startsAt === o.startsAt),
    })),
    // Saved skips are not in `upcoming`: list them so they can be undone.
    ...saved.oneOffs
      .filter((o) => o.cancelsSlotId !== null && Date.parse(o.startsAt) > now.getTime())
      .map((o) => ({
        startsAt: o.startsAt,
        endsAt: new Date(Date.parse(o.startsAt) + o.durationMinutes * minute).toISOString(),
        title: saved.slots.find((s) => s.id === o.cancelsSlotId)?.title ?? null,
        slotId: o.cancelsSlotId,
        skipped: d.skips.some((s) => s.slotId === o.cancelsSlotId && s.startsAt === o.startsAt),
      })),
  ];
  return rows.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** Whether the draft differs from what `saved` holds (the upcoming list then shows old data). */
export function draftChanged(saved: ChannelSchedule, d: ScheduleDraft): boolean {
  const fresh = draftFromSchedule(saved, d.timezone);
  // Keys and the saved snapshot are bookkeeping, not content.
  const strip = (x: ScheduleDraft) =>
    JSON.stringify({
      timezone: x.timezone,
      slots: x.slots.map((s) => [s.weekday, s.startLocal, s.durationMinutes, s.title, s.categoryId]),
      oneOffs: x.oneOffs.map((o) => [o.startsAtLocal, o.durationMinutes, o.title, o.categoryId]),
      skips: x.skips.map((s) => `${s.slotId}|${s.startsAt}`).sort(),
    });
  return strip(fresh) !== strip(d);
}

// ── The channel page ───────────────────────────────────────────────────────────────────────────

export interface WeeklyRow {
  slotId: string;
  /** Viewer-local ISO weekday and times of the slot's next occurrence. */
  weekday: number;
  start: string;
  end: string;
  title: string | null;
  category: { slug: string; name: string } | null;
}

/**
 * About's weekly list in the viewer's zone: each slot by its next occurrence (a slot whose
 * occurrences are all skipped in the horizon is left out), ordered Monday first, then by time.
 */
export function weeklyRows(s: ChannelSchedule): WeeklyRow[] {
  const rows: WeeklyRow[] = [];
  for (const slot of s.slots) {
    const next = s.upcoming.find((o) => o.slotId === slot.id);
    if (!next) continue;
    const start = new Date(next.startsAt);
    rows.push({
      slotId: slot.id,
      weekday: localIsoWeekday(start),
      start: localHhmm(start),
      end: localHhmm(new Date(next.endsAt)),
      title: slot.title,
      category: slot.category ? { slug: slot.category.slug, name: slot.category.name } : null,
    });
  }
  return rows.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
}

/** The upcoming one-offs (not the weekly streams), for "Also coming up". */
export const upcomingOneOffs = (s: ChannelSchedule) => s.upcoming.filter((o) => o.oneOffId !== null);
