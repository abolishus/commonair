// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The attestation job against Postgres: figures equal the session verdicts through the rollup, a
 * re-score supersedes and identical figures append nothing, concurrent appends on one chain
 * serialize, the 0043 triggers refuse a wrong seq / prevHash, a retired kid and a second broadcast
 * entry, rehearsals are never attested, key rotation retires the old row, a compromised kid is
 * re-issued, and the daily reconciler enqueues what it should.
 */
import { generateKeyPairSync } from "node:crypto";
import { ANALYTICS_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { RULESET_VERSION, loadThresholds } from "@commonair/integrity";
import {
  type AttestationKey,
  type AttestationSigningKey,
  importAttestationSigningKey,
  reasonsCommitment,
  thresholdsHash,
  verify,
} from "@commonair/tokens/attestation";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { rollupBroadcast } from "../src/jobs/broadcast-rollup.ts";
import {
  attestBroadcast,
  decodeStatement,
  reconcileAttestations,
  SigningKeyRetiredError,
} from "../src/jobs/integrity-attestation.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
let keyA: AttestationSigningKey;
let keyB: AttestationSigningKey;
const ORIGIN = "https://instance.example";
const HOUR = 3_600_000;
const model = { currency: "usd", centsPerGb: { origin: 2 } };

const newKey = () =>
  importAttestationSigningKey(
    generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  keyA = await newKey();
  keyB = await newKey();
});
afterAll(async () => {
  await env.close();
});

type Enqueued = { queue: string; name: string; data: unknown; jobId: string | undefined };
function ctxAt(now: Date, enqueued: Enqueued[] = []): WorkerContext {
  return {
    ...env.worker.ctx,
    now: () => now,
    enqueue: async (queue, name, data, opts) => {
      enqueued.push({ queue, name, data, jobId: opts?.jobId });
    },
  };
}
const opts = (key = keyA) => ({ key, origin: ORIGIN });

async function broadcastFor(channelId: string, startedAt: Date, endedAt: Date, kind: "live" | "rehearsal" = "live") {
  const [b] = await env.t.db
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId, ingestProtocol: "rtmp", path: `live/${channelId}`, startedAt, endedAt, kind })
    .returning();
  return b!;
}

async function addSession(
  channelId: string,
  broadcastId: string,
  o: { start: Date; end: Date; verdict: "pending" | "verified" | "excluded"; reasons?: string[] },
) {
  const [s] = await env.t.db
    .insert(schema.playbackSessions)
    .values({
      id: uuidv7(),
      channelId,
      broadcastId,
      deviceHash: crypto.randomUUID(),
      ipHash: crypto.randomUUID(),
      assignedSource: "origin",
      startedAt: o.start,
      endedAt: o.end,
      verdict: o.verdict,
      verdictReasons: o.reasons ?? [],
      scoredAt: o.start,
    })
    .returning();
  return s!;
}

/** A one-hour broadcast that ended 3 h ago with 2 verified, 1 pending and 6 excluded sessions. */
async function scenario(channelId?: string) {
  const ch = channelId ?? (await makeUser(env.t.db)).channel.id;
  const endedAt = new Date(Math.floor((Date.now() - 3 * HOUR) / 60_000) * 60_000);
  const startedAt = new Date(endedAt.getTime() - HOUR);
  const b = await broadcastFor(ch, startedAt, endedAt);
  const m = (min: number) => new Date(startedAt.getTime() + min * 60_000);
  const sessions = [
    await addSession(ch, b.id, { start: m(0), end: m(30), verdict: "verified" }),
    await addSession(ch, b.id, { start: m(10), end: m(40), verdict: "verified" }),
    await addSession(ch, b.id, { start: m(1), end: m(2), verdict: "pending" }),
  ];
  for (let i = 0; i < 6; i++)
    sessions.push(
      await addSession(ch, b.id, { start: m(20), end: m(50), verdict: "excluded", reasons: ["datacenter_ip"] }),
    );
  await env.t.db
    .insert(schema.egressSamples)
    .values({ broadcastId: b.id, bucketStart: m(0), source: "origin", bytes: 5000 });
  return { channelId: ch, broadcast: b, sessions };
}

const entriesOf = (channelId: string) =>
  env.t.db
    .select()
    .from(schema.integrityAttestations)
    .where(eq(schema.integrityAttestations.channelId, channelId))
    .orderBy(asc(schema.integrityAttestations.seq));

async function keyHistory(): Promise<AttestationKey[]> {
  const rows = await env.t.db.select().from(schema.integritySigningKeys);
  return rows.map((k) => ({
    kid: k.kid,
    algorithm: "Ed25519",
    publicKey: k.publicKey,
    firstUsedAt: k.firstUsedAt.toISOString(),
    retiredAt: k.retiredAt?.toISOString() ?? null,
    compromisedAt: k.compromisedAt?.toISOString() ?? null,
  }));
}

/** Insert a raw row the triggers must judge (signature and payload need not be real for them). */
async function rawInsert(o: {
  channelId: string;
  broadcastId: string;
  seq: number;
  kind: "broadcast" | "supersede";
  kid: string;
  prevHash: string | null;
  supersedes?: string | null;
}) {
  await env.t.db.insert(schema.integrityAttestations).values({
    id: uuidv7(),
    channelId: o.channelId,
    broadcastId: o.broadcastId,
    seq: o.seq,
    kind: o.kind,
    kid: o.kid,
    payload: "e30",
    signature: "AA",
    entryHash: crypto.randomUUID().replace(/-/g, "").repeat(2),
    prevHash: o.prevHash,
    supersedes: o.supersedes ?? null,
    signedAt: new Date(),
    breakdown: {},
    salt: "AAAAAAAAAAAAAAAAAAAAAA",
  });
}

const message = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ""} ${e.cause?.message ?? ""}`;
  }
};

describe("append", () => {
  test("figures equal the session verdicts through the rollup; the statement verifies; no user ids", async () => {
    const { channelId, broadcast: b, sessions } = await scenario();
    const now = new Date();
    expect(
      (await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model }))
        .rolledUp,
    ).toBe(1);
    const out = await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts());
    expect(out).toMatchObject({ attested: 1, seq: 1 });

    const [e] = await entriesOf(channelId);
    expect(e).toMatchObject({ seq: 1, kind: "broadcast", kid: keyA.kid, prevHash: null, supersedes: null });
    const r = await verify({ payload: e!.payload, signature: e!.signature }, await keyHistory());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entryHash).toBe(e!.entryHash);
    const s = r.statement;
    // From the verdicts directly: verified 30 + 30 min, pending 1 min, 6 excluded × 30 min.
    expect(s.verifiedViewerSeconds).toBe(3600);
    expect(s.unverifiedViewerSeconds).toBe(60);
    expect(s.excludedViewerSeconds).toBe(6 * 1800);
    expect(s.peakVerifiedConcurrent).toBe(2);
    expect(s.durationSeconds).toBe(3600);
    expect(s.deliveryBytes).toEqual({ origin: 5000, relay: 0, cdn: 0 });
    expect(s.periodStart).toBe(b.startedAt.toISOString());
    expect(s.periodEnd).toBe(b.endedAt!.toISOString());
    expect(s.origin).toBe(ORIGIN);
    expect(s.rulesetVersion).toBe(RULESET_VERSION);
    expect(s.thresholdsHash).toBe(await thresholdsHash(RULESET_VERSION, await loadThresholds(env.t.db)));
    expect(e!.breakdown).toEqual({ datacenter: 6 * 1800 });
    expect(await reasonsCommitment(e!.salt, e!.breakdown)).toBe(s.reasonsCommitment);
    const text = Buffer.from(e!.payload, "base64url").toString();
    for (const sess of sessions) expect(text).not.toContain(sess.id);
    const [owner] = await env.t.db
      .select({ id: schema.channels.ownerId })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId));
    expect(text).not.toContain(owner!.id);

    const [ev] = await env.t.db
      .select()
      .from(schema.events)
      .where(
        sql`${schema.events.type} = 'integrity.attestation.appended' and ${schema.events.payload}->>'attestation_id' = ${e!.id}`,
      );
    expect(ev?.payload).toMatchObject({ seq: 1, kind: "broadcast", broadcast_id: b.id, kid: keyA.kid });
  });

  test("identical figures append nothing; a re-score supersedes the latest entry", async () => {
    const { channelId, broadcast: b, sessions } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts());
    expect(await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "recheck" }, opts())).toMatchObject({
      unchanged: 1,
    });
    expect(await entriesOf(channelId)).toHaveLength(1);

    // An overturn restores one excluded session.
    await env.t.db
      .update(schema.playbackSessions)
      .set({ verdict: "verified", verdictReasons: [] })
      .where(eq(schema.playbackSessions.id, sessions[3]!.id));
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rescore" }, { costModel: model });
    expect(await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "recheck" }, opts())).toMatchObject({
      superseded: 1,
      seq: 2,
    });
    const [first, second] = await entriesOf(channelId);
    expect(second).toMatchObject({ kind: "supersede", supersedes: first!.entryHash, prevHash: first!.entryHash });
    const s = decodeStatement(second!.payload);
    expect(s.verifiedViewerSeconds).toBe(3600 + 1800);
    expect(s.excludedViewerSeconds).toBe(5 * 1800);
    expect(second!.breakdown).toEqual({ datacenter: 5 * 1800 });
  });

  test("a rehearsal is never attested; a missing rollup appends nothing", async () => {
    const { channel } = await makeUser(env.t.db);
    const r = await broadcastFor(channel.id, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - HOUR), "rehearsal");
    expect(await attestBroadcast(ctxAt(new Date()), { broadcastId: r.id, reason: "test" }, opts())).toEqual({
      rehearsal: 1,
    });
    const { broadcast: b, channelId } = await scenario();
    expect(await attestBroadcast(ctxAt(new Date()), { broadcastId: b.id, reason: "test" }, opts())).toEqual({
      notRolledUp: 1,
    });
    expect(await entriesOf(channel.id)).toHaveLength(0);
    expect(await entriesOf(channelId)).toHaveLength(0);
  });

  test("a broadcast whose per-minute rollup is gone is final", async () => {
    const { broadcast: b, channelId } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    await env.t.db
      .update(schema.broadcastAudienceTotals)
      .set({ minutesPurgedAt: now })
      .where(eq(schema.broadcastAudienceTotals.broadcastId, b.id));
    expect(await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "reconcile" }, opts())).toEqual({ final: 1 });
    expect(await entriesOf(channelId)).toHaveLength(0);
  });
});

describe("concurrency", () => {
  test("an offline append and a supersede on one chain serialize: one chain, no trigger error", async () => {
    const { channel } = await makeUser(env.t.db);
    const first = await scenario(channel.id);
    const second = await scenario(channel.id);
    const now = new Date();
    for (const b of [first, second])
      await rollupBroadcast(
        ctxAt(now),
        { broadcastId: b.broadcast.id, reason: "test", settleSeconds: 0 },
        { costModel: model },
      );
    await attestBroadcast(ctxAt(now), { broadcastId: first.broadcast.id, reason: "rollup" }, opts());
    await env.t.db
      .update(schema.playbackSessions)
      .set({ verdict: "verified", verdictReasons: [] })
      .where(eq(schema.playbackSessions.id, first.sessions[4]!.id));
    await rollupBroadcast(ctxAt(now), { broadcastId: first.broadcast.id, reason: "rescore" }, { costModel: model });

    const results = await Promise.all([
      attestBroadcast(ctxAt(now), { broadcastId: second.broadcast.id, reason: "rollup" }, opts()),
      attestBroadcast(ctxAt(now), { broadcastId: first.broadcast.id, reason: "recheck" }, opts()),
      attestBroadcast(ctxAt(now), { broadcastId: second.broadcast.id, reason: "test" }, opts()),
    ]);
    expect(results.filter((r) => r.attested === 1)).toHaveLength(1);
    expect(results.filter((r) => r.superseded === 1)).toHaveLength(1);
    expect(results.filter((r) => r.unchanged === 1)).toHaveLength(1);
    const chain = await entriesOf(channel.id);
    expect(chain.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.prevHash).toBe(chain[i - 1]!.entryHash);
    const keys = await keyHistory();
    for (const e of chain) expect((await verify({ payload: e.payload, signature: e.signature }, keys)).ok).toBe(true);
  });
});

describe("the 0043 triggers", () => {
  test("refuse a wrong seq, a wrong prevHash, a second broadcast entry, and any update or delete", async () => {
    const { broadcast: b, channelId } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts());
    const [head] = await entriesOf(channelId);
    const base = { channelId, broadcastId: b.id, kid: keyA.kid };
    expect(
      await message(
        rawInsert({ ...base, seq: 3, kind: "supersede", prevHash: head!.entryHash, supersedes: head!.entryHash }),
      ),
    ).toMatch(/head \+ 1/);
    expect(
      await message(
        rawInsert({ ...base, seq: 2, kind: "supersede", prevHash: "0".repeat(64), supersedes: head!.entryHash }),
      ),
    ).toMatch(/prev_hash/);
    expect(await message(rawInsert({ ...base, seq: 2, kind: "broadcast", prevHash: head!.entryHash }))).toMatch(
      /exactly one broadcast entry/,
    );
    expect(
      await message(
        env.t.db
          .update(schema.integrityAttestations)
          .set({ salt: "x" })
          .where(eq(schema.integrityAttestations.id, head!.id)),
      ),
    ).toMatch(/append-only|permission/);
    expect(
      await message(env.t.db.delete(schema.integrityAttestations).where(eq(schema.integrityAttestations.id, head!.id))),
    ).toMatch(/append-only|permission/);
    expect(await entriesOf(channelId)).toHaveLength(1);
  });

  test("a rehearsal row is refused even when inserted directly", async () => {
    const { channel } = await makeUser(env.t.db);
    const r = await broadcastFor(channel.id, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - HOUR), "rehearsal");
    expect(
      await message(
        rawInsert({
          channelId: channel.id,
          broadcastId: r.id,
          seq: 1,
          kind: "broadcast",
          kid: keyA.kid,
          prevHash: null,
        }),
      ),
    ).toMatch(/rehearsal/);
  });
});

describe("keys", () => {
  // Runs after the tests above, which used keyA: rotating retires it for the rest of the file.
  test("rotation: the new key's first use retires the old row; the old key's appends are refused", async () => {
    const { broadcast: b, channelId } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts(keyB));
    const rows = await env.t.db.select().from(schema.integritySigningKeys);
    const a = rows.find((k) => k.kid === keyA.kid);
    const bRow = rows.find((k) => k.kid === keyB.kid);
    expect(a?.retiredAt).not.toBeNull();
    expect(bRow).toMatchObject({ retiredAt: null, compromisedAt: null, publicKey: keyB.publicKey });
    const [rotate] = await env.t.db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} = 'integrity.key.rotate' and ${schema.auditLog.subjectId} = ${keyB.kid}`);
    expect(rotate?.details).toMatchObject({ kid: keyB.kid, retired: [keyA.kid] });

    // A worker still holding the retired key: the job fails (and retries after a restart).
    const second = await scenario(channelId);
    await rollupBroadcast(
      ctxAt(now),
      { broadcastId: second.broadcast.id, reason: "test", settleSeconds: 0 },
      { costModel: model },
    );
    await expect(
      attestBroadcast(ctxAt(now), { broadcastId: second.broadcast.id, reason: "rollup" }, opts(keyA)),
    ).rejects.toBeInstanceOf(SigningKeyRetiredError);
    // The trigger refuses the retired kid too, for a caller that skips the job's check.
    const [head] = await entriesOf(channelId);
    expect(
      await message(
        rawInsert({
          channelId,
          broadcastId: second.broadcast.id,
          seq: 2,
          kind: "broadcast",
          kid: keyA.kid,
          prevHash: head!.entryHash,
        }),
      ),
    ).toMatch(/active, uncompromised key/);
    // Entries the retired key signed still verify against the history.
    const history = await keyHistory();
    const old = await env.t.db
      .select()
      .from(schema.integrityAttestations)
      .where(eq(schema.integrityAttestations.kid, keyA.kid));
    expect(old.length).toBeGreaterThan(0);
    for (const e of old) expect((await verify({ payload: e.payload, signature: e.signature }, history)).ok).toBe(true);
  });

  test("a compromised kid: its entries fail verification and the job re-issues them under the current key", async () => {
    const keyC = await newKey();
    const { broadcast: b, channelId } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts(keyB));
    await env.t.db
      .update(schema.integritySigningKeys)
      .set({ compromisedAt: now })
      .where(eq(schema.integritySigningKeys.kid, keyB.kid));
    const [orig] = await entriesOf(channelId);
    expect(await verify({ payload: orig!.payload, signature: orig!.signature }, await keyHistory())).toEqual({
      ok: false,
      error: "compromised_kid",
    });

    const enqueued: Enqueued[] = [];
    expect((await reconcileAttestations(ctxAt(now, enqueued))).compromised).toBeGreaterThanOrEqual(1);
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        name: ANALYTICS_JOBS.integrityAttestation,
        data: { broadcastId: b.id, reason: "reconcile" },
      }),
    );

    expect(await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "reconcile" }, opts(keyC))).toMatchObject({
      reissued: 1,
      unchanged: 1,
    });
    const [, re] = await entriesOf(channelId);
    expect(re).toMatchObject({
      kind: "reissue",
      kid: keyC.kid,
      supersedes: orig!.entryHash,
      prevHash: orig!.entryHash,
      salt: orig!.salt,
    });
    const r = await verify({ payload: re!.payload, signature: re!.signature }, await keyHistory());
    expect(r.ok).toBe(true);
    const was = decodeStatement(orig!.payload);
    const now_ = decodeStatement(re!.payload);
    expect(now_.verifiedViewerSeconds).toBe(was.verifiedViewerSeconds);
    expect(now_.reasonsCommitment).toBe(was.reasonsCommitment);
    expect(now_.thresholdsHash).toBe(was.thresholdsHash);
  });
});

describe("reconcile", () => {
  test("re-rolls broadcasts with sessions scored after the rollup; re-checks rolled-up broadcasts never attested", async () => {
    const keyD = await newKey();
    const { broadcast: b, sessions } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    let enqueued: Enqueued[] = [];
    await reconcileAttestations(ctxAt(now, enqueued));
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        name: ANALYTICS_JOBS.integrityAttestation,
        data: { broadcastId: b.id, reason: "reconcile" },
      }),
    );

    await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts(keyD));
    enqueued = [];
    await reconcileAttestations(ctxAt(now, enqueued));
    expect(enqueued.filter((e) => (e.data as { broadcastId: string }).broadcastId === b.id)).toEqual([]);

    await env.t.db
      .update(schema.playbackSessions)
      .set({ scoredAt: new Date(now.getTime() + 60_000) })
      .where(eq(schema.playbackSessions.id, sessions[0]!.id));
    enqueued = [];
    await reconcileAttestations(ctxAt(now, enqueued));
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        queue: QUEUES.analytics,
        name: ANALYTICS_JOBS.broadcastRollup,
        data: { broadcastId: b.id, reason: "rescore" },
      }),
    );
  });

  test("a broadcast never attested is re-checked however long ago it was rolled up", async () => {
    const { broadcast: b } = await scenario();
    const now = new Date();
    await rollupBroadcast(ctxAt(now), { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
    // A worker that was down for a week: the rollup ran long before this reconcile.
    const later = new Date(now.getTime() + 7 * 86_400_000);
    const enqueued: Enqueued[] = [];
    await reconcileAttestations(ctxAt(later, enqueued));
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        name: ANALYTICS_JOBS.integrityAttestation,
        data: { broadcastId: b.id, reason: "reconcile" },
      }),
    );

    // Attested once, then re-rolled outside the window with nothing new: not re-checked forever.
    await attestBroadcast(ctxAt(now), { broadcastId: b.id, reason: "rollup" }, opts(await newKey()));
    await env.t.db
      .update(schema.broadcastAudienceTotals)
      .set({ rolledUpAt: new Date(now.getTime() + 60_000) })
      .where(eq(schema.broadcastAudienceTotals.broadcastId, b.id));
    const none: Enqueued[] = [];
    await reconcileAttestations(ctxAt(later, none));
    expect(none.filter((e) => (e.data as { broadcastId: string }).broadcastId === b.id)).toEqual([]);
  });
});
