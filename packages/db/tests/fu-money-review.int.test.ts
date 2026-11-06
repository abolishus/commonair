// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Second security review of 0051 (card share chargebacks), as the least-privilege application
 * role: each rule attacked the way a caller with ordinary DML would, plus 0052's bounds on what a
 * chargeback, its reversal and a share refund may post.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

vi.setConfig({ hookTimeout: 60_000 });
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { uuidv7 } from "../src/ids.ts";
import type { Database } from "../src/client.ts";

let t: TestDatabase;
let app: Database;

/** The rejection's message, or null when the database accepted it. */
async function refusal(p: PromiseLike<unknown>): Promise<string | null> {
  return Promise.resolve(p).then(
    () => null,
    (e: unknown) => {
      const err = e as Error & { cause?: Error };
      return err.cause?.message ?? err.message;
    },
  );
}

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function makeUser(): Promise<string> {
  const name = `fureview${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function account(code: string, type: "asset" | "liability" | "expense"): Promise<string> {
  const [a] = await app
    .insert(s.ledgerAccounts)
    .values({ code: `${code}@usd`, type, name: code, currency: "usd" })
    .onConflictDoNothing()
    .returning({ id: s.ledgerAccounts.id });
  if (a) return a.id;
  const [b] = await app
    .select()
    .from(s.ledgerAccounts)
    .where(eq(s.ledgerAccounts.code, `${code}@usd`));
  return b!.id;
}

let cash = "";
let fees = "";

interface Line {
  accountId: string;
  cents: number;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Ref = { type: string | null; id: string | null };

/** One posting with the given lines, in its own transaction (so deferred checks run). */
function post(key: string, kind: string, ref: Ref, lines: Line[]) {
  return app.transaction((tx) => insertPosting(tx, key, kind, ref, lines));
}

async function insertPosting(tx: Tx, key: string, kind: string, ref: Ref, lines: Line[]): Promise<string> {
  const [txn] = await tx
    .insert(s.ledgerTransactions)
    .values({ kind, description: kind, occurredAt: new Date(), idempotencyKey: key, refType: ref.type, refId: ref.id })
    .returning({ id: s.ledgerTransactions.id });
  await tx
    .insert(s.ledgerEntries)
    .values(
      lines.map((l) => ({ transactionId: txn!.id, accountId: l.accountId, amountCents: l.cents, currency: "usd" })),
    );
  return txn!.id;
}

/** Until another session of this database waits on a lock (bounded, so a missed wait fails loudly). */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    const rows = await app.execute(sql`
      select 1 from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and state = 'active'`);
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no session ever waited on the share's row lock");
}

const setShare = (id: string, v: Partial<typeof s.membershipShares.$inferInsert>) =>
  app.update(s.membershipShares).set(v).where(eq(s.membershipShares.id, id));

interface Held {
  shareId: string;
  paymentId: string;
  userId: string;
  /** The owner's member-share account. */
  equity: string;
  ref: { type: string; id: string };
}

async function heldShare(amountCents = 500): Promise<Held> {
  const userId = await makeUser();
  const equity = await account(`liability:member-share:${userId}`, "liability");
  const [pay] = await app
    .insert(s.payments)
    .values({
      provider: "stripe",
      providerRef: `pi_${uuidv7().replace(/-/g, "")}`,
      kind: "membership_share",
      userId,
      amountCents,
      currency: "usd",
    })
    .returning({ id: s.payments.id });
  const [share] = await app
    .insert(s.membershipShares)
    .values({ userId, amountCents, currency: "usd", paymentId: pay!.id })
    .returning({ id: s.membershipShares.id });
  await app.update(s.payments).set({ status: "succeeded", succeededAt: new Date() }).where(eq(s.payments.id, pay!.id));
  const ref = { type: "membership_share", id: share!.id };
  await post(`share-purchase:${share!.id}`, "share_purchase", ref, [
    { accountId: cash, cents: amountCents },
    { accountId: equity, cents: -amountCents },
  ]);
  await setShare(share!.id, { status: "held", purchasedAt: new Date() });
  return { shareId: share!.id, paymentId: pay!.id, userId, equity, ref };
}

async function dispute(paymentId: string, amountCents = 500, kind: "chargeback" | "refund" = "chargeback") {
  const [d] = await app
    .insert(s.disputes)
    .values({ paymentId, kind, status: "open", amountCents, providerRef: `dp_r${++seq}` })
    .returning({ id: s.disputes.id });
  return d!.id;
}

/** Dr the member share, Cr cash: what `shareChargeback` posts (no fee). */
const clawback = (h: Held, cents: number): Line[] => [
  { accountId: h.equity, cents },
  { accountId: cash, cents: -cents },
];
const restore = (h: Held, cents: number): Line[] => [
  { accountId: cash, cents },
  { accountId: h.equity, cents: -cents },
];

beforeAll(async () => {
  cash = await account("asset:cash:stripe", "asset");
  fees = await account("expense:payment-fees", "expense");
});

describe("0051 under attack: what the first pass already refuses", () => {
  test("a reversal keyed by another share's dispute is refused", async () => {
    const a = await heldShare();
    const b = await heldShare();
    const d = await dispute(b.paymentId);
    await post(`share-chargeback:${d}`, "share_chargeback", b.ref, clawback(b, 500));
    // a is not charged back, and b's dispute names b: a's capital cannot be restored with it.
    expect(
      await refusal(post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.ref, restore(a, 500))),
    ).toMatch(/needs that dispute's chargeback/);
  });

  test("case and whitespace in the keys never name a second chargeback or reversal", async () => {
    const a = await heldShare();
    const d = await dispute(a.paymentId);
    for (const key of [
      `share-chargeback:${d.toUpperCase()}`,
      `Share-Chargeback:${d}`,
      ` share-chargeback:${d}`,
      `share-chargeback:${d} `,
      `share-chargeback:${d}\n`,
    ])
      expect(await refusal(post(key, "share_chargeback", a.ref, clawback(a, 500))), key).toMatch(
        /keyed by its dispute/,
      );
    await post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500));
    // The idempotency key is unique: the same dispute never claws back twice.
    expect(await refusal(post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500)))).toMatch(
      /already charged back|duplicate key/,
    );
    for (const key of [`share-chargeback-reversal:${d.toUpperCase()}`, `share-chargeback-reversal:${d} `])
      expect(await refusal(post(key, "share_chargeback_reversal", a.ref, restore(a, 500))), key).toMatch(
        /reversal is keyed by its dispute/,
      );
    await post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.ref, restore(a, 500));
    expect(
      await refusal(post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.ref, restore(a, 500))),
    ).toMatch(/duplicate key/);
  });

  test("NULL and dangling references are refused", async () => {
    const a = await heldShare();
    const d = await dispute(a.paymentId);
    const key = `share-chargeback:${d}`;
    for (const ref of [
      { type: null, id: null },
      { type: "membership_share", id: null },
      { type: null, id: a.shareId },
      { type: "payment", id: a.paymentId },
    ])
      expect(await refusal(post(key, "share_chargeback", ref, clawback(a, 500))), JSON.stringify(ref)).toMatch(
        /references its member share/,
      );
    expect(
      await refusal(post(key, "share_chargeback", { type: "membership_share", id: uuidv7() }, clawback(a, 500))),
    ).toMatch(/no such member share/);
  });

  test("a refund dispute, or a chargeback of another payment, never claws a share back", async () => {
    const a = await heldShare();
    const refundRow = await dispute(a.paymentId, 500, "refund");
    expect(await refusal(post(`share-chargeback:${refundRow}`, "share_chargeback", a.ref, clawback(a, 500)))).toMatch(
      /share's own payment/,
    );
  });

  test("two chargebacks of one share in one statement: the second sees the first", async () => {
    const a = await heldShare();
    const [d1, d2] = [await dispute(a.paymentId), await dispute(a.paymentId)];
    const err = await refusal(
      app.transaction(async (tx) => {
        const rows = await tx
          .insert(s.ledgerTransactions)
          .values(
            [d1, d2].map((d) => ({
              kind: "share_chargeback",
              description: "x",
              occurredAt: new Date(),
              idempotencyKey: `share-chargeback:${d}`,
              refType: "membership_share",
              refId: a.shareId,
            })),
          )
          .returning({ id: s.ledgerTransactions.id });
        for (const r of rows)
          await tx.insert(s.ledgerEntries).values(
            clawback(a, 500).map((l) => ({
              transactionId: r.id,
              accountId: l.accountId,
              amountCents: l.cents,
              currency: "usd",
            })),
          );
      }),
    );
    expect(err).toMatch(/already charged back/);
  });

  test("two concurrent chargebacks of one share: exactly one posts", async () => {
    const a = await heldShare();
    const [d1, d2] = [await dispute(a.paymentId), await dispute(a.paymentId)];
    const results = await Promise.all(
      [d1, d2].map((d) => refusal(post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500)))),
    );
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatch(/already charged back/);
  });

  test("a refund posting waiting on a concurrent chargeback is refused once it commits", async () => {
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    const d = await dispute(a.paymentId);
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started = (): void => undefined;
    const holding = new Promise<void>((r) => (started = r));
    // The chargeback's guard takes the share's row lock and keeps it until commit.
    const chargeback = app.transaction(async (tx) => {
      const [txn] = await tx
        .insert(s.ledgerTransactions)
        .values({
          kind: "share_chargeback",
          description: "x",
          occurredAt: new Date(),
          idempotencyKey: `share-chargeback:${d}`,
          refType: "membership_share",
          refId: a.shareId,
        })
        .returning({ id: s.ledgerTransactions.id });
      await tx.insert(s.ledgerEntries).values(
        clawback(a, 500).map((l) => ({
          transactionId: txn!.id,
          accountId: l.accountId,
          amountCents: l.cents,
          currency: "usd",
        })),
      );
      started();
      await gate;
    });
    await holding;
    const refund = refusal(post(`share-refund:${a.shareId}`, "share_refund", a.ref, clawback(a, 500)));
    // The refund really waits on the share's lock (not merely runs after the chargeback).
    await lockWaiter();
    release();
    await chargeback;
    expect(await refund).toMatch(/charged-back share is never refunded/);
  });
});

describe("0052: a snapshot older than the statement never decides a chargeback or a refund", () => {
  /**
   * Opens `level`, takes its snapshot, commits `first` in another session, then runs `second` in
   * the old snapshot: 0051 alone let both stand (the lock waited, the read was stale).
   */
  async function staleSnapshot(
    level: "repeatable read" | "serializable",
    first: (tx: Tx) => Promise<unknown>,
    second: (tx: Tx) => Promise<unknown>,
  ) {
    return refusal(
      app.transaction(
        async (tx) => {
          await tx.execute(sql`select 1`);
          await app.transaction(first);
          await second(tx);
        },
        { isolationLevel: level },
      ),
    );
  }
  const kinds = (shareId: string) =>
    app
      .select({ kind: s.ledgerTransactions.kind })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.refId, shareId))
      .then((rows) =>
        rows
          .map((r) => r.kind)
          .filter((k) => k !== "share_purchase")
          .sort(),
      );

  for (const level of ["repeatable read", "serializable"] as const) {
    test(`${level}: a second chargeback after one committed meanwhile is refused`, async () => {
      const a = await heldShare();
      const [d1, d2] = [await dispute(a.paymentId), await dispute(a.paymentId)];
      const err = await staleSnapshot(
        level,
        (o) => insertPosting(o, `share-chargeback:${d1}`, "share_chargeback", a.ref, clawback(a, 500)),
        (tx) => insertPosting(tx, `share-chargeback:${d2}`, "share_chargeback", a.ref, clawback(a, 500)),
      );
      expect(err).toMatch(/under read committed only/);
      expect(await kinds(a.shareId)).toEqual(["share_chargeback"]);
    });

    test(`${level}: a chargeback after a refund committed meanwhile, and the reverse, are refused`, async () => {
      const a = await heldShare();
      await setShare(a.shareId, { status: "refund_pending" });
      const d = await dispute(a.paymentId);
      const refund = (tx: Tx) =>
        insertPosting(tx, `share-refund:${a.shareId}`, "share_refund", a.ref, clawback(a, 500));
      const chargeback = (tx: Tx) =>
        insertPosting(tx, `share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500));
      expect(await staleSnapshot(level, refund, chargeback)).toMatch(/under read committed only/);
      expect(await kinds(a.shareId)).toEqual(["share_refund"]);

      const b = await heldShare();
      await setShare(b.shareId, { status: "refund_pending" });
      const db = await dispute(b.paymentId);
      const err = await staleSnapshot(
        level,
        (o) => insertPosting(o, `share-chargeback:${db}`, "share_chargeback", b.ref, clawback(b, 500)),
        (tx) => insertPosting(tx, `share-refund:${b.shareId}`, "share_refund", b.ref, clawback(b, 500)),
      );
      expect(err).toMatch(/under read committed only/);
      expect(await kinds(b.shareId)).toEqual(["share_chargeback"]);
    });

    test(`${level}: a share is not cancelled after its chargeback was reversed meanwhile`, async () => {
      const a = await heldShare();
      const d = await dispute(a.paymentId);
      await post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500));
      const err = await staleSnapshot(
        level,
        (o) => insertPosting(o, `share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.ref, restore(a, 500)),
        (tx) => tx.update(s.membershipShares).set({ status: "cancelled" }).where(eq(s.membershipShares.id, a.shareId)),
      );
      expect(err).toMatch(/under read committed only/);
      const [row] = await app.select().from(s.membershipShares).where(eq(s.membershipShares.id, a.shareId));
      expect(row!.status).toBe("held");
    });
  }

  test("read committed, the default, still posts each of them", async () => {
    const a = await heldShare();
    const d = await dispute(a.paymentId);
    await app.transaction(
      (tx) => insertPosting(tx, `share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500)),
      {
        isolationLevel: "read committed",
      },
    );
    await setShare(a.shareId, { status: "cancelled" });
    expect(await kinds(a.shareId)).toEqual(["share_chargeback"]);
  });
});

describe("0052: what a share chargeback, its reversal and a share refund may post", () => {
  test("a chargeback claws back exactly its dispute's amount from the owner's member share", async () => {
    const a = await heldShare();
    const d = await dispute(a.paymentId, 500);
    const key = `share-chargeback:${d}`;
    // More than the dispute, less than it, or nothing from the member share at all.
    expect(await refusal(post(key, "share_chargeback", a.ref, clawback(a, 50_000)))).toMatch(/dispute's amount/);
    expect(await refusal(post(key, "share_chargeback", a.ref, clawback(a, 499)))).toMatch(/dispute's amount/);
    expect(
      await refusal(
        post(key, "share_chargeback", a.ref, [
          { accountId: fees, cents: 500 },
          { accountId: cash, cents: -500 },
        ]),
      ),
    ).toMatch(/dispute's amount/);
    // Another member's share capital is never touched by this share's chargeback.
    const b = await heldShare();
    expect(await refusal(post(key, "share_chargeback", a.ref, clawback(b, 500)))).toMatch(/dispute's amount/);
    expect(
      await refusal(
        post(key, "share_chargeback", a.ref, [
          { accountId: a.equity, cents: 500 },
          { accountId: b.equity, cents: 500 },
          { accountId: cash, cents: -1000 },
        ]),
      ),
    ).toMatch(/dispute's amount/);
    // The dispute fee lines (cash and the fee expense) are free.
    await post(key, "share_chargeback", a.ref, [
      ...clawback(a, 500),
      { accountId: fees, cents: 1500 },
      { accountId: cash, cents: -1500 },
    ]);
  });

  test("a dispute larger than the share (rows are app-writable) never claws back more than the share", async () => {
    const a = await heldShare(500);
    const d = await dispute(a.paymentId, 50_000);
    expect(await refusal(post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 50_000)))).toMatch(
      /more than the share/,
    );
    // Shrinking the row afterwards changes nothing already posted; a partial dispute is fine.
    const partial = await dispute(a.paymentId, 200);
    await post(`share-chargeback:${partial}`, "share_chargeback", a.ref, clawback(a, 200));
  });

  test("a reversal restores exactly what its chargeback took, whatever the dispute row says now", async () => {
    const a = await heldShare();
    const d = await dispute(a.paymentId, 300);
    await post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 300));
    await app.update(s.disputes).set({ amountCents: 500 }).where(eq(s.disputes.id, d));
    const key = `share-chargeback-reversal:${d}`;
    expect(await refusal(post(key, "share_chargeback_reversal", a.ref, restore(a, 500)))).toMatch(
      /what its chargeback took/,
    );
    expect(await refusal(post(key, "share_chargeback_reversal", a.ref, restore(a, 299)))).toMatch(
      /what its chargeback took/,
    );
    const b = await heldShare();
    expect(await refusal(post(key, "share_chargeback_reversal", a.ref, restore(b, 300)))).toMatch(
      /what its chargeback took/,
    );
    await post(key, "share_chargeback_reversal", a.ref, [
      ...restore(a, 300),
      { accountId: cash, cents: 1500 },
      { accountId: fees, cents: -1500 },
    ]);
  });

  test("a share refund is keyed share-refund:<its share>, so a second payback never slips past", async () => {
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    const d = await dispute(a.paymentId);
    await post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500));
    // 0051 looked only at canonical keys: another key paid the member back again.
    for (const key of [`refund-again:${a.shareId}`, `share-refund:${a.shareId}:2`, `share-refund:${uuidv7()}`])
      expect(await refusal(post(key, "share_refund", a.ref, clawback(a, 500))), key).toMatch(/keyed share-refund/);
  });

  test("an upper-case refund key never hides the refund from a later chargeback", async () => {
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    expect(
      await refusal(post(`share-refund:${a.shareId.toUpperCase()}`, "share_refund", a.ref, clawback(a, 500))),
    ).toMatch(/keyed share-refund/);
    // The canonical key still refunds, and then no chargeback follows it.
    await post(`share-refund:${a.shareId}`, "share_refund", a.ref, clawback(a, 500));
    const d = await dispute(a.paymentId);
    expect(await refusal(post(`share-chargeback:${d}`, "share_chargeback", a.ref, clawback(a, 500)))).toMatch(
      /refunded share is never charged back/,
    );
  });
});
