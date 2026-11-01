// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `signed` / `tamper` steps' database reads on Bun.SQL against a real Postgres: verdict
 * seconds classified and clipped as the rollup does (including microsecond timestamps the rollup
 * only sees to the millisecond), the broadcast's entries, and the append-only refusal of a rewrite.
 */
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { entryHash, importAttestationSigningKey, sign } from "@commonair/tokens/attestation";
import vectors from "@commonair/tokens/vectors.json" with { type: "json" };
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { readEntries, readVerdictSeconds, tamperedPayload, tryRewriteStoredRow } from "../../src/w2/attestations.ts";

const V = vectors.attestation;
let t: TestDatabase;
let h: DbHandle;
const owner = uuidv7();
const channelId = V.statement.channelId;
const broadcastId = V.statement.broadcastId;
let entryId: string;
let payload: string;

beforeAll(async () => {
  t = await createTestDatabase();
  h = createDb({ url: t.url, max: 1 });
  await h.db
    .insert(schema.users)
    .values({ id: owner, name: "w2 attest", email: "w2attest@example.test", username: "w2attest" });
  await h.db
    .insert(schema.channels)
    .values({ id: channelId, ownerId: owner, slug: "w2attest", displayName: "w2attest" });
  // Raw SQL so the timestamps keep their microseconds (a JS Date would drop them).
  const sql = new Bun.SQL(t.url);
  try {
    await sql`insert into broadcasts (id, channel_id, ingest_protocol, path, started_at, ended_at)
      values (${broadcastId}::uuid, ${channelId}::uuid, 'rtmp', 'live/w2attest',
              '2026-10-31T12:00:00.0004Z'::timestamptz, '2026-10-31T13:00:00.0009Z'::timestamptz)`;
    const s = (
      verdict: string,
      start: string,
      end: string | null,
      o: { reasons?: string; scored?: boolean } = {},
    ) => sql`insert into playback_sessions
        (id, channel_id, broadcast_id, device_hash, ip_hash, started_at, ended_at, verdict, verdict_reasons, scored_at)
      values (${uuidv7()}::uuid, ${channelId}::uuid, ${broadcastId}::uuid, ${crypto.randomUUID()}, ${crypto.randomUUID()},
              ${start}::timestamptz, ${end}::timestamptz, ${verdict}::session_verdict,
              ${o.reasons ?? "{}"}::text[], ${o.scored === false ? null : start}::timestamptz)`;
    // verified 30 min; one starting before the broadcast (clipped); one still open (ends with it)
    await s("verified", "2026-10-31T12:10:00.000Z", "2026-10-31T12:40:00.000Z");
    await s("verified", "2026-10-31T11:50:00.000Z", "2026-10-31T12:05:00.0004Z");
    await s("verified", "2026-10-31T12:59:00.000Z", null);
    // A session whose true length is 1.9996 s but 2.000 s at millisecond precision: the rollup says 2.
    await s("verified", "2026-10-31T12:20:00.0009Z", "2026-10-31T12:20:02.0005Z");
    // unverified: not scored, fetch-unjudged, pending
    await s("verified", "2026-10-31T12:00:10.000Z", "2026-10-31T12:01:10.000Z", { scored: false });
    await s("verified", "2026-10-31T12:00:10.000Z", "2026-10-31T12:02:10.000Z", { reasons: "{fetch_unjudged}" });
    await s("pending", "2026-10-31T12:00:10.000Z", "2026-10-31T12:03:10.000Z");
    // excluded 10 min; one under a second (counts nowhere); one wholly after the broadcast
    await s("excluded", "2026-10-31T12:30:00.000Z", "2026-10-31T12:40:00.000Z", { reasons: "{datacenter_ip}" });
    await s("excluded", "2026-10-31T12:30:00.000Z", "2026-10-31T12:30:00.900Z", { reasons: "{datacenter_ip}" });
    await s("excluded", "2026-10-31T14:00:00.000Z", "2026-10-31T14:10:00.000Z", { reasons: "{datacenter_ip}" });
  } finally {
    await sql.close();
  }
  const key = await importAttestationSigningKey(V.privateKeyPkcs8);
  await h.db.insert(schema.integritySigningKeys).values({ kid: key.kid, publicKey: key.publicKey });
  const signed = await sign(key, V.statement as Parameters<typeof sign>[1]);
  payload = signed.payload;
  entryId = uuidv7();
  await h.db.insert(schema.integrityAttestations).values({
    id: entryId,
    channelId,
    broadcastId,
    seq: 1,
    kind: "broadcast",
    kid: key.kid,
    payload: signed.payload,
    signature: signed.signature,
    entryHash: await entryHash(signed),
    signedAt: new Date(V.statement.signedAt),
    breakdown: V.reasons.breakdown,
    salt: V.reasons.salt,
  });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await t?.drop();
});

describe("readVerdictSeconds", () => {
  test("classifies and clips like the rollup", async () => {
    expect(await readVerdictSeconds(t.url, broadcastId)).toEqual({
      // 1800 + (12:05:00.000 - 12:00:00.000 = 300) + (13:00:00.000 - 12:59 = 60) + 2
      verified: 1800 + 300 + 60 + 2,
      unverified: 60 + 120 + 180,
      excluded: 600,
    });
  });

  test("a broadcast with no sessions reads as zeros", async () => {
    expect(await readVerdictSeconds(t.url, uuidv7())).toEqual({ verified: 0, unverified: 0, excluded: 0 });
  });
});

describe("entries", () => {
  test("readEntries returns the broadcast's chain", async () => {
    const rows = await readEntries(t.url, broadcastId);
    expect(rows).toEqual([
      expect.objectContaining({ id: entryId, seq: 1, kind: "broadcast", payload, entryHash: V.entryHash }),
    ]);
  });

  test("the append-only trigger refuses a rewrite, and the row is unchanged", async () => {
    const refusal = await tryRewriteStoredRow(t.url, entryId, tamperedPayload(payload));
    expect(refusal).toMatch(/append-only|permission/);
    const [row] = await readEntries(t.url, broadcastId);
    expect(row?.payload).toBe(payload);
  });
});
