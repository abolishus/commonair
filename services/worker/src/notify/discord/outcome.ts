// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What a Discord answer means for the stored webhook (ADR 0028 decision 5). Pure. */
import type { PostResult } from "../../webhooks/http.ts";

/**
 * - `posted`: 2xx.
 * - `rate_limited`: 429; retry after `retryAfterMs` (null: Discord did not say).
 * - `gone`: 401/404, the webhook was deleted or its token is wrong; counted toward removal.
 * - `rejected`: any other 3xx/4xx; not retried.
 * - `network`: 5xx, a timeout, a dropped connection or a lookup that may work next time; retried.
 * - `blocked`: the SSRF guard refused the URL; it can never work.
 */
export type DiscordOutcome =
  | { kind: "posted" }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "gone"; error: "unauthorized" | "not_found" }
  | { kind: "rejected" }
  | { kind: "network" }
  | { kind: "blocked" };

/** A wait longer than this is treated as this long (a misbehaving header must not park a job for days). */
export const MAX_RETRY_AFTER_MS = 3_600_000;

// resolveCallback's own words for a lookup that may work next time; every other rejection is final.
// postPinned passes CallbackRejected's message, which prefixes the reason with "callback rejected: ".
const TRANSIENT_REJECTIONS = new Set(["host does not resolve", "callback resolution failed"]);
const rejectionReason = (error: string): string => error.replace(/^callback rejected: /, "");

export function classifyDiscordResult(result: PostResult): DiscordOutcome {
  if (!result.ok)
    return result.rejected && !TRANSIENT_REJECTIONS.has(rejectionReason(result.error))
      ? { kind: "blocked" }
      : { kind: "network" };
  const s = result.status;
  if (s >= 200 && s < 300) return { kind: "posted" };
  if (s === 429) return { kind: "rate_limited", retryAfterMs: retryAfterMs(result.body, result.headers) };
  if (s === 401) return { kind: "gone", error: "unauthorized" };
  if (s === 404) return { kind: "gone", error: "not_found" };
  if (s >= 500) return { kind: "network" };
  return { kind: "rejected" };
}

const toMs = (seconds: number): number | null =>
  Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS) : null;

/**
 * Discord's wait: the JSON body's `retry_after` (seconds, fractional) first, then the
 * `retry-after` header (seconds, or an HTTP date relative to `nowMs`). Null when neither parses.
 */
export function retryAfterMs(body: string, headers: Record<string, string>, nowMs: number = Date.now()): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "retry_after" in parsed) {
      const v = (parsed as { retry_after: unknown }).retry_after;
      const ms = typeof v === "number" ? toMs(v) : typeof v === "string" && v.trim() !== "" ? toMs(Number(v)) : null;
      if (ms !== null) return ms;
    }
  } catch {
    // Not JSON (a proxy's HTML page, a truncated body): fall back to the header.
  }
  const header = headers["retry-after"]?.trim();
  if (!header) return null;
  if (/^\d+(?:\.\d+)?$/.test(header)) return toMs(Number(header));
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : toMs(Math.max(0, at - nowMs) / 1000);
}
