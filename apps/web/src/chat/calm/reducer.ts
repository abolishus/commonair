// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat's wave view (feature-wins §4.2): a pure function of the raw chat log, which it reads
 * and never changes, so turning Calm Chat off shows every line again. Messages with the same wave
 * key (`normalize.ts`) collapse into one wave row while each arrives within `WAVE_WINDOW_MS` of the
 * wave's previous message; the row sits where its latest message is. A wave never takes in a held
 * message, a mention of the viewer, the viewer's own message, or one from the broadcaster or a
 * moderator: those always stand alone. Deleted (and banned) messages leave their wave, so its
 * count drops; Calm Chat shows no "message deleted" lines. Blocked users' messages are gone
 * before any of this (`withoutBlocked`).
 */
import type { ChatMessageFrame } from "../connection.ts";
import type { ChatRow } from "../state.ts";
import { mentions, waveKey } from "./normalize.ts";

export const WAVE_WINDOW_MS = 5_000;

export interface CalmContext {
  /** The viewer's username (any case); null signed out. */
  self: string | null;
  /** Ids of messages a presentation queue or filter still holds. */
  held?: ReadonlySet<string>;
  windowMs?: number;
}

export interface Wave {
  /** The first message's id: the row keeps it while the wave grows. */
  id: string;
  key: string;
  /** Oldest first. */
  messages: ChatMessageFrame[];
  count: number;
  /** Distinct senders. */
  senders: number;
  first: ChatMessageFrame;
  latest: ChatMessageFrame;
}

export type CalmRow = { kind: "row"; row: ChatRow } | { kind: "wave"; wave: Wave; expanded: boolean };

const STAFF = new Set(["broadcaster", "moderator"]);

/** The viewer's own message. */
export function isOwn(m: ChatMessageFrame, self: string | null): boolean {
  return self !== null && m.user.username.toLowerCase() === self.toLowerCase();
}

/** A message that is about the viewer: an @mention or a reply to one of theirs. */
export function isForMe(m: ChatMessageFrame, self: string | null): boolean {
  if (self === null) return false;
  return mentions(m.body, self) || m.replyTo?.username.toLowerCase() === self.toLowerCase();
}

export function fromStaff(m: ChatMessageFrame): boolean {
  return m.user.badges.some((b) => STAFF.has(b.type));
}

/** Messages that never join a wave and are never hidden by the governor's grouping. */
export function standsAlone(m: ChatMessageFrame, ctx: CalmContext): boolean {
  return ctx.held?.has(m.id) === true || isForMe(m, ctx.self) || isOwn(m, ctx.self) || fromStaff(m);
}

/** The log without blocked users' messages (both modes): they are not rendered at all. */
export function withoutBlocked(rows: readonly ChatRow[], blocked: ReadonlySet<string>): ChatRow[] {
  if (blocked.size === 0) return rows as ChatRow[];
  return rows.filter((r) => r.kind !== "message" || !blocked.has(r.message.user.id));
}

const timeOf = (m: ChatMessageFrame) => Date.parse(m.createdAt);

/**
 * Assigns every live (not deleted) message that may join a wave to a group; a group with two or
 * more messages is a wave. Returns each grouped message's group.
 */
export function groupMessages(rows: readonly ChatRow[], ctx: CalmContext): Map<string, Wave> {
  const windowMs = ctx.windowMs ?? WAVE_WINDOW_MS;
  const open = new Map<string, Wave>();
  const byMessage = new Map<string, Wave>();
  const senders = new Map<Wave, Set<string>>();
  for (const r of rows) {
    if (r.kind !== "message" || r.deleted || standsAlone(r.message, ctx)) continue;
    const m = r.message;
    const key = waveKey(m);
    const current = open.get(key);
    let wave: Wave;
    if (current && timeOf(m) - timeOf(current.latest) <= windowMs) {
      wave = current;
      wave.messages.push(m);
      wave.latest = m;
    } else {
      wave = { id: m.id, key, messages: [m], count: 0, senders: 0, first: m, latest: m };
      open.set(key, wave);
      senders.set(wave, new Set());
    }
    senders.get(wave)?.add(m.user.id);
    wave.count = wave.messages.length;
    wave.senders = senders.get(wave)?.size ?? 0;
    byMessage.set(m.id, wave);
  }
  return byMessage;
}

export interface CalmViewOptions extends CalmContext {
  /** Waves the viewer expanded, by wave id. */
  expanded?: ReadonlySet<string>;
  /**
   * Message ids the rate governor let through. A lone message shows only when admitted; a wave
   * shows when any of its messages was. Omitted: everything shows.
   */
  admitted?: ReadonlySet<string>;
}

/** The rows Calm Chat renders, in log order. */
export function calmRows(rows: readonly ChatRow[], opts: CalmViewOptions): CalmRow[] {
  const groups = groupMessages(rows, opts);
  const shown = (id: string) => opts.admitted === undefined || opts.admitted.has(id);
  const out: CalmRow[] = [];
  for (const r of rows) {
    if (r.kind !== "message") {
      out.push({ kind: "row", row: r });
      continue;
    }
    if (r.deleted) continue;
    const wave = groups.get(r.id);
    if (!wave || wave.count < 2) {
      if (shown(r.id)) out.push({ kind: "row", row: r });
      continue;
    }
    // A wave renders once, at its latest message.
    if (wave.latest.id !== r.id || !wave.messages.some((m) => shown(m.id))) continue;
    out.push({ kind: "wave", wave, expanded: opts.expanded?.has(wave.id) === true });
  }
  return out;
}

/**
 * True when `messageId` joins a wave another of whose messages is shown (or about to be): it adds
 * no row, only to the count. `groups` is `groupMessages` of the current log.
 */
export function joinsShownWave(
  groups: ReadonlyMap<string, Wave>,
  messageId: string,
  shown: (id: string) => boolean,
): boolean {
  const wave = groups.get(messageId);
  return wave !== undefined && wave.messages.some((m) => m.id !== messageId && shown(m.id));
}

/**
 * A "Report wave" (`message_set`): the subject is the wave's first message and the set is its
 * messages newest first, at most `max`, always including the subject (the contract requires it).
 */
export function waveReport(wave: Wave, max: number): { subjectId: string; messageIds: string[] } {
  const newest = wave.messages
    .slice()
    .reverse()
    .map((m) => m.id);
  const ids = newest.slice(0, max);
  if (!ids.includes(wave.first.id)) ids.splice(max - 1, 1, wave.first.id);
  return { subjectId: wave.first.id, messageIds: ids };
}
