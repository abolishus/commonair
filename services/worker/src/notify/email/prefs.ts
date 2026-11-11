// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A member's own default for one preference type and medium (overhaul wave 4, D7.3): their row,
 * else `NOTIFY_DEFAULTS`. Channel overrides exist for go-live only and are read by the go-live
 * digest itself. Shared by the payout, video-ready and weekly mail.
 */
import type { NotifyMedium, PreferenceType, UnsubscribeList } from "@commonair/contracts/enums";
import { EMAIL_UNSUBSCRIBE_PATH, NOTIFY_DEFAULTS } from "@commonair/contracts/notify";
import { schema, type Executor } from "@commonair/db";
import { signUnsubscribeToken } from "@commonair/tokens";
import { and, eq, isNull } from "drizzle-orm";

const np = schema.notificationPreferences;

export async function preferenceEnabled(
  db: Executor,
  userId: string,
  type: PreferenceType,
  medium: NotifyMedium,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: np.enabled })
    .from(np)
    .where(and(eq(np.userId, userId), eq(np.type, type), eq(np.medium, medium), isNull(np.channelId)))
    .limit(1);
  return row ? row.enabled : NOTIFY_DEFAULTS[type][medium];
}

/**
 * The RFC 8058 one-click URL for `list`. The worker's AUTH_SECRET reaches the context as the
 * webhook settings' secret (main.ts); the API verifies with its own, so the two must match.
 */
export async function unsubscribeUrl(
  publicUrl: string,
  authSecret: string,
  userId: string,
  list: UnsubscribeList,
): Promise<string> {
  const token = await signUnsubscribeToken(authSecret, userId, list);
  return `${publicUrl.replace(/\/+$/, "")}${EMAIL_UNSUBSCRIBE_PATH}?list=${list}&token=${encodeURIComponent(token)}`;
}
