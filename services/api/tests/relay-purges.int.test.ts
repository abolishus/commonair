// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed relay purge feed (batch 7 decision (x), ADR 0016 Amendment 1 A1.2): relay bearer
 * auth, paging, the signature, the hold and its early wake on a nudge, and the reset for a
 * cursor below the cleanup watermark (or above every seq this database issued).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { RELAY_PURGE_RULES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { RelayPurgeBatch, RelayPurgeFeed } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex, verifyPurgeBatch, type PurgeBatch } from "@commonair/tokens";
import {
  closeRelayPurgeFeed,
  POLL_FALLBACK_MS,
  RELAY_PURGE_NUDGE_CHANNEL,
  RELAY_PURGE_WATERMARK_KEY,
} from "../src/relay/purges.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let token: string;
let retiredToken: string;

async function relayRow(ownerId: string, retired = false): Promise<string> {
  const t = randomSecret("relay_");
  await api.db.db.insert(schema.relayNodes).values({
    id: uuidv7(),
    ownerId,
    name: `purge relay ${t.slice(-6)}`,
    publicUrl: "http://relay-test.invalid:8080",
    declaredCapacityMbps: 100,
    publicKey: "k",
    tokenHash: await sha256Hex(t),
    status: "suspended",
    ...(retired ? { retiredAt: new Date() } : {}),
  });
  return t;
}

beforeAll(async () => {
  api = await startApi();
  const owner = await signUpAndSignIn(api);
  // A suspended relay still gets purges: its cache must forget removed media too.
  token = await relayRow(owner.userId);
  retiredToken = await relayRow(owner.userId, true);
}, 120_000);
afterAll(async () => {
  if (api) await closeRelayPurgeFeed(api.deps);
  await api?.stop();
});

beforeEach(async () => {
  await api.db.sql`alter table relay_purges disable trigger relay_purges_guard`;
  await api.db.sql`delete from relay_purges`;
  await api.db.sql`alter table relay_purges enable trigger relay_purges_guard`;
  await api.deps.valkey.del(RELAY_PURGE_WATERMARK_KEY);
  // Short holds unless a test needs the default.
  await api.deps.valkey.set(KEYS.relayPurgeHold, "1");
});

async function insert(n: number, prefix = (_i: number) => `dvr/${uuidv7()}/`): Promise<number[]> {
  const rows = await api.db.db
    .insert(schema.relayPurges)
    .values(Array.from({ length: n }, (_, i) => ({ prefix: prefix(i), reason: "vod_hidden" as const })))
    .returning({ seq: schema.relayPurges.seq });
  return rows.map((r) => r.seq);
}

async function poll(after: number, bearer = token): Promise<{ status: number; batch?: PurgeBatch; ms: number }> {
  const started = performance.now();
  const r = await client(api, { bearer }).call<unknown>("GET", `/api/relay/purges?after=${after}`);
  const ms = performance.now() - started;
  if (r.status !== 200) return { status: r.status, ms };
  const feed = RelayPurgeFeed.parse(r.body);
  const v = await verifyPurgeBatch(api.deps.signingKey.publicKeyB64, feed);
  if (!v.ok) throw new Error(`feed answer does not verify: ${v.error}`);
  // The contracts mirror accepts it too.
  RelayPurgeBatch.parse(v.value);
  return { status: 200, batch: v.value, ms };
}

describe("auth", () => {
  test("relay bearer only: none, unknown and retired are 401", async () => {
    expect((await client(api).call("GET", "/api/relay/purges?after=0")).status).toBe(401);
    expect((await poll(0, "relay_nope")).status).toBe(401);
    expect((await poll(0, retiredToken)).status).toBe(401);
    const user = await signUpAndSignIn(api);
    expect((await user.client.call("GET", "/api/relay/purges?after=0")).status).toBe(401);
  });
});

describe("paging and signature", () => {
  test("rows after the cursor, oldest first, signed with the origin key; the cursor follows", async () => {
    const seqs = await insert(3);
    const first = await poll(0);
    expect(first.batch?.items.map((i) => i.seq)).toEqual(seqs);
    expect(first.batch?.seq).toBe(seqs[2]);
    expect(first.batch?.reset).toBeUndefined();
    expect(first.batch?.items[0]).toEqual({
      seq: seqs[0],
      prefix: expect.stringMatching(/^dvr\//),
      reason: "vod_hidden",
    });
    const mid = await poll(seqs[0]!);
    expect(mid.batch?.items.map((i) => i.seq)).toEqual(seqs.slice(1));
  });

  test(`at most ${RELAY_PURGE_RULES.maxItems} rows per answer; the rest on the next poll`, async () => {
    const seqs = await insert(RELAY_PURGE_RULES.maxItems + 1);
    const a = await poll(0);
    expect(a.batch?.items).toHaveLength(RELAY_PURGE_RULES.maxItems);
    expect(a.batch?.seq).toBe(seqs[RELAY_PURGE_RULES.maxItems - 1]);
    const b = await poll(a.batch!.seq);
    expect(b.batch?.items.map((i) => i.seq)).toEqual([seqs.at(-1)]);
  });

  test("a signature from another key does not verify", async () => {
    await insert(1);
    const r = await client(api, { bearer: token }).call<{ payload: string; signature: string }>(
      "GET",
      "/api/relay/purges?after=0",
    );
    const { generateSigningKey } = await import("@commonair/tokens");
    const other = await generateSigningKey();
    expect((await verifyPurgeBatch(other.key.publicKeyB64, r.body)).ok).toBe(false);
  });
});

describe("the hold", () => {
  test("nothing new: held for the hook's 1 s, then an empty batch at the same cursor", async () => {
    const [seq] = await insert(1);
    const r = await poll(seq!);
    expect(r.batch).toEqual({ seq, items: [] });
    expect(r.ms).toBeGreaterThanOrEqual(900);
    // Loaded runners: generous upper bound, still far below the 25 s default.
    expect(r.ms).toBeLessThan(5_000);
  });

  test("a nudge wakes a held poll at once (default 25 s hold)", async () => {
    await api.deps.valkey.del(KEYS.relayPurgeHold);
    const [seq] = await insert(1);
    const pending = poll(seq!);
    await Bun.sleep(300);
    const [next] = await insert(1);
    await api.deps.valkey.publish(RELAY_PURGE_NUDGE_CHANNEL, "1");
    const r = await pending;
    expect(r.batch?.items.map((i) => i.seq)).toEqual([next]);
    // Well under the fallback re-read: the nudge woke it.
    expect(r.ms).toBeLessThan(POLL_FALLBACK_MS - 500);
  });

  test("without a nudge a held poll still finds a new row on its fallback re-read", async () => {
    await api.deps.valkey.del(KEYS.relayPurgeHold);
    const [seq] = await insert(1);
    const pending = poll(seq!);
    await Bun.sleep(300);
    const [next] = await insert(1);
    const r = await pending;
    expect(r.batch?.items.map((i) => i.seq)).toEqual([next]);
    expect(r.ms).toBeLessThan(POLL_FALLBACK_MS + 3_000);
  }, 15_000);
});

describe("reset", () => {
  test("a cursor below the watermark gets a signed reset with the newest seq", async () => {
    const seqs = await insert(2);
    await api.deps.valkey.set(RELAY_PURGE_WATERMARK_KEY, String(seqs[0]));
    const r = await poll(seqs[0]! - 1);
    expect(r.batch).toEqual({ seq: seqs[1], items: [], reset: true });
    // At the watermark: nothing deleted after it was missed, so no reset.
    expect((await poll(seqs[0]!)).batch?.items.map((i) => i.seq)).toEqual([seqs[1]]);
  });

  test("everything deleted: the reset's seq is the watermark", async () => {
    await api.deps.valkey.set(RELAY_PURGE_WATERMARK_KEY, "1000");
    expect((await poll(3)).batch).toEqual({ seq: 1000, items: [], reset: true });
    // Then the relay is level: held, nothing to say.
    expect((await poll(1000)).batch).toEqual({ seq: 1000, items: [] });
  });

  test("a cursor past every issued seq (another database) gets a reset too", async () => {
    const [seq] = await insert(1);
    expect((await poll(seq! + 50)).batch).toEqual({ seq, items: [], reset: true });
    // An empty table and no watermark: a fresh relay at 0 is level.
    await api.db.sql`alter table relay_purges disable trigger relay_purges_guard`;
    await api.db.sql`delete from relay_purges`;
    await api.db.sql`alter table relay_purges enable trigger relay_purges_guard`;
    expect((await poll(0)).batch).toEqual({ seq: 0, items: [] });
  });
});
