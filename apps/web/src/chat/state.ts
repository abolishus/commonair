// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rows of the chat list: messages (which moderation marks deleted instead of removing, so the
 * room sees that something was removed) and inline server notices. Pure, for unit tests.
 */
import type { ChatMessageFrame } from "./connection.ts";
import { MAX_MESSAGES } from "./connection.ts";

export type ChatRow =
  | { kind: "message"; id: string; message: ChatMessageFrame; deleted: boolean }
  | { kind: "notice"; id: string; code: string };

export type ChatAction =
  | { type: "message"; message: ChatMessageFrame }
  | { type: "delete"; messageId: string }
  | { type: "ban"; userId: string; username: string }
  | { type: "clear" }
  | { type: "notice"; id: string; code: string };

function cap(rows: ChatRow[]): ChatRow[] {
  return rows.length > MAX_MESSAGES ? rows.slice(rows.length - MAX_MESSAGES) : rows;
}

function markDeleted(rows: ChatRow[], hit: (m: ChatMessageFrame) => boolean): ChatRow[] {
  let changed = false;
  const next = rows.map((r) => {
    if (r.kind !== "message" || r.deleted || !hit(r.message)) return r;
    changed = true;
    return { ...r, deleted: true };
  });
  return changed ? next : rows;
}

export function chatReducer(rows: ChatRow[], action: ChatAction): ChatRow[] {
  switch (action.type) {
    case "message":
      if (rows.some((r) => r.kind === "message" && r.id === action.message.id)) return rows;
      return cap([...rows, { kind: "message", id: action.message.id, message: action.message, deleted: false }]);
    case "delete":
      return markDeleted(rows, (m) => m.id === action.messageId);
    case "ban":
      // Usernames are unique slugs; match either in case one side lags a rename.
      return markDeleted(rows, (m) => m.user.id === action.userId || m.user.username === action.username);
    case "clear":
      return markDeleted(rows, () => true);
    case "notice":
      return cap([...rows, { kind: "notice", id: action.id, code: action.code }]);
  }
}
