// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E6 DB helpers against a throwaway, migrated database (row ids, fixture, outbox scan). */
import { createDb, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  dropSubscription,
  eventsContaining,
  identityState,
  lostRows,
  rowsReferencing,
  seedWebhookDelivery,
  tipEventId,
  webhookDeliveryExists,
} from "../../src/e6/db.ts";

let t: TestDatabase;
const U = uuidv7();
const S = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  const db = createDb({ url: t.url, max: 1 });
  const sql = db.sql;
  try {
    for (const [id, name] of [
      [U, "e6int_u"],
      [S, "e6int_s"],
    ] as const) {
      await sql`insert into users (id, name, email, username) values (${id}, ${`Display ${name}`}, ${`${name}@example.test`}, ${name})`;
    }
    await sql`insert into audit_log (id, actor_type, actor_id, action, subject_type, subject_id)
              values (${uuidv7()}, 'user', ${U}, 'export.request', 'user', ${U}),
                     (${uuidv7()}, 'system', null, 'deletion.request', 'user', ${U}),
                     (${uuidv7()}, 'user', ${S}, 'other', 'user', ${S})`;
    await sql`insert into membership_history (id, membership_id, user_id, class, status, basis, op, at)
              values (${uuidv7()}, ${uuidv7()}, ${U}, 'viewer', 'active', 'share', 'insert', now())`;
    await sql`insert into events (id, type, payload)
              values (${uuidv7()}, 'channel.tip', ${JSON.stringify({ user_id: U, message: "int tip marker", key: "skey-int-123" })}::jsonb)`;
  } finally {
    await db.close();
  }
});
afterAll(() => t?.drop());

describe("E6 DB helpers", () => {
  test("rowsReferencing returns U's audit and history rows by id with the referencing columns", async () => {
    const rows = await rowsReferencing(t.url, U);
    const audit = rows.filter((r) => r.table === "audit_log");
    expect(audit).toHaveLength(2);
    expect(audit.map((r) => r.refs.join(","))).toEqual(expect.arrayContaining(["actor_id,subject_id", "subject_id"]));
    const history = rows.filter((r) => r.table === "membership_history");
    expect(history).toHaveLength(1);
    expect(history[0]?.refs).toContain("user_id");
    expect(lostRows(rows, await rowsReferencing(t.url, U))).toEqual([]);
    expect(await rowsReferencing(t.url, uuidv7())).toEqual([]);
  });

  test("tip event lookup, the webhook delivery fixture and its removal", async () => {
    const eventId = await tipEventId(t.url, U, "int tip marker");
    expect(eventId).not.toBeNull();
    expect(await tipEventId(t.url, U, "another message")).toBeNull();
    const seeded = await seedWebhookDelivery(t.url, {
      subscriberId: S,
      eventId: eventId ?? "",
      responseBody: '{"echo":"x"}',
    });
    expect(await webhookDeliveryExists(t.url, seeded.deliveryId)).toBe(true);
    await dropSubscription(t.url, seeded.subscriptionId);
    expect(await webhookDeliveryExists(t.url, seeded.deliveryId)).toBe(false);
  });

  test("eventsContaining counts payloads holding a value, optionally since a time", async () => {
    expect(await eventsContaining(t.url, "skey-int-123")).toBe(1);
    expect(await eventsContaining(t.url, "skey-int-123", new Date(Date.now() + 60_000))).toBe(0);
    expect(await eventsContaining(t.url, "absent-value-xyz")).toBe(0);
  });

  test("identityState flags a kept email, local part or name", async () => {
    const st = await identityState(t.url, U, {
      email: "e6int_u@example.test",
      username: "e6int_u",
      displayName: "Display e6int_u",
    });
    expect(st.exists).toBe(true);
    expect(st.emailKept).toBe(true);
    expect(st.emailDeletedPlaceholder).toBe(false);
    expect(st.nameKept).toBe(true);
    expect(st.usernamePseudonymized).toBe(false);
  });
});
