// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W3-portability against the stack's Postgres, Garage and the real API (ADR 0037):
 *
 * - the moved notice: one email per grant holder (List-Unsubscribe, the `moved` list), the grants
 *   deleted, nothing for the streamer, a deleted or unverified holder, or a cleared move;
 * - a bundle round trip: `buildBundle` from one channel, then `applyBundle` into another, every
 *   image through the API's real `INTERNAL_ROUTES.uploadCommit` (a T0 fixture emote is refused
 *   and enqueues the T0 job); a clashing code is skipped; the mature label is never cleared; a
 *   retry inserts nothing twice;
 * - the statement gates through the worker's preview: a verified `activeSuspension` refuses, a
 *   legal hold on the importer refuses, an expired statement imports as unverified.
 */
import { ACCOUNT_ACTION_REVERSALS } from "@commonair/contracts/enums";
import { MODERATION_JOBS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { MemoryMailer, TEMPLATE_IDS } from "@commonair/email";
import { importStandingSigningKey, type StandingSigningKey } from "@commonair/tokens/standing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
// The real API, so images go through its upload pipeline exactly as in production (decision (p)).
import { startModeration } from "../../api/src/moderation/index.ts";
import { recordingQueue } from "../../api/src/moderation/queue.ts";
import { signUpAndSignIn, startApi, type TestApi } from "../../api/tests/harness.ts";
import { commitUpload } from "../src/b7/upload-commit.ts";
import type { WorkerContext } from "../src/context.ts";
import { buildBundle } from "../src/exports/bundle.ts";
import { readBundleArchive } from "../src/portability/archive.ts";
import { applyBundle, runImportJob, type StoredItem } from "../src/portability/import/index.ts";
import { sendMovedNotices } from "../src/portability/moved.ts";
import { standingFacts } from "../src/portability/standing.ts";
import { siteAt, stackStorage } from "./e6-fixtures.ts";
import { AUTH_SECRET, fastWebhooks, quietLogger } from "./fixtures.ts";

const FIXTURES = new URL("../../../packages/moderation/fixtures/", import.meta.url);
const fixture = async (name: string) => new Uint8Array(await Bun.file(new URL(name, FIXTURES)).arrayBuffer());
const storage = stackStorage();
const t0Queue = recordingQueue();

let api: TestApi;
let key: StandingSigningKey;
let mailer: MemoryMailer;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;

async function newKey(): Promise<StandingSigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return importStandingSigningKey(Buffer.from(pkcs8).toString("base64"));
}

/** The worker's context on the API's test database, as the app role. */
function ctx(over: Partial<WorkerContext> = {}): WorkerContext {
  return {
    db: api.db.app.db,
    sql: api.db.app.sql,
    storage: api.deps.storage,
    mediaBucket: api.deps.env.S3_BUCKET_MEDIA,
    exportsBucket: api.deps.env.S3_BUCKET_EXPORTS,
    logger: quietLogger,
    site: siteAt(api.url),
    webhooks: fastWebhooks({ authSecret: AUTH_SECRET }),
    mailer,
    now: () => new Date(),
    ...over,
  } as WorkerContext;
}
const realCommit = (body: Parameters<typeof commitUpload>[0]) =>
  commitUpload(body, { baseUrl: api.url, secret: api.internalSecret });

describe.skipIf(!storage)("portability (worker)", () => {
  beforeAll(async () => {
    api = await startApi({
      env: {
        MODERATION_HASHLIST_CSAM: new URL("csam.pdq", FIXTURES).pathname,
        MODERATION_TEST_HOOKS: "true",
        MODERATION_CLASSIFIER: "scripted",
      },
    });
    await startModeration(api.deps, { queue: t0Queue });
    key = await newKey();
    mailer = new MemoryMailer({ site: siteAt(api.url) });
  }, 120_000);
  afterAll(async () => {
    await api?.stop();
  });

  const db = () => api.db.db;
  const channelOf = async (u: User) =>
    (await db().select().from(schema.channels).where(eq(schema.channels.ownerId, u.userId)))[0]!;

  // The `channelMoved` template is registered by the orchestrator (a W3-portability contract
  // request, packages/email/src/registry.ts); until then there is nothing to send.
  describe.skipIf(!(TEMPLATE_IDS as readonly string[]).includes("channelMoved"))("the moved notice", () => {
    test("one email per grant holder, then the grants are gone; nothing for the streamer", async () => {
      const streamer = await signUpAndSignIn(api);
      const ch = await channelOf(streamer);
      const [a, b, gone, unverified, untouched] = await Promise.all([1, 2, 3, 4, 5].map(() => signUpAndSignIn(api)));
      for (const u of [a!, b!, gone!, unverified!])
        await db().insert(schema.followPortabilityGrants).values({ userId: u.userId, channelId: ch.id });
      // A grant on another channel is not touched.
      const otherCh = await channelOf(untouched!);
      await db().insert(schema.followPortabilityGrants).values({ userId: a!.userId, channelId: otherCh.id });
      await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone!.userId));
      await db().update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, unverified!.userId));

      // A move cleared before the job runs sends nothing and keeps the grants.
      mailer.sent.length = 0;
      expect(await sendMovedNotices(ctx(), ch.id)).toEqual({ sent: 0, dropped: 0, failed: 0 });
      expect(mailer.sent).toHaveLength(0);

      await db()
        .update(schema.channels)
        .set({ movedTo: "https://video.example.org/c/me", movedAt: new Date() })
        .where(eq(schema.channels.id, ch.id));
      expect(await sendMovedNotices(ctx(), ch.id)).toEqual({ sent: 2, dropped: 2, failed: 0 });
      const to = mailer.sent.map((m) => m.to).sort();
      expect(to).toEqual([a!.email, b!.email].sort());
      expect(to).not.toContain(streamer.email);
      for (const m of mailer.sent) {
        expect(m.template).toBe("channelMoved");
        expect(m.headers["List-Unsubscribe"]).toMatch(/\/api\/email\/unsubscribe\?list=moved&token=/);
        expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(m.text).toContain("video.example.org");
        // Only this instance's links: the destination itself is never a link.
        expect(m.html).not.toContain('href="https://video.example.org');
      }
      const left = await db()
        .select()
        .from(schema.followPortabilityGrants)
        .where(eq(schema.followPortabilityGrants.channelId, ch.id));
      expect(left).toEqual([]);
      expect(
        await db()
          .select()
          .from(schema.followPortabilityGrants)
          .where(eq(schema.followPortabilityGrants.channelId, otherCh.id)),
      ).toHaveLength(1);
      // A second run (a retried job) sends nothing more.
      expect(await sendMovedNotices(ctx(), ch.id)).toEqual({ sent: 0, dropped: 0, failed: 0 });
      expect(mailer.sent).toHaveLength(2);
    });
  });

  /** A source channel with a category, panel and three emotes (one a T0 fixture), its images stored. */
  async function sourceChannel(): Promise<{ user: User; channelId: string; categoryId: string }> {
    const user = await signUpAndSignIn(api);
    const ch = await channelOf(user);
    const slug = `cat-${uuidv7().slice(-8)}`;
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug, name: `Category ${slug}` })
      .returning();
    await db()
      .update(schema.channels)
      .set({
        title: "Night owls",
        description: "Late streams",
        tags: ["chill", "cozy"],
        language: "es",
        mature: false,
        categoryId: cat!.id,
      })
      .where(eq(schema.channels.id, ch.id));
    const put = async (purpose: "panel" | "emote", name: string) => {
      const k = `channels/${ch.id}/${purpose}/${uuidv7()}.png`;
      await api.deps.storage.put(api.deps.env.S3_BUCKET_MEDIA, k, await fixture(name), { contentType: "image/png" });
      return k;
    };
    await db()
      .insert(schema.channelPanels)
      .values([
        {
          channelId: ch.id,
          position: 0,
          title: "About",
          body: "Hello",
          linkUrl: "https://old.example/about",
          imageKey: await put("panel", "benign-gradient.png"),
        },
        { channelId: ch.id, position: 1, title: "Rules", body: "Be kind", linkUrl: null, imageKey: null },
      ]);
    await db()
      .insert(schema.emotes)
      .values([
        { channelId: ch.id, code: "wave", imageKey: await put("emote", "benign-checkerboard.png"), tier: 0 },
        { channelId: ch.id, code: "clash", imageKey: await put("emote", "benign-noise.png"), tier: 1 },
        { channelId: ch.id, code: "bad", imageKey: await put("emote", "t0-pattern.png"), tier: 0 },
      ]);
    return { user, channelId: ch.id, categoryId: cat!.id };
  }

  const bundleOf = (src: { user: User; channelId: string }, generatedAt = new Date()) =>
    buildBundle(ctx(), { exportId: uuidv7(), userId: src.user.userId, channelId: src.channelId, generatedAt }, { key });

  /** Upload an archive for `dest` and preview it through the worker, as `imports.preview` does. */
  async function preview(dest: { user: User; channelId: string }, archive: Uint8Array) {
    const archiveKey = `incoming/portability/${dest.channelId}/${uuidv7()}.zip`;
    await api.deps.storage.put(api.deps.env.S3_BUCKET_MEDIA, archiveKey, Buffer.from(archive), {
      contentType: "application/zip",
    });
    const id = uuidv7();
    await db()
      .insert(schema.portabilityImports)
      .values({
        id,
        userId: dest.user.userId,
        channelId: dest.channelId,
        source: "commonair",
        status: "previewed",
        archiveKey,
        preview: { state: "pending" },
      });
    await runImportJob(ctx(), id);
    const [row] = await db().select().from(schema.portabilityImports).where(eq(schema.portabilityImports.id, id));
    return row!;
  }

  test("a bundle round-trips into another channel through the real upload pipeline", async () => {
    const src = await sourceChannel();
    const archive = await bundleOf(src);
    const destUser = await signUpAndSignIn(api);
    const destCh = await channelOf(destUser);
    // The destination already uses `clash` and is labelled mature.
    await db()
      .insert(schema.emotes)
      .values({ channelId: destCh.id, code: "clash", imageKey: `channels/${destCh.id}/emote/${uuidv7()}.png` });
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, destCh.id));
    const dest = { user: destUser, channelId: destCh.id };

    const row = await preview(dest, archive);
    expect(row.status).toBe("previewed");
    expect(row.standingVerified).toBe(true);
    expect(row.standingIssuer).toBe(new URL(api.url).origin);
    const pv = row.preview as { state: string; items: StoredItem[]; standing: Record<string, unknown> };
    expect(pv.state).toBe("ready");
    expect(pv.standing).toMatchObject({ state: "verified", activeSuspension: false, legalHold: false });
    expect(pv.items.find((i) => i.ref === "clash")).toMatchObject({ outcome: "skipped", reason: "code_taken" });

    t0Queue.jobs.length = 0;
    await db()
      .update(schema.portabilityImports)
      .set({ status: "queued", choices: { channel: true, panels: true, emotes: ["wave", "clash", "bad"] } })
      .where(eq(schema.portabilityImports.id, row.id));
    expect(await runImportJob(ctx(), row.id, { commitUpload: realCommit })).toMatchObject({ applied: 1 });

    const [after] = await db().select().from(schema.portabilityImports).where(eq(schema.portabilityImports.id, row.id));
    expect(after).toMatchObject({ status: "done" });
    expect(after?.finishedAt).not.toBeNull();
    const result = (after?.result ?? []) as unknown as StoredItem[];
    const outcome = (kind: string, ref: string) => {
      const i = result.find((x) => x.kind === kind && x.ref === ref);
      return i ? [i.outcome, i.reason] : null;
    };
    expect(outcome("channel", "channel")).toEqual(["imported", null]);
    expect(outcome("panel", "1")).toEqual(["imported", null]);
    expect(outcome("panel", "2")).toEqual(["imported", null]);
    expect(outcome("emote", "wave")).toEqual(["imported", null]);
    expect(outcome("emote", "clash")).toEqual(["skipped", "code_taken"]);
    expect(outcome("emote", "bad")).toEqual(["rejected", "upload_rejected"]);
    // The T0 fixture went through the same pipeline as a user upload: the T0 job was enqueued.
    expect(t0Queue.jobs.filter((j) => j.name === MODERATION_JOBS.t0)).toHaveLength(1);

    // Every field landed; the mature label stayed; the category mapped by slug.
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.id, destCh.id));
    expect(c).toMatchObject({
      title: "Night owls",
      description: "Late streams",
      tags: ["chill", "cozy"],
      language: "es",
      mature: true,
      categoryId: src.categoryId,
    });
    const panels = await db()
      .select()
      .from(schema.channelPanels)
      .where(eq(schema.channelPanels.channelId, destCh.id))
      .orderBy(schema.channelPanels.position);
    expect(panels.map((p) => [p.position, p.title, p.body, p.linkUrl])).toEqual([
      [0, "About", "Hello", "https://old.example/about"],
      [1, "Rules", "Be kind", null],
    ]);
    expect(panels[0]?.imageKey).toMatch(new RegExp(`^channels/${destCh.id}/panel/[0-9a-f-]{36}\\.png$`));
    expect(await api.deps.storage.head(api.deps.env.S3_BUCKET_MEDIA, panels[0]!.imageKey!)).not.toBeNull();
    const emotes = await db().select().from(schema.emotes).where(eq(schema.emotes.channelId, destCh.id));
    expect(emotes.map((e) => e.code).sort()).toEqual(["clash", "wave"]);
    expect(emotes.find((e) => e.code === "wave")?.imageKey).toMatch(new RegExp(`^channels/${destCh.id}/emote/`));
    const events = await db()
      .select({ type: schema.events.type })
      .from(schema.events)
      .where(
        and(
          sql`${schema.events.type} in ('channel.update', 'portability.import.finished')`,
          sql`(${schema.events.channelId} = ${destCh.id} or ${schema.events.payload}->>'import_id' = ${row.id})`,
        ),
      );
    expect(events.map((e) => e.type).sort()).toEqual(["channel.update", "portability.import.finished"]);

    // A retry (the job ran again) inserts nothing twice and keeps the result.
    const read = await readBundleArchive(archive);
    if (!read.ok) throw new Error("bundle did not read");
    await db()
      .update(schema.portabilityImports)
      .set({ status: "running" })
      .where(eq(schema.portabilityImports.id, row.id));
    const again = await applyBundle(
      ctx(),
      {
        importId: row.id,
        bundle: read.bundle,
        files: read.files,
        choices: { channel: true, panels: true, emotes: ["wave", "clash", "bad"] },
      },
      {
        commitUpload: async () => {
          throw new Error("must not upload again");
        },
      },
    );
    expect(again.ok).toBe(true);
    expect(
      (await db().select().from(schema.emotes).where(eq(schema.emotes.channelId, destCh.id))).map((e) => e.code).sort(),
    ).toEqual(["clash", "wave"]);
    expect(
      await db().select().from(schema.channelPanels).where(eq(schema.channelPanels.channelId, destCh.id)),
    ).toHaveLength(2);
  });

  test("an apply interrupted by an API failure resumes without uploading or inserting twice", async () => {
    const src = await sourceChannel();
    const read = await readBundleArchive(await bundleOf(src));
    if (!read.ok) throw new Error("bundle did not read");
    const destUser = await signUpAndSignIn(api);
    const destCh = await channelOf(destUser);
    const id = uuidv7();
    await db()
      .insert(schema.portabilityImports)
      .values({ id, userId: destUser.userId, channelId: destCh.id, source: "twitch", status: "queued" });
    const input = {
      importId: id,
      bundle: read.bundle,
      files: read.files,
      choices: { channel: true, panels: true, emotes: ["wave", "clash"] },
    };
    const calls: string[] = [];
    // The panel image commits, then the API goes away on the first emote.
    const flaky = async (body: Parameters<typeof commitUpload>[0]) => {
      calls.push(body.purpose);
      if (body.purpose === "emote") throw new Error("api down");
      return realCommit(body);
    };
    await expect(applyBundle(ctx(), input, { commitUpload: flaky })).rejects.toThrow("api down");
    const retried: string[] = [];
    const out = await applyBundle(ctx(), input, {
      commitUpload: async (body) => {
        retried.push(body.purpose);
        return realCommit(body);
      },
    });
    expect(out.ok).toBe(true);
    // The panel image was not uploaded again; both emotes were (neither had committed).
    expect(calls).toEqual(["panel", "emote"]);
    expect(retried).toEqual(["emote", "emote"]);
    expect(
      (await db().select().from(schema.emotes).where(eq(schema.emotes.channelId, destCh.id))).map((e) => e.code).sort(),
    ).toEqual(["clash", "wave"]);
    expect(
      await db().select().from(schema.channelPanels).where(eq(schema.channelPanels.channelId, destCh.id)),
    ).toHaveLength(2);
    // A done import returns its stored result without touching anything.
    expect(
      await applyBundle(ctx(), input, {
        commitUpload: async () => {
          throw new Error("no");
        },
      }),
    ).toMatchObject({ ok: true, status: "done" });
  });

  test("a verified statement saying the channel is suspended refuses the import", async () => {
    const src = await sourceChannel();
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, src.channelId));
    const archive = await bundleOf(src);
    const destUser = await signUpAndSignIn(api);
    const row = await preview({ user: destUser, channelId: (await channelOf(destUser)).id }, archive);
    expect(row.status).toBe("failed");
    expect(row.preview).toEqual({ state: "refused", refusal: "standing_suspended" });
    expect(row.standingVerified).toBe(true);
  });

  test("a legal hold on the importing account refuses the import (preview and applyBundle)", async () => {
    const src = await sourceChannel();
    const archive = await bundleOf(src);
    const destUser = await signUpAndSignIn(api);
    const destCh = await channelOf(destUser);
    await db().insert(schema.legalHolds).values({ userId: destUser.userId, reason: "test hold" });
    const row = await preview({ user: destUser, channelId: destCh.id }, archive);
    expect(row).toMatchObject({ status: "failed", preview: { state: "refused", refusal: "importer_legal_hold" } });
    // applyBundle checks again (N3 calls it directly).
    const id = uuidv7();
    await db().insert(schema.portabilityImports).values({
      id,
      userId: destUser.userId,
      channelId: destCh.id,
      source: "twitch",
      status: "queued",
    });
    const read = await readBundleArchive(archive);
    if (!read.ok) throw new Error("bundle did not read");
    const out = await applyBundle(
      ctx(),
      { importId: id, bundle: read.bundle, files: read.files, choices: { channel: true, panels: true, emotes: [] } },
      { commitUpload: realCommit },
    );
    expect(out).toEqual({ ok: false, status: "failed", reason: "importer_legal_hold" });
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.id, destCh.id));
    expect(c?.title).not.toBe("Night owls");
  });

  test("an expired statement imports, marked standing not verified", async () => {
    const src = await sourceChannel();
    const archive = await bundleOf(src, new Date(Date.now() - 31 * 86_400_000));
    const destUser = await signUpAndSignIn(api);
    const row = await preview({ user: destUser, channelId: (await channelOf(destUser)).id }, archive);
    expect(row.status).toBe("previewed");
    expect(row.standingVerified).toBe(false);
    expect(row.standingIssuer).toBeNull();
    expect((row.preview as { standing: unknown }).standing).toEqual({ state: "unverified", reason: "expired" });
  });

  test("the statement's facts: upheld actions by tier in the last 12 months, DMCA strikes, flags", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 86_400_000);
    // Cases start open (the 0015 guard), then are decided.
    const kase = async (tier: "t1" | "t2", status: "actioned" | "labelled" | "cleared" | "dismissed", at: Date) => {
      const [c] = await db()
        .insert(schema.moderationCases)
        .values({
          tier,
          status: "open",
          origin: "human",
          subjectType: "broadcast",
          subjectId: uuidv7(),
          channelId: ch.id,
          userId: u.userId,
          createdAt: at,
        })
        .returning({ id: schema.moderationCases.id });
      await db()
        .update(schema.moderationCases)
        .set({ status, resolvedAt: at })
        .where(eq(schema.moderationCases.id, c!.id));
    };
    await kase("t1", "actioned", now);
    await kase("t2", "labelled", now);
    await kase("t1", "cleared", now);
    await kase("t2", "dismissed", now);
    // Outside the 12-month window.
    await kase("t1", "actioned", old);
    await db()
      .insert(schema.modActions)
      .values([
        { scope: "platform", channelId: ch.id, targetUserId: u.userId, action: "warn", ruleRef: "safety.weapons@1" },
        // A case's own action is counted through the case, a reversal never.
        {
          scope: "platform",
          channelId: ch.id,
          action: "suspend_channel",
          ruleRef: "safety.weapons@1",
          subjectType: "moderation_case",
          subjectId: uuidv7(),
        },
        { scope: "platform", channelId: ch.id, action: "unsuspend_channel", ruleRef: "safety.weapons@1" },
        { scope: "channel", channelId: ch.id, targetUserId: u.userId, action: "ban" },
      ]);
    await db()
      .insert(schema.accountActions)
      .values([
        { userId: u.userId, action: "dmca_strike", actorType: "system" },
        {
          userId: u.userId,
          action: "dmca_strike",
          actorType: "system",
          reversedAt: now,
          reversedReason: ACCOUNT_ACTION_REVERSALS[0],
        },
      ]);
    expect(await standingFacts(db(), ch.id, now)).toEqual({
      activeSuspension: false,
      legalHold: false,
      upheldActions: { t0: 0, t1: 2, t2: 1 },
      dmcaStrikes: 1,
    });
    await db().update(schema.channels).set({ suspendedAt: now }).where(eq(schema.channels.id, ch.id));
    await db().insert(schema.legalHolds).values({ userId: u.userId, reason: "test hold" });
    expect(await standingFacts(db(), ch.id, now)).toMatchObject({ activeSuspension: true, legalHold: true });
  });

  test("a bad archive is refused at preview with a stable code", async () => {
    const destUser = await signUpAndSignIn(api);
    const row = await preview({ user: destUser, channelId: (await channelOf(destUser)).id }, new Uint8Array([1, 2, 3]));
    expect(row).toMatchObject({ status: "failed", preview: { state: "refused", refusal: "bundle_not_a_zip" } });
  });
});
