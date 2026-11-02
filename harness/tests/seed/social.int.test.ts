// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's direct-insert writers against a migrated database, as the app role: the rows land,
 * the triggers accept them (follower counts are the trigger's), better-auth's credential row
 * verifies, and nothing personal reaches the append-only audit log. The API steps (emotes through
 * the upload pipeline, move links, grants) are exercised by `seed full` live.
 */
import { schema, seedLegalDocuments, uuidv7 } from "@commonair/db";
import { verifyPassword, hashPassword } from "@commonair/db/demo";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { unsafeFilterRegexReason } from "../../../packages/safe-regex/src/index.ts";
import { createRng } from "../../src/seed/prng.ts";
import type { SeedScale } from "../../src/seed/scale.ts";
import { planCounts, planSocial, type SocialPlan } from "../../src/seed/social/plan.ts";
import { type EmoteDef, type SocialIds, writeChat, writeSocialBase } from "../../src/seed/social/write.ts";

const PASSWORD = "seed-social-int-password";
const SCALE: SeedScale = { streamers: 3, viewers: 12, chatLines: 400, historyDays: 45, factor: 1 };

let t: TestDatabase;
let plan: SocialPlan;
let ids: SocialIds;
let rows: Record<string, number>;
let base: Awaited<ReturnType<typeof writeSocialBase>>;
let chatWritten = 0;

beforeAll(async () => {
  t = await createTestDatabase();
  // Test templates skip the legal drafts (only the migrate job seeds them); the base seed does it live.
  await seedLegalDocuments(t.db);
  plan = planSocial(createRng(11).fork("social"), SCALE, new Date());
  const passwordHash = await hashPassword(PASSWORD);
  base = await writeSocialBase(t.app, plan, { passwordHash });
  ids = base.ids;
  rows = base.rows;
  // What the API step would return: streamer1's emotes, inserted directly here (no media bucket).
  const s1 = plan.channels.find((c) => c.ownerHandle === "streamer1");
  const cid = ids.channels.get("streamer1") ?? "";
  const defs = new Map<string, EmoteDef>();
  for (const e of s1?.emotes ?? []) {
    const id = uuidv7();
    await t.app.db
      .insert(schema.emotes)
      .values({ id, channelId: cid, code: e.code, imageKey: `channels/${cid}/emote/${id}.png`, tier: e.tier });
    defs.set(e.code, { id, code: e.code, tier: e.tier });
  }
  chatWritten = await writeChat(t.app, plan, ids, new Map([["streamer1", defs]]), createRng(11).fork("lines"));
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const count = async (table: string) =>
  Number((await t.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]?.n ?? 0);

describe("writeSocialBase", () => {
  test("every planned row lands, and the reported counts are the table counts", async () => {
    const want = planCounts(plan);
    for (const table of [
      "users",
      "accounts",
      "channels",
      "channel_panels",
      "channel_sub_tiers",
      "word_filters",
      "channel_roles",
      "follows",
      "user_blocks",
      "chat_bans",
      "sessions",
      "two_factors",
      "passkeys",
      "consent_records",
    ]) {
      expect(await count(table), table).toBe(want[table]);
      expect(rows[table], table).toBe(want[table]);
    }
    expect(await count("stream_keys")).toBe(want.streamerChannels);
    expect(await count("categories")).toBe(plan.categories.length);
    expect(await count("events")).toBe(0);
  });

  test("the demo anchors hold for every user; the bot is a bot owned by streamer1", async () => {
    const users = await t.app.db.select().from(schema.users);
    for (const u of users) {
      expect(u.username.startsWith("demo_"), u.username).toBe(true);
      expect(u.email.endsWith("@demo-seed.invalid"), u.email).toBe(true);
    }
    const bot = users.find((u) => u.username === "demo_bot1");
    expect(bot?.accountType).toBe("bot");
    expect(bot?.botOwnerId).toBe(ids.users.get("streamer1"));
    expect(bot?.emailVerified).toBe(false);
    for (const u of users.filter((x) => x.accountType === "human")) expect(u.emailVerified).toBe(true);
    expect(users.find((u) => u.username === "demo_admin")?.role).toBe("admin");
    expect(users.find((u) => u.username === "demo_treasurer")?.role).toBe("treasurer");
    expect(users.find((u) => u.username === "demo_banned")?.banned).toBe(false);
    for (const u of users) expect(u.twoFactorEnabled).toBe(false);
  });

  test("one shared password hash that better-auth's verifier accepts; the bot has no credential", async () => {
    const accounts = await t.app.db.select().from(schema.accounts);
    expect(new Set(accounts.map((a) => a.password)).size).toBe(1);
    for (const a of accounts) {
      expect(a.providerId).toBe("credential");
      expect(a.accountId).toBe(a.userId);
    }
    expect(await verifyPassword(accounts[0]?.password ?? "", PASSWORD)).toBe(true);
    expect(await verifyPassword(accounts[0]?.password ?? "", "wrong-password")).toBe(false);
    expect(accounts.some((a) => a.userId === ids.users.get("bot1"))).toBe(false);
  });

  test("the follows trigger keeps every follower count", async () => {
    const channels = await t.app.db.select().from(schema.channels);
    for (const c of channels) {
      const owner = [...ids.channels].find(([, id]) => id === c.id)?.[0] ?? "";
      expect(c.followerCount, owner).toBe(plan.follows.filter((f) => f.channel === owner).length);
    }
  });

  test("legal acceptances of every current required document for every human", async () => {
    expect(base.notes).toEqual([]);
    const docs = (await t.app.db.select().from(schema.legalDocuments)).filter((d) => d.requiresAcceptance);
    const kinds = new Set(docs.map((d) => d.kind));
    const humans = plan.accounts.filter((a) => a.kind !== "bot").length;
    expect(await count("legal_acceptances")).toBe(humans * kinds.size);
    const consents = await t.app.db.select().from(schema.consentRecords);
    for (const c of consents) {
      expect(c.choices.essential).toBe(true);
      expect((c.userId === null) === (c.anonymousId !== null)).toBe(true);
    }
  });

  test("streamer1's regex filter passes the API's validator as stored", async () => {
    const filters = await t.app.db.select().from(schema.wordFilters);
    const regex = filters.filter((f) => f.isRegex);
    expect(regex.length).toBeGreaterThan(0);
    for (const f of regex) expect(unsafeFilterRegexReason(f.pattern)).toBeNull();
  });

  test("audit and mod-action rows: ids and enums only, nothing personal", async () => {
    const audit = await t.app.db.select().from(schema.auditLog);
    const want =
      plan.bans.length +
      plan.roles.length +
      (planCounts(plan).streamerChannels ?? 0) +
      (planCounts(plan).word_filters ?? 0);
    expect(audit).toHaveLength(want);
    const personal = plan.accounts.flatMap((a) => [a.email, a.username, a.displayName]);
    const text = JSON.stringify(audit);
    for (const p of personal) expect(text.includes(p), p).toBe(false);
    for (const a of audit) {
      expect(a.reason).toBe("");
      const strings = Object.values(a.details)
        .flat()
        .filter((v): v is string => typeof v === "string");
      for (const v of strings) expect(v).toMatch(/^[0-9a-f-]{36}$|^[a-z_]{1,32}$/);
    }
    const mods = await t.app.db.select().from(schema.modActions);
    expect(mods.some((m) => m.action === "timeout")).toBe(true);
    expect(mods.some((m) => m.action === "add_moderator")).toBe(true);
    for (const m of mods) expect(m.reason).toBe("");
    const bans = await t.app.db.select().from(schema.chatBans);
    const viewer2 = bans.find((b) => b.userId === ids.users.get("viewer2"));
    expect((viewer2?.expiresAt?.getTime() ?? 0) > Date.now()).toBe(true);
  });
});

describe("writeChat", () => {
  test("every line lands with backdated times, resolved replies and emote ranges", async () => {
    expect(chatWritten).toBe(SCALE.chatLines);
    const msgs = await t.app.db.select().from(schema.chatMessages);
    expect(msgs).toHaveLength(SCALE.chatLines);
    const byId = new Set(msgs.map((m) => m.id));
    for (const m of msgs) {
      expect(m.createdAt.getTime()).toBeLessThan(Date.now());
      expect(m.replyToId === null || byId.has(m.replyToId)).toBe(true);
      for (const r of m.emotes) expect(m.body.slice(r.start, r.end)).toBe(r.code);
      expect(m.broadcastId).toBeNull();
    }
    expect(msgs.some((m) => m.emotes.length > 0)).toBe(true);
    expect(msgs.filter((m) => m.heldAt !== null)).toHaveLength(2);
    expect(msgs.filter((m) => m.body.includes("fr*ck"))).toHaveLength(2);
  });
});
