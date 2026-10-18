// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Payload scalars compared with condition values, which are always strings on the wire. */
function asConditionValue(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Does an event payload satisfy a subscription condition? Every condition key must
 * equal the payload field of the same name. `user_id` follows Twitch semantics when
 * the payload has no such field (e.g. `channel.chat.message`): it names the user whose
 * authorization backs the subscription, so it must equal the subscription's user.
 * An empty condition matches every event of the type.
 */
export function matchesCondition(
  condition: Record<string, string>,
  payload: Record<string, unknown>,
  subscriptionUserId: string,
): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    if (Object.hasOwn(payload, key)) {
      if (asConditionValue(payload[key]) !== expected) return false;
    } else if (key === "user_id") {
      if (expected !== subscriptionUserId) return false;
    } else return false;
  }
  return true;
}
