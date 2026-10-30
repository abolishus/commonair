// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notifications.*` (N1, ADR 0028), composed from one file per unit (contract step §5.1): the
 * unread count and preferences (N1-inbox), web push (N1-push), the email unsubscribe link
 * (N1-email), the Discord webhook (N1-discord). The list and mark-read stay in `me`.
 */
import { discord } from "./notifications/discord.ts";
import { unreadCount } from "./notifications/inbox.ts";
import { preferences } from "./notifications/preferences.ts";
import { push } from "./notifications/push.ts";
import { unsubscribe } from "./notifications/unsubscribe.ts";

export const notifications = { unreadCount, preferences, push, unsubscribe, discord };
