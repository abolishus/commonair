// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E7-chat-http: the held-message queue (held.*). That unit owns this file. */
export const e7ChatMessages = {
  "held.open": "Held messages ({count})",
  "held.title": "Held messages",
  "held.description": "A word filter is holding these. Allowed messages appear in chat for everyone.",
  "held.empty": "No held messages",
  "held.emptyBody": "Messages your word filters hold for review show up here.",
  "held.loading": "Loading held messages",
  "held.loadFailed": "Could not load the held messages.",
  "held.allow": "Allow {name}'s message",
  "held.deny": "Deny {name}'s message",
  "held.failed": "Could not update that message. Try again.",
  "held.alreadyResolved": "Another moderator already handled that message.",
} as const;
