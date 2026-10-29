// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EventSub WebSocket sessions in Valkey (`KEYS.eventsubSession`, `eventsubGrantSessions`,
 * `eventsubResume`): create, refresh, bind (one Lua script, so the per-grant limit holds across API
 * instances), resume (take a session over from another instance) and end. Every multi-key step is
 * one script; keys computed inside a script carry the client's key prefix explicitly.
 */
import { KEYS } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";
import type { BindResult, EventSubGrant } from "./index.ts";
import type { SessionBinding } from "./protocol.ts";

/** A grant ZSET outlives any one session's TTL (3 × at most 600 s); refreshed while a bound session lives. */
export const GRANT_SET_TTL_MS = 2 * 60 * 60 * 1000;

export const grantMember = (appId: string | null, userId: string) => `${appId ?? "personal"}:${userId}`;

export interface SessionRecord {
  instance: string;
  keepaliveSeconds: number;
  connectedAt: Date;
  binding: SessionBinding | null;
}

export function parseSessionHash(h: Record<string, string>): SessionRecord | null {
  if (!h.instance || !h.keepalive || !h.connectedAt) return null;
  const binding =
    h.userId && h.tokenHash !== undefined
      ? { appId: h.appId ? h.appId : null, userId: h.userId, tokenHash: h.tokenHash }
      : null;
  return {
    instance: h.instance,
    keepaliveSeconds: Number(h.keepalive),
    connectedAt: new Date(h.connectedAt),
    binding,
  };
}

// KEYS[1] session, KEYS[2] grant set. ARGV: appId ("" personal), userId, tokenHash, max, nowMs,
// session key prefix (with the client prefix), sessionId.
const BIND = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'unknown_session' end
local bound = redis.call('HGET', KEYS[1], 'userId')
if bound then
  if bound == ARGV[2] and redis.call('HGET', KEYS[1], 'appId') == ARGV[1] then
    redis.call('HSET', KEYS[1], 'tokenHash', ARGV[3])
    return 'ok'
  end
  return 'other_grant'
end
for _, m in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  if m ~= ARGV[7] and redis.call('EXISTS', ARGV[6] .. m) == 0 then redis.call('ZREM', KEYS[2], m) end
end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 'too_many_sessions' end
redis.call('HSET', KEYS[1], 'appId', ARGV[1], 'userId', ARGV[2], 'tokenHash', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[7])
redis.call('PEXPIRE', KEYS[2], ARGV[8])
return 'ok'
`;

// KEYS[1] resume key. ARGV: session key prefix, instance, keepalive override ("" keeps it).
// Returns {sessionId, hash fields...} or nil (unknown token, or the session is gone).
const TAKEOVER = `
local sid = redis.call('GET', KEYS[1])
if not sid then return nil end
redis.call('DEL', KEYS[1])
local skey = ARGV[1] .. sid
if redis.call('EXISTS', skey) == 0 then return nil end
if ARGV[3] ~= '' then redis.call('HSET', skey, 'keepalive', ARGV[3]) end
redis.call('HSET', skey, 'instance', ARGV[2])
local ka = tonumber(redis.call('HGET', skey, 'keepalive')) or 10
redis.call('PEXPIRE', skey, ka * 3000)
local out = {sid}
for _, v in ipairs(redis.call('HGETALL', skey)) do out[#out + 1] = v end
return out
`;

// KEYS[1] session. ARGV: instance, grant key prefix (with the client prefix), sessionId.
// 1 = ended here, 2 = already gone (nobody holds it), 0 = held by another instance (resumed).
const END = `
local inst = redis.call('HGET', KEYS[1], 'instance')
if not inst then return 2 end
if inst ~= ARGV[1] then return 0 end
local uid = redis.call('HGET', KEYS[1], 'userId')
if uid then
  local app = redis.call('HGET', KEYS[1], 'appId')
  if not app or app == '' then app = 'personal' end
  redis.call('ZREM', ARGV[2] .. app .. ':' .. uid, ARGV[3])
end
redis.call('DEL', KEYS[1])
return 1
`;

export class SessionStore {
  constructor(
    private readonly valkey: ValkeyClient,
    private readonly maxPerGrant: () => number,
  ) {}

  private get prefix(): string {
    return this.valkey.options.keyPrefix ?? "";
  }

  async create(sessionId: string, rec: { instance: string; keepaliveSeconds: number; connectedAt: Date }) {
    const key = KEYS.eventsubSession(sessionId);
    await this.valkey
      .multi()
      .hset(key, {
        instance: rec.instance,
        keepalive: String(rec.keepaliveSeconds),
        connectedAt: rec.connectedAt.toISOString(),
      })
      .pexpire(key, rec.keepaliveSeconds * 3000)
      .exec();
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return parseSessionHash(await this.valkey.hgetall(KEYS.eventsubSession(sessionId)));
  }

  async getMany(sessionIds: readonly string[]): Promise<Map<string, SessionRecord | null>> {
    const out = new Map<string, SessionRecord | null>();
    if (sessionIds.length === 0) return out;
    const p = this.valkey.pipeline();
    for (const id of sessionIds) p.hgetall(KEYS.eventsubSession(id));
    const res = (await p.exec()) ?? [];
    sessionIds.forEach((id, i) => {
      const [err, h] = res[i] ?? [null, {}];
      out.set(id, err ? null : parseSessionHash((h ?? {}) as Record<string, string>));
    });
    return out;
  }

  /**
   * Extend TTLs of held sessions (3 × keepalive) and of their grant sets. Returns the ids whose
   * hash had vanished (expired while held), for the caller to re-create.
   */
  async refresh(
    sessions: readonly { sessionId: string; keepaliveSeconds: number; binding: SessionBinding | null }[],
  ): Promise<string[]> {
    if (sessions.length === 0) return [];
    const p = this.valkey.pipeline();
    for (const s of sessions) {
      p.pexpire(KEYS.eventsubSession(s.sessionId), s.keepaliveSeconds * 3000);
      if (s.binding)
        p.pexpire(KEYS.eventsubGrantSessions(grantMember(s.binding.appId, s.binding.userId)), GRANT_SET_TTL_MS);
    }
    const res = (await p.exec()) ?? [];
    const gone: string[] = [];
    let i = 0;
    for (const s of sessions) {
      const [err, n] = res[i] ?? [null, 1];
      if (!err && n === 0) gone.push(s.sessionId);
      i += s.binding ? 2 : 1;
    }
    return gone;
  }

  /** Re-create a held session's hash (and grant membership) after it expired under us. */
  async restore(sessionId: string, rec: SessionRecord): Promise<void> {
    const key = KEYS.eventsubSession(sessionId);
    const m = this.valkey.multi().hset(key, {
      instance: rec.instance,
      keepalive: String(rec.keepaliveSeconds),
      connectedAt: rec.connectedAt.toISOString(),
      ...(rec.binding
        ? { appId: rec.binding.appId ?? "", userId: rec.binding.userId, tokenHash: rec.binding.tokenHash }
        : {}),
    });
    m.pexpire(key, rec.keepaliveSeconds * 3000);
    if (rec.binding) {
      const g = KEYS.eventsubGrantSessions(grantMember(rec.binding.appId, rec.binding.userId));
      m.zadd(g, Date.now(), sessionId).pexpire(g, GRANT_SET_TTL_MS);
    }
    await m.exec();
  }

  async bind(sessionId: string, grant: EventSubGrant): Promise<BindResult> {
    const res = (await this.valkey.eval(
      BIND,
      2,
      KEYS.eventsubSession(sessionId),
      KEYS.eventsubGrantSessions(grantMember(grant.appId, grant.userId)),
      grant.appId ?? "",
      grant.userId,
      grant.tokenHash,
      this.maxPerGrant(),
      Date.now(),
      this.prefix + KEYS.eventsubSession(""),
      sessionId,
      GRANT_SET_TTL_MS,
    )) as BindResult;
    return res;
  }

  /** Store a one-time resume token (its sha256) for the grace period. */
  async putResume(tokenHash: string, sessionId: string, graceSeconds: number): Promise<void> {
    await this.valkey.set(KEYS.eventsubResume(tokenHash), sessionId, "EX", graceSeconds);
  }

  async dropResume(tokenHash: string): Promise<void> {
    await this.valkey.del(KEYS.eventsubResume(tokenHash));
  }

  /** Consume a resume token and make `instance` the session's holder; null when unknown or gone. */
  async takeover(
    tokenHash: string,
    instance: string,
    keepaliveSeconds: number | null,
  ): Promise<(SessionRecord & { sessionId: string }) | null> {
    const res = (await this.valkey.eval(
      TAKEOVER,
      1,
      KEYS.eventsubResume(tokenHash),
      this.prefix + KEYS.eventsubSession(""),
      instance,
      keepaliveSeconds === null ? "" : String(keepaliveSeconds),
    )) as string[] | null;
    if (!res || res.length < 1) return null;
    const [sessionId, ...flat] = res;
    if (!sessionId) return null;
    const h: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) h[flat[i] as string] = flat[i + 1] as string;
    const rec = parseSessionHash(h);
    return rec ? { ...rec, sessionId } : null;
  }

  /** End a session this instance holds: 1 ended, 2 already gone, 0 another instance holds it. */
  async end(sessionId: string, instance: string): Promise<0 | 1 | 2> {
    return (await this.valkey.eval(
      END,
      1,
      KEYS.eventsubSession(sessionId),
      instance,
      this.prefix + KEYS.eventsubGrantSessions(""),
      sessionId,
    )) as 0 | 1 | 2;
  }

  /** Which of these sessions still have a hash (the sweep). */
  async existing(sessionIds: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (sessionIds.length === 0) return out;
    const p = this.valkey.pipeline();
    for (const id of sessionIds) p.exists(KEYS.eventsubSession(id));
    const res = (await p.exec()) ?? [];
    sessionIds.forEach((id, i) => {
      const [err, n] = res[i] ?? [null, 0];
      // Fail safe: an error counts as existing, so nothing is deleted on a Valkey hiccup.
      if (err || n !== 0) out.add(id);
    });
    return out;
  }

  async tryLock(key: string, holder: string, ttlMs: number): Promise<boolean> {
    return (await this.valkey.set(key, holder, "PX", ttlMs, "NX")) === "OK";
  }
}
