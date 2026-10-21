// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Trust & safety protections (0016_trust_safety_protections.sql, ADR 0006). Everything that could
 * lose evidence, lift a hold, skip the two-reviewer T0 dismissal, shorten the NCII deadline or
 * switch a tier off must be refused by the database for the application role.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { uuidv7 } from "../src/ids.ts";
import type { Database } from "../src/client.ts";
import { releaseHold } from "../src/holds/cli.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let owner: Database;

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function makeUser(role: "user" | "legal" | "moderator" = "user"): Promise<string> {
  const name = `ts${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, role })
    .returning({ id: s.users.id });
  return u!.id;
}

async function makeChannel(ownerId: string): Promise<string> {
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId, slug: `ch${++seq}`, displayName: "Channel" })
    .returning({ id: s.channels.id });
  return c!.id;
}

async function makeT0Case(userId: string, channelId: string | null = null): Promise<string> {
  const [c] = await app
    .insert(s.moderationCases)
    .values({
      tier: "t0",
      origin: "hash_list",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      userId,
      channelId,
      listCategory: "csam",
      priority: 1000,
    })
    .returning({ id: s.moderationCases.id });
  return c!.id;
}

async function makeHold(userId: string, caseId: string | null = null): Promise<string> {
  const [h] = await app
    .insert(s.legalHolds)
    .values({ userId, caseId, reasonCode: "csam_match", reason: "t0 match" })
    .returning({ id: s.legalHolds.id });
  return h!.id;
}

const sealed = new Uint8Array([1, 2, 3, 4]);
const sha = "a".repeat(64);

async function makeEvidence(holdId: string, caseId: string): Promise<string> {
  const [e] = await app
    .insert(s.evidenceObjects)
    .values({
      holdId,
      caseId,
      kind: "frame",
      storage: "inline",
      sealed,
      sha256: sha,
      sizeBytes: 4,
      contentType: "image/webp",
      keyId: "k1",
      sourceSubjectType: "broadcast",
      sourceSubjectId: uuidv7(),
      capturedAt: new Date(),
    })
    .returning({ id: s.evidenceObjects.id });
  return e!.id;
}

async function makeDraft(caseId: string, holdId: string, userId: string): Promise<string> {
  const [r] = await app
    .insert(s.ncmecReports)
    .values({
      caseId,
      holdId,
      userId,
      incidentAt: new Date(),
      listCategory: "csam",
      snapshotSealed: sealed,
      keyId: "k1",
      evidenceIds: [],
    })
    .returning({ id: s.ncmecReports.id });
  return r!.id;
}

describe("append-only evidence and flags", () => {
  test("evidence cannot be updated, deleted or truncated, even by the owner", async () => {
    const u = await makeUser();
    const c = await makeT0Case(u);
    const h = await makeHold(u, c);
    const e = await makeEvidence(h, c);
    await expectPgError(
      app.delete(s.evidenceObjects).where(eq(s.evidenceObjects.id, e)),
      /permission denied|append-only/,
    );
    await expectPgError(
      owner.update(s.evidenceObjects).set({ keyId: "k2" }).where(eq(s.evidenceObjects.id, e)),
      /append-only/,
    );
    await expectPgError(owner.delete(s.evidenceObjects).where(eq(s.evidenceObjects.id, e)), /append-only/);
    await expectPgError(owner.execute(sql`truncate evidence_objects cascade`), /append-only/);
  });

  test("evidence storage shape is checked", async () => {
    const u = await makeUser();
    const c = await makeT0Case(u);
    const h = await makeHold(u, c);
    await expectPgError(
      app.insert(s.evidenceObjects).values({
        holdId: h,
        caseId: c,
        kind: "frame",
        storage: "inline",
        sealed: null,
        storageKey: "x",
        sha256: sha,
        sizeBytes: 1,
        contentType: "image/webp",
        keyId: "k",
        sourceSubjectType: "broadcast",
        sourceSubjectId: uuidv7(),
        capturedAt: new Date(),
      }),
      /evidence_objects_storage/,
    );
  });

  test("flags are append-only", async () => {
    const u = await makeUser();
    const c = await makeT0Case(u);
    const [f] = await app
      .insert(s.moderationFlags)
      .values({
        tier: "t0",
        origin: "hash_list",
        caseId: c,
        subjectType: "broadcast",
        subjectId: uuidv7(),
        userId: u,
        listCategory: "csam",
        distance: 4,
        quality: 90,
        provider: "pdq:operator-list",
        providerVersion: "v1",
        capturedAt: new Date(),
      })
      .returning({ id: s.moderationFlags.id });
    await expectPgError(
      app.delete(s.moderationFlags).where(eq(s.moderationFlags.id, f!.id)),
      /permission denied|append-only/,
    );
    await expectPgError(
      owner.update(s.moderationFlags).set({ distance: 40 }).where(eq(s.moderationFlags.id, f!.id)),
      /append-only/,
    );
  });

  test("a classifier flag needs a category and a score", async () => {
    const u = await makeUser();
    const c = await makeT0Case(u);
    await expectPgError(
      app.insert(s.moderationFlags).values({
        tier: "t1",
        origin: "classifier",
        caseId: c,
        subjectType: "broadcast",
        subjectId: uuidv7(),
        provider: "scripted",
        providerVersion: "1",
        capturedAt: new Date(),
      }),
      /moderation_flags_signal/,
    );
  });
});

describe("legal holds", () => {
  test("the app cannot delete or release a hold; the owner can release with a reason", async () => {
    const u = await makeUser();
    const h = await makeHold(u);
    await expectPgError(app.delete(s.legalHolds).where(eq(s.legalHolds.id, h)), /permission denied|cannot be deleted/);
    await expectPgError(
      app.update(s.legalHolds).set({ releasedAt: new Date(), releaseReason: "done" }).where(eq(s.legalHolds.id, h)),
      /only the database owner/,
    );
    await expectPgError(
      owner.update(s.legalHolds).set({ releasedAt: new Date() }).where(eq(s.legalHolds.id, h)),
      /needs released_at and a reason/,
    );
    await owner
      .update(s.legalHolds)
      .set({ releasedAt: new Date(), releaseReason: "preservation period over" })
      .where(eq(s.legalHolds.id, h));
    await expectPgError(
      owner.update(s.legalHolds).set({ releaseReason: "changed" }).where(eq(s.legalHolds.id, h)),
      /released hold is final/,
    );
    await expectPgError(owner.delete(s.legalHolds).where(eq(s.legalHolds.id, h)), /cannot be deleted/);
  });

  test("a hold starts active and its subject is immutable", async () => {
    const u = await makeUser();
    await expectPgError(
      app.insert(s.legalHolds).values({ userId: u, reason: "x", releasedAt: new Date(), releaseReason: "x" }),
      /starts active/,
    );
    const h = await makeHold(u);
    await expectPgError(app.update(s.legalHolds).set({ userId: uuidv7() }).where(eq(s.legalHolds.id, h)), /immutable/);
  });

  test("eligibility for release comes one year after filing at the earliest", async () => {
    const u = await makeUser();
    const h = await makeHold(u);
    const filed = new Date("2026-01-01T00:00:00Z");
    await expectPgError(
      app.update(s.legalHolds).set({ eligibleForReleaseAt: new Date() }).where(eq(s.legalHolds.id, h)),
      /one year after filing/,
    );
    await app.update(s.legalHolds).set({ filedAt: filed }).where(eq(s.legalHolds.id, h));
    await expectPgError(
      app
        .update(s.legalHolds)
        .set({ eligibleForReleaseAt: new Date("2026-06-01T00:00:00Z") })
        .where(eq(s.legalHolds.id, h)),
      /one year after filing/,
    );
    await app
      .update(s.legalHolds)
      .set({ eligibleForReleaseAt: new Date("2027-01-01T00:00:00Z") })
      .where(eq(s.legalHolds.id, h));
    await expectPgError(
      app.update(s.legalHolds).set({ filedAt: new Date() }).where(eq(s.legalHolds.id, h)),
      /set once/,
    );
  });
});

describe("hold CLI", () => {
  test("releases as the owner with an audit row; the app role is refused", async () => {
    const u = await makeUser();
    const h = await makeHold(u);
    await expectPgError(releaseHold(app, h, "no"), /only the database owner/);
    const r = await releaseHold(owner, h, "counsel approved");
    expect(r.eligible).toBe(false);
    const audit = await app.select().from(s.auditLog).where(eq(s.auditLog.subjectId, h));
    expect(audit.map((a) => a.action)).toEqual(["legal_hold.release"]);
    await expect(releaseHold(owner, h, "again")).rejects.toThrow(/already released/);
  });
});

describe("NCMEC drafts", () => {
  test("never deleted, contents immutable, filing needs a legal user", async () => {
    const u = await makeUser();
    const legal = await makeUser("legal");
    const mod = await makeUser("moderator");
    const c = await makeT0Case(u);
    const h = await makeHold(u, c);
    const r = await makeDraft(c, h, u);
    await expectPgError(
      app.delete(s.ncmecReports).where(eq(s.ncmecReports.id, r)),
      /permission denied|cannot be deleted/,
    );
    await expectPgError(
      app
        .update(s.ncmecReports)
        .set({ snapshotSealed: new Uint8Array([9]) })
        .where(eq(s.ncmecReports.id, r)),
      /immutable/,
    );
    await expectPgError(
      app
        .update(s.ncmecReports)
        .set({ status: "filed", externalReportId: "123", filedAt: new Date(), filedById: mod })
        .where(eq(s.ncmecReports.id, r)),
      /legal user/,
    );
    await app
      .update(s.ncmecReports)
      .set({ status: "filed", externalReportId: "123", filedAt: new Date(), filedById: legal })
      .where(eq(s.ncmecReports.id, r));
    await expectPgError(
      app.update(s.ncmecReports).set({ externalReportId: "456" }).where(eq(s.ncmecReports.id, r)),
      /final/,
    );
  });

  test("a draft is withdrawn only for a dismissed case", async () => {
    const u = await makeUser();
    const legal = await makeUser("legal");
    const c = await makeT0Case(u);
    const h = await makeHold(u, c);
    const r = await makeDraft(c, h, u);
    await expectPgError(
      app
        .update(s.ncmecReports)
        .set({ status: "withdrawn", withdrawnAt: new Date(), withdrawnById: legal })
        .where(eq(s.ncmecReports.id, r)),
      /dismissed case/,
    );
  });
});

describe("T0 cases", () => {
  async function dismissFirst(c: string, reviewer: string): Promise<void> {
    await app
      .update(s.moderationCases)
      .set({
        status: "dismissal_pending",
        firstReviewerId: reviewer,
        firstReviewedAt: new Date(),
        firstReviewNote: "fp",
      })
      .where(eq(s.moderationCases.id, c));
  }
  async function dismissSecond(c: string, reviewer: string): Promise<void> {
    await app
      .update(s.moderationCases)
      .set({
        status: "dismissed",
        resolvedById: reviewer,
        resolvedAt: new Date(),
        resolution: "dismissed",
        resolutionNote: "fp",
      })
      .where(eq(s.moderationCases.id, c));
  }

  test("dismissal needs two different legal reviewers, neither the subject", async () => {
    const u = await makeUser();
    const l1 = await makeUser("legal");
    const l2 = await makeUser("legal");
    const mod = await makeUser("moderator");
    const c = await makeT0Case(u);
    await expectPgError(
      app.update(s.moderationCases).set({ status: "dismissed" }).where(eq(s.moderationCases.id, c)),
      /cannot move/,
    );
    await expectPgError(dismissFirst(c, mod), /legal reviewer/);
    await dismissFirst(c, l1);
    await expectPgError(dismissSecond(c, l1), /second, different legal reviewer/);
    await expectPgError(dismissSecond(c, mod), /second, different legal reviewer/);
    await expectPgError(
      app.update(s.moderationCases).set({ firstReviewerId: l2 }).where(eq(s.moderationCases.id, c)),
      /first reviewer is fixed/,
    );
    await dismissSecond(c, l2);
    await expectPgError(
      app.update(s.moderationCases).set({ status: "confirmed" }).where(eq(s.moderationCases.id, c)),
      /final/,
    );
    await expectPgError(
      app.delete(s.moderationCases).where(eq(s.moderationCases.id, c)),
      /permission denied|cannot be deleted/,
    );
  });

  test("a legal subject cannot review their own case", async () => {
    const l1 = await makeUser("legal");
    const c = await makeT0Case(l1);
    await expectPgError(dismissFirst(c, l1), /other than the subject/);
  });

  test("a T0 case stays T0, and escalation opens a human-origin case", async () => {
    const u = await makeUser();
    const c = await makeT0Case(u);
    await expectPgError(
      app.update(s.moderationCases).set({ tier: "t1" }).where(eq(s.moderationCases.id, c)),
      /stays T0/,
    );
    const [t1] = await app
      .insert(s.moderationCases)
      .values({
        tier: "t1",
        origin: "classifier",
        subjectType: "broadcast",
        subjectId: uuidv7(),
        userId: u,
        category: "sexual",
      })
      .returning({ id: s.moderationCases.id });
    await expectPgError(
      app.update(s.moderationCases).set({ tier: "t0" }).where(eq(s.moderationCases.id, t1!.id)),
      /human-origin/,
    );
    await app.update(s.moderationCases).set({ tier: "t0", origin: "human" }).where(eq(s.moderationCases.id, t1!.id));
  });

  test("a T0 suspension is lifted only after the case is dismissed", async () => {
    const u = await makeUser();
    const ch = await makeChannel(u);
    const l1 = await makeUser("legal");
    const l2 = await makeUser("legal");
    const c = await makeT0Case(u, ch);
    await app.update(s.users).set({ banned: true, banReason: "t0_hash_match" }).where(eq(s.users.id, u));
    await app
      .update(s.channels)
      .set({ suspendedAt: new Date(), suspendedReason: "t0_hash_match" })
      .where(eq(s.channels.id, ch));
    await expectPgError(app.update(s.users).set({ banned: false }).where(eq(s.users.id, u)), /dismissing its case/);
    await expectPgError(
      app.update(s.users).set({ banReason: "other" }).where(eq(s.users.id, u)),
      /dismissing its case/,
    );
    await expectPgError(
      app.update(s.channels).set({ suspendedAt: null }).where(eq(s.channels.id, ch)),
      /dismissing its case/,
    );
    await dismissFirst(c, l1);
    await expectPgError(app.update(s.users).set({ banned: false }).where(eq(s.users.id, u)), /dismissing its case/);
    await app.transaction(async (tx) => {
      await tx
        .update(s.moderationCases)
        .set({
          status: "dismissed",
          resolvedById: l2,
          resolvedAt: new Date(),
          resolution: "dismissed",
          resolutionNote: "fp",
        })
        .where(eq(s.moderationCases.id, c));
      await tx.update(s.users).set({ banned: false, banReason: null }).where(eq(s.users.id, u));
      await tx.update(s.channels).set({ suspendedAt: null, suspendedReason: null }).where(eq(s.channels.id, ch));
    });
  });

  test("media removed by a T0 match stays removed", async () => {
    const u = await makeUser();
    const ch = await makeChannel(u);
    const [b] = await app
      .insert(s.broadcasts)
      .values({ channelId: ch, ingestProtocol: "rtmp", path: "live/x" })
      .returning({ id: s.broadcasts.id });
    const [v] = await app
      .insert(s.vods)
      .values({
        broadcastId: b!.id,
        channelId: ch,
        title: "v",
        storagePrefix: "vods/x/",
        status: "deleted",
        removedReason: "t0_hash_match",
      })
      .returning({ id: s.vods.id });
    await expectPgError(app.update(s.vods).set({ status: "ready" }).where(eq(s.vods.id, v!.id)), /stays removed/);
    await expectPgError(app.update(s.vods).set({ removedReason: null }).where(eq(s.vods.id, v!.id)), /stays removed/);
  });
});

describe("mature label lock", () => {
  test("mature cannot be unset while a label is active", async () => {
    const u = await makeUser();
    const ch = await makeChannel(u);
    const [l] = await app
      .insert(s.contentLabels)
      .values({ channelId: ch, label: "mature", caseId: uuidv7() })
      .returning({ id: s.contentLabels.id });
    await app.update(s.channels).set({ mature: true }).where(eq(s.channels.id, ch));
    await expectPgError(
      app.update(s.channels).set({ mature: false }).where(eq(s.channels.id, ch)),
      /active mature label/,
    );
    await expectPgError(
      app.delete(s.contentLabels).where(eq(s.contentLabels.id, l!.id)),
      /permission denied|never deleted/,
    );
    await expectPgError(
      app.update(s.contentLabels).set({ caseId: uuidv7() }).where(eq(s.contentLabels.id, l!.id)),
      /immutable/,
    );
    await app.transaction(async (tx) => {
      await tx
        .update(s.contentLabels)
        .set({ removedAt: new Date(), removedReason: "appeal_overturned" })
        .where(eq(s.contentLabels.id, l!.id));
      await tx.update(s.channels).set({ mature: false }).where(eq(s.channels.id, ch));
    });
    await expectPgError(
      app.update(s.contentLabels).set({ removedAt: new Date() }).where(eq(s.contentLabels.id, l!.id)),
      /set once/,
    );
  });
});

describe("NCII clock", () => {
  async function submit(receivedAt?: Date): Promise<{ id: string; receivedAt: Date; deadlineAt: Date }> {
    const [r] = await app
      .insert(s.nciiRequests)
      .values({
        requesterName: "R",
        requesterEmail: "r@example.test",
        relationship: "self",
        contentUrls: ["https://example.test/clip/1"],
        description: "d",
        goodFaith: true,
        signature: "R",
        // A client-supplied time is ignored: the database clock and the 48 hours are constants.
        receivedAt: receivedAt ?? new Date("2000-01-01T00:00:00Z"),
        deadlineAt: new Date("2100-01-01T00:00:00Z"),
      })
      .returning();
    return r!;
  }

  test("the deadline is the database clock + 48 hours and cannot move", async () => {
    const before = Date.now();
    const r = await submit();
    expect(r.receivedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(r.deadlineAt.getTime() - r.receivedAt.getTime()).toBe(48 * 3600 * 1000);
    await expectPgError(
      app
        .update(s.nciiRequests)
        .set({ deadlineAt: new Date("2100-01-01T00:00:00Z") })
        .where(eq(s.nciiRequests.id, r.id)),
      /immutable/,
    );
    await expectPgError(app.delete(s.nciiRequests).where(eq(s.nciiRequests.id, r.id)), /undecided/);
  });

  test("auto-hide only at the deadline; decisions are final", async () => {
    const mod = await makeUser("moderator");
    const r = await submit();
    await expectPgError(
      app
        .update(s.nciiRequests)
        .set({ status: "auto_hidden", autoHiddenAt: new Date() })
        .where(eq(s.nciiRequests.id, r.id)),
      /at the deadline/,
    );
    await app
      .update(s.nciiRequests)
      .set({ status: "removed", decidedAt: new Date(), decidedById: mod })
      .where(eq(s.nciiRequests.id, r.id));
    await expectPgError(
      app.update(s.nciiRequests).set({ status: "rejected" }).where(eq(s.nciiRequests.id, r.id)),
      /final/,
    );
  });

  test("good faith is required", async () => {
    await expectPgError(
      app.insert(s.nciiRequests).values({
        requesterName: "R",
        requesterEmail: "r@example.test",
        relationship: "self",
        contentUrls: [],
        description: "d",
        goodFaith: false,
        signature: "R",
        deadlineAt: new Date(),
      }),
      /good_faith/,
    );
  });
});

describe("local block list", () => {
  test("entries are never deleted and only revoked once", async () => {
    const [e] = await app
      .insert(s.localHashList)
      .values({ category: "ncii", pdq: "f".repeat(64), sourceType: "ncii_request", sourceId: uuidv7() })
      .returning({ id: s.localHashList.id });
    await expectPgError(
      app.delete(s.localHashList).where(eq(s.localHashList.id, e!.id)),
      /permission denied|never deleted/,
    );
    await expectPgError(
      app
        .update(s.localHashList)
        .set({ pdq: "0".repeat(64) })
        .where(eq(s.localHashList.id, e!.id)),
      /immutable/,
    );
    await expectPgError(
      app.insert(s.localHashList).values({ category: "ncii", pdq: "XYZ", sourceType: "x", sourceId: uuidv7() }),
      /local_hash_list_pdq/,
    );
  });
});

describe("moderation.thresholds", () => {
  const valid = {
    t1: { sexual: 0.97, graphic_violence: 0.9, weapons: 0.95, self_harm: 0.9 },
    t2: { sexual: 0.8 },
    sampleSeconds: 10,
  };
  const check = (v: unknown) => owner.execute(sql`select commonair_validate_moderation(${JSON.stringify(v)}::jsonb)`);

  test("the seeded value is valid and present", async () => {
    const [row] = await app
      .select()
      .from(s.governanceSettings)
      .where(eq(s.governanceSettings.key, "moderation.thresholds"));
    expect(row?.value).toEqual(valid);
    await check(valid);
  });

  test.each([
    ["t1 sexual off", { ...valid, t1: { ...valid.t1, sexual: 1 } }],
    ["t1 sexual too low", { ...valid, t1: { ...valid.t1, sexual: 0.5 } }],
    ["t1 weapons off", { ...valid, t1: { ...valid.t1, weapons: 2 } }],
    ["t2 off", { ...valid, t2: { sexual: 1 } }],
    ["t2 above t1", { ...valid, t1: { ...valid.t1, sexual: 0.9 }, t2: { sexual: 0.92 } }],
    ["sampling off", { ...valid, sampleSeconds: 0 }],
    ["sampling rare", { ...valid, sampleSeconds: 3600 }],
    ["fractional interval", { ...valid, sampleSeconds: 7.5 }],
    ["missing category", { ...valid, t1: { sexual: 0.97 } }],
    ["string value", { ...valid, sampleSeconds: "10" }],
    ["not an object", 5],
  ])("refuses %s", async (_name, v) => {
    await expectPgError(check(v), /moderation\.thresholds/);
  });
});
