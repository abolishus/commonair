// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Giveaway CR9 (batch 8, B8-web; contract step §3.4): `verify.me` is the signed-in caller's own
 * pseudonym, read from their `giveaway_entries` row, on any giveaway they entered (not only the
 * channel's current one); null for a non-entrant and for an anonymous caller; and neither the salt
 * nor any user id is ever in the answer.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import type { Caller } from "../src/lib/access.ts";
import { setGiveawayCloseQueue } from "../src/interact/giveaways/queue.ts";
import { verifyGiveaway } from "../src/interact/giveaways/service.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Verification {
  id: string;
  entries: string[];
  me: { pseudonym: string } | null;
}

let api: TestApi;
let streamer: Account;
let entrant: Account;
let other: Account;
let oldId: string;
let currentId: string;

const owner = () => api.db.db;
const base = () => `/api/channels/${streamer.username}/giveaways`;
const as = (a: Account): Pick<Caller, "user"> => ({ user: { id: a.userId } as Caller["user"] });

beforeAll(async () => {
  api = await startApi({ env: { GIVEAWAYS_ENABLED: "true" } });
  setGiveawayCloseQueue(api.deps, { async schedule() {}, async close() {} });
  [streamer, entrant, other] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const ok = async (what: string, call: Promise<{ status: number; body: unknown }>) => {
    const r = await call;
    if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const open = async (title: string) =>
    (
      (await ok("open", streamer.client.call("POST", base(), { title, prize: "Stickers", winnerCount: 1 }))) as {
        id: string;
      }
    ).id;
  oldId = await open("Last week");
  await ok("enter", entrant.client.call("POST", `/api/giveaways/${oldId}/entries`, {}));
  await ok("close", streamer.client.call("POST", `${base()}/${oldId}/close`, {}));
  await ok("draw", streamer.client.call("POST", `${base()}/${oldId}/draw`, {}));
  // A newer giveaway is the channel's current one now.
  currentId = await open("This week");
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

async function pseudonymOf(account: Account, giveawayId: string): Promise<string> {
  const [row] = await owner()
    .select({ pseudonym: schema.giveawayEntries.pseudonym })
    .from(schema.giveawayEntries)
    .where(and(eq(schema.giveawayEntries.giveawayId, giveawayId), eq(schema.giveawayEntries.userId, account.userId)));
  if (!row) throw new Error("no entry");
  return row.pseudonym;
}

describe("verify.me", () => {
  test("an entrant gets their own pseudonym on a giveaway that is not the current one", async () => {
    const v = await verifyGiveaway(api.deps, streamer.username, oldId, as(entrant));
    const mine = await pseudonymOf(entrant, oldId);
    expect(v.me).toEqual({ pseudonym: mine });
    expect(v.entries).toContain(mine);
    // The current giveaway has no entry of theirs.
    expect((await verifyGiveaway(api.deps, streamer.username, currentId, as(entrant))).me).toBeNull();
  });

  test("null for a non-entrant and for an anonymous caller", async () => {
    expect((await verifyGiveaway(api.deps, streamer.username, oldId, as(other))).me).toBeNull();
    expect((await verifyGiveaway(api.deps, streamer.username, oldId, null)).me).toBeNull();
    expect((await verifyGiveaway(api.deps, streamer.username, oldId)).me).toBeNull();
    const anon = await client(api).call<Verification>("GET", `${base()}/${oldId}/verify`);
    expect(anon.status).toBe(200);
    expect(anon.body.me).toBeNull();
  });

  test("never the salt, never a user id", async () => {
    const [g] = await owner()
      .select({ salt: schema.giveaways.salt })
      .from(schema.giveaways)
      .where(eq(schema.giveaways.id, oldId));
    const answers = [
      await verifyGiveaway(api.deps, streamer.username, oldId, as(entrant)),
      (await entrant.client.call<Verification>("GET", `${base()}/${oldId}/verify`)).body,
      (await client(api).call<Verification>("GET", `${base()}/${oldId}/verify`)).body,
    ];
    for (const v of answers) {
      const text = JSON.stringify(v);
      expect(Object.keys(v)).not.toContain("salt");
      expect(text).not.toContain(g!.salt);
      expect(text).not.toContain(entrant.userId);
      expect(text).not.toContain(entrant.username);
    }
  });
});
