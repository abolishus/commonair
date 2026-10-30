// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rows of the chat list: messages (which moderation marks deleted instead of removing, so the
 * room sees that something was removed), inline server notices and platform events (subs, gift
 * subs, tips). Events carry a local id, never a message id: moderation, dedupe and the
 * message-only logic skip them; they share the log cap. Pure, for unit tests.
 */
import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import type { ChatMessageFrame, ChatSurge } from "./connection.ts";
import { MAX_MESSAGES } from "./connection.ts";
import type { ChatEventView } from "./events.ts";

export type ChatRow =
  | { kind: "message"; id: string; message: ChatMessageFrame; deleted: boolean }
  | { kind: "notice"; id: string; code: string }
  | { kind: "event"; id: string; event: ChatEventView };

export type ChatAction =
  | { type: "message"; message: ChatMessageFrame }
  | { type: "delete"; messageId: string }
  | { type: "ban"; userId: string; username: string }
  | { type: "clear" }
  | { type: "notice"; id: string; code: string }
  | { type: "event"; id: string; event: ChatEventView };

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
    case "event":
      return cap([...rows, { kind: "event", id: action.id, event: action.event }]);
  }
}

/** How many deleted ids `Tombstones` remembers (the presentation queue holds at most 60 s of chat). */
const MAX_TOMBSTONES = 2_000;

/**
 * Moderation that arrives while the presentation queue still holds a line (up to 60 s with chat
 * sync on): `chatReducer` only marks rows already in the log, so a held line would otherwise show
 * as a normal one after its delete, ban or clear. Each message is stamped on arrival (`arrive`);
 * `hides` drops it at show time when it was deleted, or when a ban of its author or a clear came
 * after it arrived (a timed-out user's later lines still show).
 */
export class Tombstones {
  private seq = 0;
  private clearedAt = 0;
  private readonly deleted = new Set<string>();
  private readonly bans = new Map<string, number>();

  /** Stamp a message as it arrives from the socket. */
  arrive(): number {
    return ++this.seq;
  }

  delete(messageId: string): void {
    this.deleted.add(messageId);
    if (this.deleted.size > MAX_TOMBSTONES) {
      const oldest = this.deleted.values().next();
      if (!oldest.done) this.deleted.delete(oldest.value);
    }
  }

  ban(userId: string, username: string): void {
    const at = ++this.seq;
    this.bans.set(`id:${userId}`, at);
    this.bans.set(`name:${username}`, at);
  }

  clear(): void {
    this.clearedAt = ++this.seq;
    // Everything that arrived before is covered by the clear.
    this.deleted.clear();
    this.bans.clear();
  }

  /** Whether a message stamped `arrivedAt` must not be shown. */
  hides(m: ChatMessageFrame, arrivedAt: number): boolean {
    if (arrivedAt <= this.clearedAt || this.deleted.has(m.id)) return true;
    const ban = Math.max(this.bans.get(`id:${m.user.id}`) ?? 0, this.bans.get(`name:${m.user.username}`) ?? 0);
    return ban > arrivedAt;
  }
}

/**
 * What the panel feeds `<SurgeBanner/>` (W1-watch-gate): the latest settings and surge state (the
 * `joined` frame carries both, so a viewer who joins mid-surge sees the hint at once) and whether a
 * send was refused by the verified-watch gate since the last (re)join.
 */
export interface GateState {
  settings: ChannelChatSettings | null;
  surge: ChatSurge | null;
  gateDenied: boolean;
}
export type GateAction =
  | { type: "reset" }
  | { type: "joined" }
  | { type: "denied" }
  | { type: "settings"; settings: ChannelChatSettings }
  | { type: "surge"; surge: ChatSurge };
export const EMPTY_GATE: GateState = { settings: null, surge: null, gateDenied: false };

export function gateReducer(state: GateState, action: GateAction): GateState {
  switch (action.type) {
    case "reset":
      return EMPTY_GATE;
    case "joined":
      return state.gateDenied ? { ...state, gateDenied: false } : state;
    case "denied":
      return state.gateDenied ? state : { ...state, gateDenied: true };
    case "settings":
      return { ...state, settings: action.settings };
    case "surge":
      return { ...state, surge: action.surge };
  }
}
