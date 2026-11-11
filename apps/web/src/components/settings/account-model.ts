// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `/settings/account` logic, pure for unit tests (D7.2). */

/** The display name limit `me.update` takes. */
export const DISPLAY_NAME_MAX = 40;

/**
 * The address partly hidden, so the page is safe on a shared screen: the first and last
 * character of the local part, the domain whole (`s•••••1@example.org`). One- and two-character
 * local parts keep only their first character.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const first = local.slice(0, 1);
  const hidden = "•".repeat(Math.max(3, Math.min(local.length - 2, 8)));
  const last = local.length > 2 ? local.slice(-1) : "";
  return `${first}${hidden}${last}@${domain}`;
}

export type DisplayNameProblem = "empty" | "tooLong";

/** What is wrong with a display name before it is sent, or null. */
export function displayNameProblem(value: string): DisplayNameProblem | null {
  const name = value.trim();
  if (name === "") return "empty";
  // The contract counts UTF-16 units (zod `max`), so this does too.
  if (name.length > DISPLAY_NAME_MAX) return "tooLong";
  return null;
}
