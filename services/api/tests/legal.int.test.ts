// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `legal.*` against the seeded drafts, and sign-up's acceptance gate with them in place. */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { LEGAL_DOCUMENT_KINDS } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
// Not exported from @commonair/db yet (contract request).
import { LEGAL_SEED_VERSION } from "../../../packages/db/src/legal/index.ts";
import { seedLegalDocuments } from "../../../packages/db/src/seed.ts";
import {
  client,
  mailTo,
  signUpAndSignIn,
  solveAltcha,
  startApi,
  uniqueName,
  waitFor,
  type TestApi,
} from "./harness.ts";

interface Doc {
  id: string;
  kind: string;
  version: string;
  title: string;
  body: string;
  isDraft: boolean;
  publishedAt: string;
}

let api: TestApi;
let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  // The shared harness signs up without accepting documents, so it must run before the seed.
  alice = await signUpAndSignIn(api);
  await seedLegalDocuments(db());
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("legal.current", () => {
  test("returns every kind, rendered for this instance, flagged as drafts", async () => {
    const r = await client(api).call<Doc[]>("GET", "/api/legal");
    expect(r.status).toBe(200);
    expect(r.body.map((d) => d.kind).sort()).toEqual([...LEGAL_DOCUMENT_KINDS].sort());
    for (const d of r.body) {
      expect(d.version).toBe(LEGAL_SEED_VERSION);
      expect(d.isDraft).toBe(true);
      expect(d.body, d.kind).not.toContain("{{");
      expect(d.title).not.toContain("{{");
      expect(d.body).toContain(api.deps.site.name);
    }
    const privacy = r.body.find((d) => d.kind === "privacy");
    expect(privacy?.body).toContain(api.deps.site.contacts.privacy);
    const dmca = r.body.find((d) => d.kind === "dmca_policy");
    expect(dmca?.body).toContain(api.deps.site.contacts.dmca);
  });

  test("a version scheduled for the future is not current yet", async () => {
    await db()
      .insert(schema.legalDocuments)
      .values({
        kind: "guidelines",
        version: "future-1",
        title: "Future",
        body: "Later",
        publishedAt: new Date(Date.now() + 86_400_000),
      });
    const r = await client(api).call<Doc[]>("GET", "/api/legal");
    expect(r.body.find((d) => d.kind === "guidelines")?.version).toBe(LEGAL_SEED_VERSION);
    expect((await client(api).call("GET", "/api/legal/guidelines?version=future-1")).status).toBe(404);
  });
});

describe("legal.get", () => {
  test("current, a specific version, and 404s", async () => {
    const cur = await client(api).call<Doc>("GET", "/api/legal/terms");
    expect(cur.status).toBe(200);
    expect(cur.body).toMatchObject({ kind: "terms", version: LEGAL_SEED_VERSION, isDraft: true });
    expect(cur.body.body).not.toContain("{{");

    const byVersion = await client(api).call<Doc>("GET", `/api/legal/terms?version=${LEGAL_SEED_VERSION}`);
    expect(byVersion.status).toBe(200);
    expect(byVersion.body.id).toBe(cur.body.id);

    expect((await client(api).call("GET", "/api/legal/terms?version=1999-01-01")).status).toBe(404);
    expect((await client(api).call("GET", "/api/legal/not_a_kind")).status).toBe(400);
  });
});

describe("legal.consent", () => {
  const consent = (c: ReturnType<typeof client>, body: Record<string, unknown>) =>
    c.call<{ ok?: boolean; code?: string }>("POST", "/api/consent", body);

  test("stored for a signed-in user, essential forced on", async () => {
    const r = await consent(alice.client, { choices: { preferences: true }, policyVersion: LEGAL_SEED_VERSION });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const rows = await db().select().from(schema.consentRecords).where(eq(schema.consentRecords.userId, alice.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      anonymousId: null,
      policyVersion: LEGAL_SEED_VERSION,
      choices: { essential: true, preferences: true },
    });
  });

  test("stored for an anonymous visitor by anonymousId", async () => {
    const anonymousId = crypto.randomUUID().replace(/-/g, "");
    const r = await consent(client(api), {
      anonymousId,
      choices: { preferences: false },
      policyVersion: LEGAL_SEED_VERSION,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await db()
      .select()
      .from(schema.consentRecords)
      .where(and(eq(schema.consentRecords.anonymousId, anonymousId), isNull(schema.consentRecords.userId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.choices).toEqual({ essential: true, preferences: false });
  });

  test("refuses a stale policy version, unknown categories, and anonymous callers without an id", async () => {
    const anonymousId = crypto.randomUUID().replace(/-/g, "");
    expect(
      (await consent(client(api), { anonymousId, choices: { preferences: true }, policyVersion: "2020-01-01" })).status,
    ).toBe(400);
    expect(
      (await consent(alice.client, { choices: { analytics: true }, policyVersion: LEGAL_SEED_VERSION })).status,
    ).toBe(400);
    expect((await consent(client(api), { choices: {}, policyVersion: LEGAL_SEED_VERSION })).status).toBe(400);
    const rows = await db()
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.anonymousId, anonymousId));
    expect(rows).toHaveLength(0);
  });
});

describe("sign-up with the seeded drafts", () => {
  const signUp = async (acceptedDocumentIds?: string[]) => {
    const username = uniqueName();
    const email = `${username}@test.invalid`;
    const r = await client(api).call<{ code?: string; message?: string }>("POST", "/api/auth/sign-up/email", {
      email,
      password: `pw-${crypto.randomUUID()}`,
      name: username,
      username,
      birthDate: "1990-05-05",
      altcha: await solveAltcha(api),
      ...(acceptedDocumentIds ? { acceptedDocumentIds } : {}),
    });
    return { r, email };
  };

  test("requires the three required documents and records their acceptance", async () => {
    const missing = await signUp();
    expect(missing.r.status).toBe(400);
    expect(JSON.stringify(missing.r.body)).toContain("LEGAL_ACCEPTANCE_REQUIRED");

    const docs = (await client(api).call<Doc[]>("GET", "/api/legal")).body;
    const ok = await signUp(docs.map((d) => d.id));
    expect(ok.r.status, JSON.stringify(ok.r.body)).toBe(200);
    await waitFor(() => mailTo(ok.email));
    const [user] = await db()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, ok.email));
    if (!user) throw new Error("user not created");
    const accepted = await db()
      .select({ kind: schema.legalDocuments.kind })
      .from(schema.legalAcceptances)
      .innerJoin(schema.legalDocuments, eq(schema.legalDocuments.id, schema.legalAcceptances.documentId))
      .where(eq(schema.legalAcceptances.userId, user.id));
    expect(accepted.map((a) => a.kind).sort()).toEqual(["guidelines", "privacy", "terms"]);
  });

  test("an existing user sees the new drafts as pending until accepted", async () => {
    const me = await alice.client.call<{ pendingLegal: { kind: string; version: string }[] }>("GET", "/api/me");
    expect(me.body.pendingLegal.map((p) => p.kind).sort()).toEqual(["guidelines", "privacy", "terms"]);
    const docs = (await client(api).call<Doc[]>("GET", "/api/legal")).body;
    const accept = await alice.client.call("POST", "/api/me/legal-acceptances", { documentIds: docs.map((d) => d.id) });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    const after = await alice.client.call<{ pendingLegal: unknown[] }>("GET", "/api/me");
    expect(after.body.pendingLegal).toEqual([]);
  });
});
