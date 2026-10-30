// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data export build, mail and expiry against the stack's Postgres (as the app role), Valkey,
 * Garage and Mailpit (docs/testing/e6-selectors.md "Data export").
 */
import { loadEnv, mailEnv } from "@commonair/config";
import { EXPORT_TTL_SECONDS, exportObjectKey } from "@commonair/contracts/internal";
import { schema, seedLegalDocuments, uuidv7 } from "@commonair/db";
import { createMailer, MemoryMailer } from "@commonair/email";
import type { ObjectStorage } from "@commonair/storage";
import { encryptSecret, randomSecret, sha256Hex } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { buildExport, cleanupExports, exportDownloadLink, STALE_RUNNING_MS } from "../src/exports/build.ts";
import { MANIFEST } from "../src/exports/archive.ts";
import { AUTH_SECRET, makeApp, makeUser, setup, type TestEnv } from "./fixtures.ts";
import { EXPORTS_BUCKET, hrefs, mailTo, s3PublicOrigin, siteAt, stackStorage, tip } from "./e6-fixtures.ts";

const storage = stackStorage();
// The web origin differs from the storage origin, as on the real stack: the presigned link is
// mailed only because `storageOrigin` reaches both the mailer and (through createWorker) the job.
const WEB_ORIGIN = "http://localhost:3100";
const storageOrigin = storage ? s3PublicOrigin() : undefined;
const mailer = createMailer(loadEnv(mailEnv), {
  site: siteAt(WEB_ORIGIN),
  ...(storageOrigin ? { storageOrigin } : {}),
});
let env: TestEnv;

describe.skipIf(!storage)("data export", () => {
  const S3 = storage as ObjectStorage;
  const site = siteAt(WEB_ORIGIN);

  beforeAll(async () => {
    env = await setup({
      jobs: [],
      outbox: false,
      segments: false,
      storage: S3,
      exportsBucket: EXPORTS_BUCKET,
      mailer,
      site,
      ...(storageOrigin ? { storageOrigin } : {}),
    });
    // Services connect as the least-privilege role: so does the code under test.
    env.worker.ctx.db = env.t.app.db;
    env.worker.ctx.sql = env.t.app.sql;
  });
  afterAll(async () => {
    await env?.close();
    await mailer.close();
  });

  const ctx = (): WorkerContext => env.worker.ctx;
  const db = () => env.t.db;

  /** Secrets seeded for a user: none of these strings may appear in any archive. */
  async function seedSecrets(userId: string, channelId: string) {
    const out: string[] = [];
    const sessionToken = randomSecret("sess_");
    await db()
      .insert(schema.sessions)
      .values({
        id: uuidv7(),
        userId,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 3_600_000),
        ipAddress: "203.0.113.7",
        userAgent: "ua-own",
      });
    const password = `scrypt$${randomSecret()}`;
    await db()
      .insert(schema.accounts)
      .values({
        id: uuidv7(),
        userId,
        accountId: userId,
        providerId: "credential",
        password,
        accessToken: randomSecret("at_"),
      });
    const totp = randomSecret("totp_");
    await db()
      .insert(schema.twoFactors)
      .values({ id: uuidv7(), userId, secret: totp, backupCodes: randomSecret("bc_") });
    const streamKey = randomSecret("live_");
    const streamKeyHash = await sha256Hex(streamKey);
    await db()
      .insert(schema.streamKeys)
      .values({ id: uuidv7(), channelId, keyHash: streamKeyHash, prefix: streamKey.slice(0, 8) });
    const simulcastKey = randomSecret("sk_");
    const simulcastCipher = await encryptSecret(AUTH_SECRET, "simulcast", simulcastKey);
    await db().insert(schema.simulcastTargets).values({
      id: uuidv7(),
      channelId,
      platform: "custom",
      name: "mirror",
      rtmpUrl: "rtmp://mirror.example.test/live",
      streamKeyCiphertext: simulcastCipher,
    });
    const app = await makeApp(db(), userId);
    const botToken = randomSecret("ca_");
    const botTokenHash = await sha256Hex(botToken);
    await db()
      .insert(schema.oauthTokens)
      .values({
        id: uuidv7(),
        appId: null,
        userId,
        scopes: ["chat:read"],
        accessTokenHash: botTokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    const webhookSecret = randomSecret("whsec_");
    const webhookCipher = await encryptSecret(AUTH_SECRET, "webhook", webhookSecret);
    await db()
      .insert(schema.eventSubscriptions)
      .values({
        id: uuidv7(),
        userId,
        appId: app.id,
        type: "channel.follow",
        condition: { broadcaster_user_id: userId },
        transport: "webhook",
        callbackUrl: "https://hooks.example.test/cb",
        secretCiphertext: webhookCipher,
      });
    out.push(sessionToken, password, totp, streamKey, streamKeyHash, simulcastKey, simulcastCipher);
    out.push(botToken, botTokenHash, webhookSecret, webhookCipher, app.clientId, app.clientSecretHash!);
    return out;
  }

  /** An audit row and the statement of reasons it produced (a T1 restriction on the user's channel). */
  async function seedStatement(userId: string, channelId: string): Promise<string> {
    await seedLegalDocuments(db());
    const docs = await db()
      .select({ id: schema.legalDocuments.id, kind: schema.legalDocuments.kind })
      .from(schema.legalDocuments);
    const docId = (kind: string) => docs.find((d) => d.kind === kind)?.id ?? "";
    const auditId = uuidv7();
    const caseId = uuidv7();
    const at = new Date();
    await db().insert(schema.auditLog).values({
      id: auditId,
      actorType: "system",
      action: "moderation.t1.restrict",
      subjectType: "moderation_case",
      subjectId: caseId,
      channelId,
      details: { caseId },
      createdAt: at,
    });
    const id = uuidv7();
    await db()
      .insert(schema.enforcementStatements)
      .values({
        id,
        sourceAuditId: auditId,
        sourceAction: "moderation.t1.restrict",
        recipientUserId: userId,
        channelId,
        contentType: "broadcast",
        contentId: uuidv7(),
        restrictionKind: "visibility",
        restrictionDetail: "restricted",
        facts: { code: "classifier", category: "weapons", tier: "t1", threshold: 0.95, capturedAt: at.toISOString() },
        source: "own_initiative",
        automatedDetection: true,
        automatedDecision: "fully",
        groundKind: "terms",
        clauseId: "safety.weapons",
        clauseVersion: 1,
        guidelinesDocumentId: docId("guidelines"),
        noticeDocumentId: docId("enforcement_notice"),
        appealSubjectType: "moderation_case",
        appealSubjectId: caseId,
        createdAt: at,
      });
    return id;
  }

  async function requestExport(userId: string, kind: "account" | "channel") {
    const id = uuidv7();
    await env.t.app.db.insert(schema.dataExports).values({ id, userId, kind });
    return id;
  }

  const exportRow = async (id: string) =>
    (await db().select().from(schema.dataExports).where(eq(schema.dataExports.id, id)))[0];

  async function archive(userId: string, id: string) {
    const res = await S3.get(EXPORTS_BUCKET, exportObjectKey(userId, id));
    if (!res) throw new Error("archive missing");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(bytes);
    const text = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
    return {
      bytes,
      files: text,
      all: Object.values(text).join("\n"),
      json: (n: string) => JSON.parse(text[n] ?? "null"),
    };
  }

  test("both kinds: the requester's own rows, nothing of the other user, no secret; mailed and expired", async () => {
    // U follows, chats with and tips S; V follows, chats in and tips U's channel; U reports V.
    const U = await makeUser(db());
    const S = await makeUser(db());
    const V = await makeUser(db());
    const uChat = `u says ${randomSecret()}`;
    const vChat = `v says ${randomSecret()}`;
    const uTipMsg = `u tip ${randomSecret()}`;
    const vTipMsg = `v tip ${randomSecret()}`;
    await db()
      .insert(schema.follows)
      .values([
        { followerId: U.user.id, channelId: S.channel.id },
        { followerId: V.user.id, channelId: U.channel.id },
      ]);
    await db()
      .insert(schema.chatMessages)
      .values([
        { id: uuidv7(), channelId: S.channel.id, userId: U.user.id, body: uChat },
        { id: uuidv7(), channelId: U.channel.id, userId: V.user.id, body: vChat },
      ]);
    await tip(db(), {
      from: U.user.id,
      channelId: S.channel.id,
      creatorUserId: S.user.id,
      cents: 500,
      message: uTipMsg,
    });
    await tip(db(), {
      from: V.user.id,
      channelId: U.channel.id,
      creatorUserId: U.user.id,
      cents: 700,
      message: vTipMsg,
    });
    await db()
      .insert(schema.reports)
      .values({
        id: uuidv7(),
        reporterId: U.user.id,
        subjectType: "user",
        subjectId: V.user.id,
        reason: "spam",
        details: "they keep posting",
        evidence: { text: vChat, userId: V.user.id },
      });
    await db()
      .insert(schema.modActions)
      .values({
        id: uuidv7(),
        scope: "channel",
        channelId: U.channel.id,
        moderatorId: U.user.id,
        targetUserId: V.user.id,
        action: "timeout",
        reason: `about ${V.user.name}`,
        durationSeconds: 60,
      });
    await db()
      .insert(schema.sessions)
      .values({
        id: uuidv7(),
        userId: V.user.id,
        token: randomSecret(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ipAddress: "198.51.100.9",
      });
    // W1: U blocked S and W; V's block of U and of W are V's, not U's.
    const W = await makeUser(db());
    await db()
      .insert(schema.userBlocks)
      .values([
        { userId: U.user.id, blockedUserId: S.user.id, createdAt: new Date(Date.now() - 2000) },
        { userId: U.user.id, blockedUserId: W.user.id, createdAt: new Date(Date.now() - 1000) },
        { userId: V.user.id, blockedUserId: U.user.id },
        { userId: V.user.id, blockedUserId: W.user.id },
      ]);
    const secrets = [...(await seedSecrets(U.user.id, U.channel.id)), ...(await seedSecrets(V.user.id, V.channel.id))];
    // A statement of reasons about U and one about V (W0-sor): U's archive holds U's only.
    const uStatement = await seedStatement(U.user.id, U.channel.id);
    await seedStatement(V.user.id, V.channel.id);

    const accountId = await requestExport(U.user.id, "account");
    const channelId = await requestExport(U.user.id, "channel");
    const before = Date.now();
    expect(await buildExport(ctx(), accountId, { lastAttempt: false })).toMatchObject({ built: 1, emailed: 1 });
    expect(await buildExport(ctx(), channelId, { lastAttempt: false })).toMatchObject({ built: 1, emailed: 1 });
    // A job for a row that is no longer queued is a no-op.
    expect(await buildExport(ctx(), accountId, { lastAttempt: true })).toEqual({ skipped: 1 });

    const row = await exportRow(accountId);
    expect(row).toMatchObject({ status: "ready", storageKey: exportObjectKey(U.user.id, accountId), error: null });
    expect(row?.completedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((row?.expiresAt?.getTime() ?? 0) - (row?.completedAt?.getTime() ?? 0)).toBe(EXPORT_TTL_SECONDS * 1000);

    const acc = await archive(U.user.id, accountId);
    expect(row?.sizeBytes).toBe(acc.bytes.byteLength);
    const accountFiles = [
      "account.json",
      "sessions.json",
      "connections.json",
      "follows.json",
      "subscriptions.json",
      "payments.json",
      "tips.json",
      "chat.json",
      "coop.json",
      "safety.json",
      "enforcement_statements.json",
      "notifications.json",
      "consents.json",
      "developer.json",
      "interact.json",
      "blocks.json",
    ];
    expect(Object.keys(acc.files).sort()).toEqual([...accountFiles, MANIFEST].sort());
    expect(acc.json("enforcement_statements.json")).toEqual([
      expect.objectContaining({
        id: uStatement,
        sourceAction: "moderation.t1.restrict",
        restrictionKind: "visibility",
        restrictionDetail: "restricted",
        clauseId: "safety.weapons",
        clauseVersion: 1,
        appealSubjectType: "moderation_case",
      }),
    ]);
    expect(Object.keys((acc.json("enforcement_statements.json") as object[])[0] ?? {})).not.toContain("moderatorNote");
    expect(acc.json(MANIFEST)).toMatchObject({ kind: "account", exportId: accountId, userId: U.user.id });
    expect(acc.json("blocks.json")).toEqual([
      { username: S.user.username, blockedAt: expect.any(String) },
      { username: W.user.username, blockedAt: expect.any(String) },
    ]);
    expect((acc.json(MANIFEST) as { files: { name: string }[] }).files.map((f) => f.name)).toEqual(accountFiles);
    expect(acc.json("account.json")).toMatchObject({
      id: U.user.id,
      email: U.user.email,
      username: U.user.username,
      twoFactorEnabled: false,
    });
    expect(acc.json("chat.json")).toEqual([
      expect.objectContaining({ channelSlug: S.channel.slug, body: uChat, deleted: false }),
    ]);
    expect(acc.json("follows.json")).toEqual([expect.objectContaining({ channelSlug: S.channel.slug })]);
    expect(acc.json("tips.json")).toEqual([
      expect.objectContaining({ channelSlug: S.channel.slug, amountCents: 500, currency: "usd", message: uTipMsg }),
    ]);
    expect(acc.json("payments.json")).toEqual([
      expect.objectContaining({ kind: "tip", channelSlug: S.channel.slug, amountCents: 500, disputes: [] }),
    ]);
    expect(acc.json("sessions.json")).toEqual([
      expect.objectContaining({ ipAddress: "203.0.113.7", userAgent: "ua-own" }),
    ]);
    expect(acc.json("connections.json")).toEqual([expect.objectContaining({ providerId: "credential" })]);
    expect((acc.json("safety.json") as { reports: unknown[] }).reports).toEqual([
      expect.objectContaining({ reason: "spam", status: "open" }),
    ]);
    expect((acc.json("developer.json") as { webhooks: unknown[] }).webhooks).toEqual([
      expect.objectContaining({ callbackUrl: "https://hooks.example.test/cb" }),
    ]);

    const ch = await archive(U.user.id, channelId);
    const channelFiles = [
      "channel.json",
      "vods.json",
      "clips.json",
      "revenue.json",
      "payouts.json",
      "moderation-actions.json",
    ];
    expect(Object.keys(ch.files).sort()).toEqual([...channelFiles, MANIFEST].sort());
    expect((ch.json("channel.json") as { settings: unknown }).settings).toMatchObject({ slug: U.channel.slug });
    expect((ch.json("channel.json") as { simulcastTargets: unknown[] }).simulcastTargets).toEqual([
      expect.objectContaining({ name: "mirror", rtmpUrl: "rtmp://mirror.example.test/live" }),
    ]);
    expect(ch.json("revenue.json")).toEqual([
      expect.objectContaining({ kind: "tip", grossCents: 700, netCents: 700, currency: "usd", status: "succeeded" }),
    ]);
    expect(ch.json("moderation-actions.json")).toEqual([
      expect.objectContaining({ action: "timeout", durationSeconds: 60 }),
    ]);

    // Nothing of V anywhere, in either archive (V's channel slug is V's username, so it is absent too).
    for (const a of [acc, ch]) {
      for (const needle of [
        V.user.id,
        V.user.email,
        V.user.username,
        V.user.name,
        V.channel.id,
        vChat,
        vTipMsg,
        "198.51.100.9",
      ])
        expect(a.all).not.toContain(needle);
      for (const secret of secrets) expect(a.all).not.toContain(secret);
    }

    // The mail: a presigned link to exactly this archive, valid until expires_at, that downloads it.
    const mail = await mailTo(U.user.email);
    const link = hrefs(mail.html).find(
      (h) => h.includes(exportObjectKey(U.user.id, accountId)) || h.includes(exportObjectKey(U.user.id, channelId)),
    );
    expect(link).toBeDefined();
    const url = new URL(link ?? "");
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(EXPORT_TTL_SECONDS);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(EXPORT_TTL_SECONDS - 120);
    const download = await fetch(url);
    expect(download.status).toBe(200);
    const zipped = new Uint8Array(await download.arrayBuffer());
    expect(Object.keys(unzipSync(zipped))).toContain(MANIFEST);
    // One changed signature byte is refused.
    const sig = url.searchParams.get("X-Amz-Signature") ?? "";
    url.searchParams.set("X-Amz-Signature", `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`);
    expect((await fetch(url)).status).toBe(403);

    // Expiry: cleanup deletes the archive and marks the export expired; the link stops working.
    await db()
      .update(schema.dataExports)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.dataExports.id, accountId));
    expect(await cleanupExports(ctx(), { sweepPrefix: `exports/${U.user.id}/` })).toMatchObject({
      expired: 1,
      failed: 0,
    });
    expect(await exportRow(accountId)).toMatchObject({ status: "expired", storageKey: null });
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(U.user.id, accountId))).toBeNull();
    expect(await exportRow(channelId)).toMatchObject({ status: "ready" });
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(U.user.id, channelId))).not.toBeNull();
    expect(await cleanupExports(ctx(), { sweepPrefix: `exports/${U.user.id}/` })).toMatchObject({ expired: 0 });
    await S3.delete(EXPORTS_BUCKET, exportObjectKey(U.user.id, channelId));
  });

  test("off-origin storage: the mail links the instance's privacy page instead", async () => {
    const memory = new MemoryMailer({ site: siteAt("http://instance.example.test") });
    // No storage origin configured: only the instance's own origin may be mailed.
    const { storageOrigin: _configured, ...base } = ctx();
    const c: WorkerContext = { ...base, mailer: memory, site: siteAt("http://instance.example.test") };
    const link = await exportDownloadLink(c, {
      id: uuidv7(),
      userId: uuidv7(),
      kind: "account",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(link).toBe("http://instance.example.test/settings/privacy");
    expect(
      await exportDownloadLink(c, {
        id: uuidv7(),
        userId: uuidv7(),
        kind: "account",
        expiresAt: new Date(Date.now() - 1),
      }),
    ).toBeNull();
  });

  test("failures: deleted user, channel export without a channel, retries then a stable code", async () => {
    const gone = await makeUser(db());
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.user.id));
    const a = await requestExport(gone.user.id, "account");
    expect(await buildExport(ctx(), a, { lastAttempt: false })).toEqual({ failed: 1 });
    expect(await exportRow(a)).toMatchObject({ status: "failed", error: "user_deleted", storageKey: null });

    const [noChannel] = await db()
      .insert(schema.users)
      .values({ id: uuidv7(), name: "nc", email: `nc-${uuidv7()}@example.test`, username: `nc${Date.now()}` })
      .returning();
    const b = await requestExport(noChannel?.id ?? "", "channel");
    expect(await buildExport(ctx(), b, { lastAttempt: false })).toEqual({ failed: 1 });
    expect(await exportRow(b)).toMatchObject({ status: "failed", error: "no_channel" });

    const ok = await makeUser(db());
    const c = await requestExport(ok.user.id, "account");
    const broken = { ...S3, put: async () => Promise.reject(new Error("S3 503")) } as ObjectStorage;
    const failing: WorkerContext = { ...ctx(), storage: broken, mailer: undefined };
    await expect(buildExport(failing, c, { lastAttempt: false })).rejects.toThrow(/503/);
    // Handed back for the retry.
    expect(await exportRow(c)).toMatchObject({ status: "queued", error: null });
    expect(await buildExport(failing, c, { lastAttempt: true })).toEqual({ failed: 1 });
    expect(await exportRow(c)).toMatchObject({ status: "failed", error: "build_failed", storageKey: null });
  });

  test("cleanup sweeps archives whose export row is gone", async () => {
    const u = await makeUser(db());
    const id = uuidv7();
    const key = exportObjectKey(u.user.id, id);
    await S3.put(EXPORTS_BUCKET, key, new Uint8Array([1, 2, 3]));
    const live = await requestExport(u.user.id, "account");
    await S3.put(EXPORTS_BUCKET, exportObjectKey(u.user.id, live), new Uint8Array([4]));
    const r = await cleanupExports(ctx(), { sweepPrefix: `exports/${u.user.id}/` });
    expect(r.orphans).toBeGreaterThanOrEqual(1);
    expect(await S3.head(EXPORTS_BUCKET, key)).toBeNull();
    // A queued export's archive (a build in flight) is kept.
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(u.user.id, live))).not.toBeNull();
    await S3.delete(EXPORTS_BUCKET, exportObjectKey(u.user.id, live));
  });

  test("a build abandoned in `running` (worker killed after the claim) is failed by cleanup, archive and all", async () => {
    const u = await makeUser(db());
    const stale = await requestExport(u.user.id, "account");
    const fresh = await requestExport(u.user.id, "account");
    const longAgo = new Date(Date.now() - STALE_RUNNING_MS - 60_000);
    await db()
      .update(schema.dataExports)
      .set({ status: "running", createdAt: longAgo })
      .where(eq(schema.dataExports.id, stale));
    await db().update(schema.dataExports).set({ status: "running" }).where(eq(schema.dataExports.id, fresh));
    // The killed worker had already uploaded.
    await S3.put(EXPORTS_BUCKET, exportObjectKey(u.user.id, stale), new Uint8Array([1]));
    // BullMQ's re-delivery cannot claim it.
    expect(await buildExport(ctx(), stale, { lastAttempt: false })).toEqual({ skipped: 1 });

    const r = await cleanupExports(ctx(), { sweepPrefix: `exports/${u.user.id}/` });
    expect(r.abandoned).toBe(1);
    expect(await exportRow(stale)).toMatchObject({ status: "failed", error: "build_failed", storageKey: null });
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(u.user.id, stale))).toBeNull();
    // A build still in its window is left alone.
    expect(await exportRow(fresh)).toMatchObject({ status: "running" });
  });
});
