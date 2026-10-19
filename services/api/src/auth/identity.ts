// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Signup identity rules: username (= channel slug) and the age gate. Pure, unit-tested. */
import { Slug } from "@commonair/contracts";
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";

/**
 * Names that would collide with routes, impersonate staff or confuse users.
 * Compared after lowercasing; prefixes in RESERVED_PREFIXES block whole families.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "api",
  "app",
  "auth",
  "about",
  "abuse",
  "billing",
  "blog",
  "bot",
  "categories",
  "category",
  "channel",
  "channels",
  "chat",
  "clips",
  "coop",
  "council",
  "dashboard",
  "developer",
  "developers",
  "directory",
  "dmca",
  "docs",
  "embed",
  "events",
  "eventsub",
  "everyone",
  "following",
  "help",
  "here",
  "internal",
  "legal",
  "live",
  "login",
  "logout",
  "mod",
  "moderator",
  "moderators",
  "null",
  "oauth",
  "oauth2",
  "official",
  "overlay",
  "overlays",
  "payments",
  "privacy",
  "relay",
  "relays",
  "root",
  "rpc",
  "search",
  "security",
  "settings",
  "signin",
  "signup",
  "staff",
  "status",
  "support",
  "system",
  "terms",
  "transparency",
  "treasurer",
  "undefined",
  "videos",
  "vods",
  "www",
]);
/**
 * `demo_` belongs to the demo seed (`packages/db` `demo:seed`, which writes rows directly): no
 * sign-up or bot may take it, so `demo:clear` can never match a real account by that anchor.
 */
const RESERVED_PREFIXES = ["admin_", "staff_", "mod_", "official_", "support_", DEMO_FIXTURES.usernamePrefix];

export type UsernameProblem = "format" | "reserved";

export function usernameProblem(raw: string): UsernameProblem | null {
  const name = raw.toLowerCase();
  if (!Slug.safeParse(name).success) return "format";
  if (RESERVED_USERNAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) return "reserved";
  return null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a calendar date (YYYY-MM-DD); null if malformed or not a real date. */
export function parseBirthDate(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== "string") return null;
  const match = ISO_DATE.exec(s);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900) return null;
  return { y, m, d };
}

/** Whole years of age on `now` (UTC calendar). Negative for future dates. */
export function ageOn(birth: { y: number; m: number; d: number }, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  let age = y - birth.y;
  if (m < birth.m || (m === birth.m && d < birth.d)) age--;
  return age;
}

export type AgeProblem = "missing" | "invalid" | "too_young";

export function ageProblem(birthDate: unknown, minAge: number, now: Date): AgeProblem | null {
  if (birthDate === undefined || birthDate === null || birthDate === "") return "missing";
  const b = parseBirthDate(birthDate);
  if (!b) return "invalid";
  const age = ageOn(b, now);
  if (age < 0 || age > 130) return "invalid";
  return age < minAge ? "too_young" : null;
}

export const isAdult = (birthDate: string | null, now: Date): boolean => {
  const b = parseBirthDate(birthDate);
  return b !== null && ageOn(b, now) >= 18;
};
