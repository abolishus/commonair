// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-memory index of the WebSocket subscriptions of the sessions this process holds, by
 * session and by `type@version`, and the Postgres loads that fill it. Rows are the truth; the index
 * is reloaded per session on `subscriptions_changed` and in full every minute.
 */
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { PUBLIC_EVENT_TYPES, type PublicEventType } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";

export interface WsSubscription {
  id: string;
  sessionId: string;
  type: PublicEventType;
  version: string;
  condition: Record<string, string>;
  userId: string;
  appId: string | null;
  createdAt: Date;
}

const typeKey = (type: string, version: string) => `${type}@${version}`;

export class SubscriptionIndex {
  private readonly bySession = new Map<string, Map<string, WsSubscription>>();
  private readonly byType = new Map<string, Map<string, WsSubscription>>();

  /** Replace one session's subscriptions. */
  set(sessionId: string, subs: readonly WsSubscription[]): void {
    this.remove(sessionId);
    if (subs.length === 0) return;
    const own = new Map<string, WsSubscription>();
    for (const s of subs) {
      if (s.sessionId !== sessionId) continue;
      own.set(s.id, s);
      const k = typeKey(s.type, s.version);
      let t = this.byType.get(k);
      if (!t) {
        t = new Map();
        this.byType.set(k, t);
      }
      t.set(s.id, s);
    }
    if (own.size > 0) this.bySession.set(sessionId, own);
  }

  /** Forget a session (closed, moved). Returns what it held. */
  remove(sessionId: string): WsSubscription[] {
    const own = this.bySession.get(sessionId);
    if (!own) return [];
    this.bySession.delete(sessionId);
    for (const s of own.values()) this.dropFromType(s);
    return [...own.values()];
  }

  /** Forget one subscription (revoked). */
  removeSubscription(id: string): void {
    for (const [sessionId, own] of this.bySession) {
      const s = own.get(id);
      if (!s) continue;
      own.delete(id);
      if (own.size === 0) this.bySession.delete(sessionId);
      this.dropFromType(s);
      return;
    }
  }

  /** Replace everything (the periodic reload), keeping only `sessions`. */
  reload(sessions: Iterable<string>, subs: readonly WsSubscription[]): void {
    this.bySession.clear();
    this.byType.clear();
    const grouped = new Map<string, WsSubscription[]>();
    for (const id of sessions) grouped.set(id, []);
    for (const s of subs) grouped.get(s.sessionId)?.push(s);
    for (const [id, list] of grouped) this.set(id, list);
  }

  has(id: string): boolean {
    for (const own of this.bySession.values()) if (own.has(id)) return true;
    return false;
  }

  candidates(type: string, version: string): WsSubscription[] {
    return [...(this.byType.get(typeKey(type, version))?.values() ?? [])];
  }

  of(sessionId: string): WsSubscription[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  get size(): number {
    let n = 0;
    for (const own of this.bySession.values()) n += own.size;
    return n;
  }

  private dropFromType(s: WsSubscription): void {
    const k = typeKey(s.type, s.version);
    const t = this.byType.get(k);
    t?.delete(s.id);
    if (t?.size === 0) this.byType.delete(k);
  }
}

const PUBLIC = new Set<string>(PUBLIC_EVENT_TYPES);
const es = schema.eventSubscriptions;

/** Enabled WebSocket rows of these sessions (rows of unknown types are skipped). */
export async function loadSubscriptions(db: Executor, sessionIds: readonly string[]): Promise<WsSubscription[]> {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select({
      id: es.id,
      sessionId: es.websocketSessionId,
      type: es.type,
      version: es.version,
      condition: es.condition,
      userId: es.userId,
      appId: es.appId,
      createdAt: es.createdAt,
    })
    .from(es)
    .where(
      and(eq(es.transport, "websocket"), eq(es.status, "enabled"), inArray(es.websocketSessionId, [...sessionIds])),
    );
  const out: WsSubscription[] = [];
  for (const r of rows) {
    if (r.sessionId === null || !PUBLIC.has(r.type)) continue;
    out.push({ ...r, sessionId: r.sessionId, type: r.type as PublicEventType, condition: r.condition });
  }
  return out;
}

/** Whether a session has any subscription row (the unused-session check, 4003). */
export async function hasSubscription(db: Executor, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(es)
    .where(and(eq(es.transport, "websocket"), eq(es.websocketSessionId, sessionId)))
    .limit(1);
  return rows.length > 0;
}

/** Delete a session's rows (session end, revocation). */
export async function deleteSessionSubscriptions(db: Executor, sessionId: string): Promise<number> {
  const rows = await db
    .delete(es)
    .where(and(eq(es.transport, "websocket"), eq(es.websocketSessionId, sessionId)))
    .returning({ id: es.id });
  return rows.length;
}

export async function deleteSubscription(db: Executor, id: string): Promise<void> {
  await db.delete(es).where(eq(es.id, id));
}

/** Session ids of WebSocket rows created before `before` (sweep candidates), in order, after `afterId`. */
export async function staleSessionIds(
  db: Executor,
  before: Date,
  limit: number,
  afterId: string | null = null,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sessionId: es.websocketSessionId })
    .from(es)
    .where(
      and(
        eq(es.transport, "websocket"),
        lt(es.createdAt, before),
        afterId === null ? undefined : gt(es.websocketSessionId, afterId),
      ),
    )
    .orderBy(asc(es.websocketSessionId))
    .limit(limit);
  return rows.flatMap((r) => (r.sessionId === null ? [] : [r.sessionId]));
}

export async function deleteSessionsBefore(db: Executor, sessionIds: readonly string[], before: Date): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const rows = await db
    .delete(es)
    .where(
      and(eq(es.transport, "websocket"), inArray(es.websocketSessionId, [...sessionIds]), lt(es.createdAt, before)),
    )
    .returning({ id: es.id });
  return rows.length;
}
