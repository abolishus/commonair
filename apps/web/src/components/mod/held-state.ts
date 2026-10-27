// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The moderator's held-message queue, merged from two sources by message id: `chat.held.list`
 * (loaded when the queue opens) and live `{op:"message", held:true}` frames. A message leaves the
 * queue when a moderator resolves it here (optimistically, put back if the call fails), when it
 * comes back as an ordinary message (someone allowed it) or when a `delete` frame drops it.
 * Ids resolved here stay suppressed so a list that was in flight cannot bring them back. Pure.
 */
import type { ChatMessageFrame } from "../../chat/connection.ts";

export interface HeldState {
  items: ChatMessageFrame[];
  /** Ids already resolved or removed: a later list or frame must not re-add them. */
  gone: ReadonlySet<string>;
}

export type HeldAction =
  | { type: "loaded"; messages: readonly ChatMessageFrame[] }
  | { type: "held"; message: ChatMessageFrame }
  | { type: "remove"; id: string }
  | { type: "restore"; message: ChatMessageFrame }
  /** Another channel (or a new connection): start over. */
  | { type: "reset" };

export const EMPTY_HELD: HeldState = { items: [], gone: new Set() };

const byTime = (a: ChatMessageFrame, b: ChatMessageFrame) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function merge(state: HeldState, add: readonly ChatMessageFrame[]): HeldState {
  const known = new Set(state.items.map((m) => m.id));
  const fresh = add.filter((m) => !known.has(m.id) && !state.gone.has(m.id));
  if (fresh.length === 0) return state;
  return { ...state, items: [...state.items, ...fresh].sort(byTime) };
}

export function heldReducer(state: HeldState, action: HeldAction): HeldState {
  switch (action.type) {
    case "loaded":
      return merge(state, action.messages);
    case "held":
      return merge(state, [action.message]);
    case "remove": {
      if (state.gone.has(action.id) && !state.items.some((m) => m.id === action.id)) return state;
      const gone = new Set(state.gone).add(action.id);
      return { items: state.items.filter((m) => m.id !== action.id), gone };
    }
    case "restore": {
      const gone = new Set(state.gone);
      gone.delete(action.message.id);
      return merge({ ...state, gone }, [action.message]);
    }
    case "reset":
      return state.items.length === 0 && state.gone.size === 0 ? state : EMPTY_HELD;
  }
}
