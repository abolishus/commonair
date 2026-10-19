// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Member relays: creation (registration token), the relay protocol (register,
 * heartbeat, receipts) and admin review. Receipts are stored `pending`; the
 * worker/integrity units cross-check them against the origin's issuance log.
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import { RECEIPT_INTERVAL_SECONDS } from "@commonair/contracts/tokens";
import { schema } from "@commonair/db";
import { randomSecret, sha256Hex, verifyReceipt } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { iso, isoOrNull, loadUsersPublic } from "../lib/dto.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { apiError, badRequest, conflict, forbidden, isUniqueViolation, notFound, precondition } from "../lib/errors.ts";
import { resolveOutbound } from "../lib/outbound.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import type { RelayEntry } from "../playback/delivery.ts";

const { relayNodes, relayReceipts } = schema;
type RelayRow = typeof relayNodes.$inferSelect;

export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const HEALTH_TIMEOUT_MS = 3000;
const MAX_RELAYS_PER_MEMBER = 5;
/** Placeholder until the relay registers itself (the column is NOT NULL; `.invalid` never resolves). */
export const UNREGISTERED_URL = "http://unregistered.invalid/";
const RECHECK_MS = 60_000;

/** Relay URLs are fetched by the API (health checks) and handed to viewers. */
export function relayUrlProblem(raw: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (u.username || u.password || u.search || u.hash) return "URL must not carry credentials, query or fragment";
  if (!allowInsecure && u.protocol !== "https:") return "relays must use https";
  if (!["http:", "https:"].includes(u.protocol)) return "relays must use http(s)";
  return null;
}

/**
 * Network check: https to hosts that resolve only to public addresses, unless the local stack
 * opted into private networks (OUTBOUND_ALLOW_PRIVATE_NETWORKS, which also allows http).
 */
export function relayTarget(deps: Deps, raw: string) {
  const allowPrivate = deps.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS;
  return resolveOutbound(raw, {
    protocols: allowPrivate ? ["https:", "http:"] : ["https:"],
    allowPrivate,
    resolve: deps.resolveHost,
  });
}

export async function relayTargetProblem(deps: Deps, raw: string): Promise<string | null> {
  const t = await relayTarget(deps, raw);
  return t.ok ? null : t.reason;
}

type RelayStats = {
  bytes: number;
  lastReceiptAt: Date | null;
  receipts: { pending: number; verified: number; rejected: number };
};
const NO_STATS: RelayStats = { bytes: 0, lastReceiptAt: null, receipts: { pending: 0, verified: 0, rejected: 0 } };

/** Verified bytes and receipt counts over 30 days (by period start), plus the latest receipt. */
async function relayStats(deps: Deps, ids: string[]) {
  if (ids.length === 0) return new Map<string, RelayStats>();
  // Bound as text: a Date inside a raw `sql` fragment is not serialized by the driver.
  const since = sql`${new Date(deps.now().getTime() - 30 * 86_400_000).toISOString()}::timestamptz`;
  const rows = await deps.db
    .select({
      id: relayReceipts.relayId,
      bytes: sql<string>`coalesce(sum(${relayReceipts.bytesVerified}) filter (where ${relayReceipts.status} = 'verified' and ${relayReceipts.periodStart} > ${since}), 0)::text`,
      last: sql<Date | string | null>`max(${relayReceipts.createdAt})`,
      pending: sql<number>`(count(*) filter (where ${relayReceipts.status} = 'pending' and ${relayReceipts.periodStart} > ${since}))::int`,
      verified: sql<number>`(count(*) filter (where ${relayReceipts.status} = 'verified' and ${relayReceipts.periodStart} > ${since}))::int`,
      rejected: sql<number>`(count(*) filter (where ${relayReceipts.status} = 'rejected' and ${relayReceipts.periodStart} > ${since}))::int`,
    })
    .from(relayReceipts)
    .where(inArray(relayReceipts.relayId, ids))
    .groupBy(relayReceipts.relayId);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        bytes: Number(r.bytes),
        lastReceiptAt: r.last === null ? null : new Date(r.last),
        receipts: { pending: Number(r.pending), verified: Number(r.verified), rejected: Number(r.rejected) },
      },
    ]),
  );
}

const toRelayDto = (r: RelayRow, stats: RelayStats = NO_STATS) => ({
  id: r.id,
  name: r.name,
  publicUrl: r.publicUrl,
  region: r.region,
  declaredCapacityMbps: r.declaredCapacityMbps,
  measuredCapacityMbps: r.measuredCapacityMbps,
  status: r.status,
  lastHealthAt: isoOrNull(r.lastHealthAt),
  suspendedReason: r.suspendedReason,
  version: r.version,
  bytesVerified30d: stats.bytes,
  lastReceiptAt: isoOrNull(stats.lastReceiptAt),
  receipts30d: stats.receipts,
});

/** GET <publicUrl>/healthz with a 3 s timeout. */
export async function healthCheck(deps: Deps, publicUrl: string): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    // Resolve and vet now, then connect to exactly the vetted address: a DNS answer that
    // changes between the check and the connection (rebinding) cannot point us inward.
    const target = await relayTarget(deps, publicUrl);
    if (!target.ok) return { ok: false, latencyMs: 0 };
    const url = new URL("healthz", publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`);
    const status = await deps.pinnedGet(url, target.addresses[0] ?? null, HEALTH_TIMEOUT_MS);
    return { ok: status >= 200 && status < 300, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  }
}

async function publishRelay(deps: Deps, r: RelayRow, loadMbps: number) {
  if (r.status === "active") {
    const entry: RelayEntry = {
      url: r.publicUrl.replace(/\/+$/, ""),
      capacityMbps: r.declaredCapacityMbps,
      status: r.status,
      load: loadMbps,
    };
    await deps.valkey.hset(KEYS.relays, r.id, JSON.stringify(entry));
  } else await deps.valkey.hdel(KEYS.relays, r.id);
}

/** Re-run the health check and update status; suspended/offline relays never become active here. */
async function refreshHealth(deps: Deps, r: RelayRow): Promise<RelayRow> {
  if (r.status === "suspended" || r.status === "offline" || r.publicUrl === UNREGISTERED_URL) return r;
  const h = await healthCheck(deps, r.publicUrl);
  const [row] = await deps.db
    .update(relayNodes)
    .set({
      status: h.ok ? "active" : r.status === "active" ? "degraded" : r.status,
      lastHealthAt: deps.now(),
      lastHealthLatencyMs: h.latencyMs,
      consecutiveFailures: h.ok ? 0 : sql`${relayNodes.consecutiveFailures} + 1`,
    })
    .where(and(eq(relayNodes.id, r.id), sql`${relayNodes.status} not in ('suspended', 'offline')`))
    .returning();
  return row ?? r;
}

function requireRelay(ctx: { relay: RelayRow | null }): RelayRow {
  if (!ctx.relay) throw apiError("UNAUTHORIZED", "A valid relay token is required");
  if (ctx.relay.status === "offline") throw apiError("UNAUTHORIZED", "This relay was retired");
  return ctx.relay;
}

export const relays = {
  mine: os.relays.mine.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const rows = await context.deps.db
      .select()
      .from(relayNodes)
      .where(eq(relayNodes.ownerId, caller.user.id))
      .orderBy(desc(relayNodes.createdAt));
    const stats = await relayStats(
      context.deps,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toRelayDto(r, stats.get(r.id)));
  }),

  create: os.relays.create.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    if (caller.user.accountType !== "human") throw forbidden("Relays are run by members");
    const [{ n } = { n: 0 }] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(relayNodes)
      .where(and(eq(relayNodes.ownerId, caller.user.id), sql`${relayNodes.status} <> 'offline'`));
    if (Number(n) >= MAX_RELAYS_PER_MEMBER)
      throw precondition("relay_limit", `At most ${MAX_RELAYS_PER_MEMBER} relays per member`);
    const token = randomSecret("relay_");
    const [row] = await deps.db
      .insert(relayNodes)
      .values({
        ownerId: caller.user.id,
        name: input.name,
        publicUrl: UNREGISTERED_URL,
        declaredCapacityMbps: 0,
        publicKey: "",
        tokenHash: await sha256Hex(token),
      })
      .returning({ id: relayNodes.id });
    if (!row) throw new Error("relay insert returned no row");
    return { relayId: row.id, registrationToken: token };
  }),

  remove: os.relays.remove.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    // Retired, not deleted: receipts reference the relay. The token stops working at once.
    const [row] = await deps.db
      .update(relayNodes)
      .set({ status: "offline", tokenHash: await sha256Hex(randomSecret("retired_")) })
      .where(and(eq(relayNodes.id, input.id), eq(relayNodes.ownerId, caller.user.id)))
      .returning({ id: relayNodes.id });
    if (!row) throw notFound("Relay not found");
    await deps.valkey.hdel(KEYS.relays, row.id);
    return { ok: true as const };
  }),

  register: os.relays.register.handler(async ({ context, input }) => {
    const { deps } = context;
    const relay = requireRelay(context);
    const problem = relayUrlProblem(input.publicUrl, deps.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS);
    if (problem) throw badRequest(`publicUrl: ${problem}`);
    const target = await relayTargetProblem(deps, input.publicUrl);
    if (target) {
      deps.logger.info("relay registration refused", { relayId: relay.id, reason: target });
      throw badRequest("publicUrl: must be a publicly reachable https URL");
    }
    let [row] = await deps.db
      .update(relayNodes)
      .set({
        publicUrl: input.publicUrl,
        declaredCapacityMbps: input.declaredCapacityMbps,
        publicKey: input.publicKey,
        version: input.version,
        region: input.region,
        status: relay.status === "suspended" ? "suspended" : "pending",
      })
      .where(eq(relayNodes.id, relay.id))
      .returning();
    if (!row) throw notFound("Relay not found");
    row = await refreshHealth(deps, row);
    await publishRelay(deps, row, 0);
    return {
      relayId: row.id,
      originUrl: deps.env.PLAYBACK_PUBLIC_URL,
      originPublicKey: deps.signingKey.publicKeyB64,
      receiptIntervalSeconds: RECEIPT_INTERVAL_SECONDS,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      status: row.status,
    };
  }),

  heartbeat: os.relays.heartbeat.handler(async ({ context, input }) => {
    const { deps } = context;
    let relay = requireRelay(context);
    if (relay.publicUrl === UNREGISTERED_URL) throw precondition("registered", "Register the relay first");
    const stale = !relay.lastHealthAt || deps.now().getTime() - relay.lastHealthAt.getTime() > RECHECK_MS;
    if (relay.status !== "active" && stale) relay = await refreshHealth(deps, relay);
    else if (relay.status === "active")
      await deps.db.update(relayNodes).set({ lastHealthAt: deps.now() }).where(eq(relayNodes.id, relay.id));
    await publishRelay(deps, relay, input.egressMbps);
    return { status: relay.status, originPublicKey: deps.signingKey.publicKeyB64 };
  }),

  receipt: os.relays.receipt.handler(async ({ context, input }) => {
    const { deps } = context;
    const relay = requireRelay(context);
    if (!relay.publicKey) throw precondition("registered", "Register the relay first");
    const v = await verifyReceipt(relay.publicKey, { payload: input.payload, signature: input.signature });
    if (!v.ok) throw badRequest(`Receipt rejected: ${v.error}`);
    const p = v.value;
    if (p.relayId !== relay.id) throw forbidden("Receipt is for another relay");
    const start = new Date(p.periodStart);
    const end = new Date(p.periodEnd);
    if (!(end > start)) throw badRequest("periodEnd must be after periodStart");
    if (end.getTime() > deps.now().getTime() + 60_000) throw badRequest("Receipt period is in the future");
    try {
      const [row] = await deps.db
        .insert(relayReceipts)
        .values({
          relayId: relay.id,
          nonce: p.nonce,
          periodStart: start,
          periodEnd: end,
          bytesReported: p.entries.reduce((s, e) => s + e.bytes, 0),
          segmentsReported: p.entries.reduce((s, e) => s + e.segments, 0),
          tokensReported: p.entries.length,
          payload: p,
          signature: input.signature,
          status: "pending",
        })
        .returning({ id: relayReceipts.id, status: relayReceipts.status });
      if (!row) throw new Error("receipt insert returned no row");
      return { receiptId: row.id, status: row.status };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("Receipt nonce already used");
      throw err;
    }
  }),

  adminList: os.relays.adminList.handler(async ({ context, input }) => {
    const { deps } = context;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await deps.db
      .select()
      .from(relayNodes)
      .where(
        and(
          input.status ? eq(relayNodes.status, input.status) : undefined,
          cur
            ? or(
                lt(relayNodes.createdAt, new Date(cur.t)),
                and(eq(relayNodes.createdAt, new Date(cur.t)), lt(relayNodes.id, cur.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(relayNodes.createdAt), desc(relayNodes.id))
      .limit(input.limit + 1);
    const page = pageOf(
      rows,
      input.limit,
      (r) => r,
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
    const [owners, stats] = await Promise.all([
      loadUsersPublic(
        deps,
        page.items.map((r) => r.ownerId),
      ),
      relayStats(
        deps,
        page.items.map((r) => r.id),
      ),
    ]);
    return {
      items: page.items.flatMap((r) => {
        const owner = owners.get(r.ownerId);
        return owner ? [{ ...toRelayDto(r, stats.get(r.id)), owner }] : [];
      }),
      nextCursor: page.nextCursor,
    };
  }),

  reinstate: os.relays.reinstate.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const row = await deps.db.transaction(async (tx) => {
      const [r] = await tx
        .update(relayNodes)
        .set({ status: "pending", suspendedAt: null, suspendedReason: null, consecutiveFailures: 0 })
        .where(and(eq(relayNodes.id, input.id), eq(relayNodes.status, "suspended")))
        .returning();
      if (!r) throw notFound("No suspended relay with this id");
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "relay.reinstate",
        subjectType: "relay",
        subjectId: r.id,
        reason: input.reason,
      });
      return r;
    });
    const refreshed = await refreshHealth(deps, row);
    await publishRelay(deps, refreshed, 0);
    return toRelayDto(refreshed, (await relayStats(deps, [refreshed.id])).get(refreshed.id));
  }),
};
