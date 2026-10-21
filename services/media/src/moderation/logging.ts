// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fixed error classes for logs; messages can contain object keys, URLs, or user data. */
export function errorCategory(err: unknown): "Error" | "TypeError" | "RangeError" | "SyntaxError" | "unknown" {
  if (!(err instanceof Error)) return "unknown";
  if (err.constructor === TypeError) return "TypeError";
  if (err.constructor === RangeError) return "RangeError";
  if (err.constructor === SyntaxError) return "SyntaxError";
  return "Error";
}
