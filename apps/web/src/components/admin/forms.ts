// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers for the E7 admin pages: UTC `datetime-local` values, the egress range, form parsing. */

/** Mirrors the API's limit (`services/api/src/admin/egress.ts`). */
export const EGRESS_MAX_RANGE_MS = 31 * 86_400_000;
export const INCIDENT_TITLE_MAX = 140;
export const INCIDENT_BODY_MAX = 5000;
export const DECIDE_REASON_MAX = 1000;

const LOCAL_INPUT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(\.\d{1,3})?)?$/;

/** A `datetime-local` value showing `d` in UTC, to the minute. */
export function toUtcInput(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/** A `datetime-local` value read as UTC → ISO 8601, or null when it is not a valid value. */
export function fromUtcInput(value: string): string | null {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}${m[2] ?? ":00"}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The default report range: the last 24 hours, to the minute. */
export function defaultEgressInputs(now: Date): { from: string; to: string } {
  const to = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  return { from: toUtcInput(new Date(to.getTime() - 86_400_000)), to: toUtcInput(to) };
}

export type RangeCheck = { ok: true; from: string; to: string } | { ok: false; error: "invalid" | "order" | "tooLong" };

/** The same rules as the API: both valid, `from < to`, at most 31 days. */
export function checkEgressRange(fromInput: string, toInput: string): RangeCheck {
  const from = fromUtcInput(fromInput);
  const to = fromUtcInput(toInput);
  if (from === null || to === null) return { ok: false, error: "invalid" };
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) return { ok: false, error: "order" };
  if (span > EGRESS_MAX_RANGE_MS) return { ok: false, error: "tooLong" };
  return { ok: true, from, to };
}

/** One component id per line (commas also split), trimmed, blanks and repeats dropped. */
export function parseComponents(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
}

const SLUG = /^[a-z0-9_]{3,25}$/;
/** The channel filter: empty means none; anything that is not a slug is not sent. */
export function channelFilter(value: string): { ok: true; channel: string | undefined } | { ok: false } {
  const v = value.trim().toLowerCase();
  if (v === "") return { ok: true, channel: undefined };
  return SLUG.test(v) ? { ok: true, channel: v } : { ok: false };
}

/** Detail values as short text (numbers rounded, lists joined, nested objects as compact JSON). */
export function detailText(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ");
  return JSON.stringify(v);
}
