// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4 (0057, 0058): preference rows have their own type, the first notification opt-in
 * is recorded once by triggers, case assignees are staff, `get_paid` is a markable setup step and a
 * transparency note is a well-formed month. Run as the least-privilege app role, as services do.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { uuidv7 } from "../src/ids.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

async function user(role = "user"): Promise<string> {
  const id = uuidv7();
  const name = `u${id.slice(-10).replace(/-/g, "")}`;
  await t.app.db.execute(
    sql`insert into users (id, name, email, username, role) values (${id}, ${name}, ${`${name}@example.test`}, ${name}, ${role})`,
  );
  return id;
}

async function firstOptin(id: string): Promise<Date | null> {
  const [row] = await t.app.db.execute<{ at: Date | null }>(
    sql`select first_notify_optin_at as at from users where id = ${id}`,
  );
  return row?.at ? new Date(row.at) : null;
}

/** Drizzle wraps the Postgres error; the trigger's message is on its cause. */
async function refused(p: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await p.then(
    () => null,
    (e: unknown) => e as { cause?: { message?: string } },
  );
  expect(error).not.toBeNull();
  expect(String(error?.cause?.message)).toMatch(message);
}

const pref = (userId: string, medium: string, enabled: boolean, id = uuidv7()) =>
  t.app.db.execute(
    sql`insert into notification_preferences (id, user_id, type, channel_id, medium, enabled)
        values (${id}, ${userId}, 'go_live', null, ${medium}, ${enabled})`,
  );

describe("0057 notification preference types", () => {
  test("the column takes preference types, not notification types", async () => {
    expect.hasAssertions();
    const id = await user();
    await t.app.db.execute(
      sql`insert into notification_preferences (id, user_id, type, channel_id, medium, enabled)
          values (${uuidv7()}, ${id}, 'governance', null, 'in_app', false)`,
    );
    await refused(
      t.app.db.execute(
        sql`insert into notification_preferences (id, user_id, type, channel_id, medium, enabled)
            values (${uuidv7()}, ${id}, 'vote_open', null, 'email', false)`,
      ),
      /invalid input value for enum/,
    );
  });

  test("notification_type has the wave 4 types", async () => {
    const rows = await t.db.execute<{ v: string }>(sql`select unnest(enum_range(null::notification_type))::text as v`);
    expect(rows.map((r) => r.v)).toEqual(expect.arrayContaining(["report_outcome", "moderator_added"]));
  });
});

describe("0058 first notification opt-in", () => {
  test("an in-app or disabled row does not count; an email row on does, dated by its id", async () => {
    const id = await user();
    await pref(id, "in_app", true);
    await pref(id, "push", false);
    expect(await firstOptin(id)).toBeNull();
    const before = Date.now();
    await pref(id, "email", true);
    const at = await firstOptin(id);
    expect(at).not.toBeNull();
    expect(Math.abs((at as Date).getTime() - before)).toBeLessThan(60_000);
  });

  test("turning an off row on later counts from then; re-saving never moves it", async () => {
    const id = await user();
    await pref(id, "push", false);
    expect(await firstOptin(id)).toBeNull();
    await t.app.db.execute(sql`update notification_preferences set enabled = true where user_id = ${id}`);
    const first = await firstOptin(id);
    expect(first).not.toBeNull();
    await t.app.db.execute(sql`update notification_preferences set enabled = false where user_id = ${id}`);
    await t.app.db.execute(sql`update notification_preferences set enabled = true where user_id = ${id}`);
    expect(await firstOptin(id)).toEqual(first);
  });

  test("a push subscription counts, and an earlier (backdated) opt-in moves it earlier", async () => {
    const id = await user();
    await t.app.db.execute(
      sql`insert into push_subscriptions (id, user_id, endpoint_hash, subscription, created_at)
          values (${uuidv7()}, ${id}, ${`h-${id}`}, 'x', now())`,
    );
    const first = await firstOptin(id);
    expect(first).not.toBeNull();
    await t.app.db.execute(
      sql`insert into push_subscriptions (id, user_id, endpoint_hash, subscription, created_at)
          values (${uuidv7()}, ${id}, ${`h2-${id}`}, 'x', now() - interval '3 days')`,
    );
    const earlier = await firstOptin(id);
    expect((earlier as Date).getTime()).toBeLessThan((first as Date).getTime() - 2 * 86_400_000);
  });

  test("the column is never cleared or moved later", async () => {
    const id = await user();
    await pref(id, "email", true);
    expect(await firstOptin(id)).not.toBeNull();
    await refused(
      t.app.db.execute(sql`update users set first_notify_optin_at = null where id = ${id}`),
      /never cleared/,
    );
    await refused(
      t.app.db.execute(sql`update users set first_notify_optin_at = now() + interval '1 day' where id = ${id}`),
      /never cleared/,
    );
  });
});

describe("0058 case assignment", () => {
  async function kase(): Promise<string> {
    const id = uuidv7();
    await t.app.db.execute(
      sql`insert into moderation_cases (id, tier, origin, subject_type, subject_id)
          values (${id}, 't1', 'human', 'broadcast', ${uuidv7()})`,
    );
    return id;
  }

  test("a moderator can be assigned with a time; a plain user or a missing time cannot", async () => {
    expect.hasAssertions();
    const c = await kase();
    const mod = await user("moderator");
    const plain = await user("user");
    await t.app.db.execute(sql`update moderation_cases set assignee_id = ${mod}, assigned_at = now() where id = ${c}`);
    await refused(
      t.app.db.execute(sql`update moderation_cases set assignee_id = ${plain}, assigned_at = now() where id = ${c}`),
      /assignee_id/,
    );
    await refused(
      t.app.db.execute(sql`update moderation_cases set assigned_at = null where id = ${c}`),
      /moderation_cases_assigned_at_set/,
    );
    await t.app.db.execute(sql`update moderation_cases set assignee_id = null, assigned_at = null where id = ${c}`);
  });
});

describe("0057 setup steps and transparency notes", () => {
  test("get_paid is markable; derived steps are not", async () => {
    const defs = await t.db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'channel_setup_steps'::regclass and contype = 'c'`,
    );
    const text = defs.map((d) => d.def).join("\n");
    expect(text).toContain("'get_paid'");
    expect(text).toContain("'bring_your_audience'");
    expect(text).not.toContain("'first_live'");
  });

  test("a note needs a YYYY-MM month and 1 to 2000 characters", async () => {
    expect.hasAssertions();
    await t.app.db.execute(
      sql`insert into transparency_notes (month, body) values ('2026-10', 'Costs exceed the 10% today.')`,
    );
    await refused(
      t.app.db.execute(sql`insert into transparency_notes (month, body) values ('2026-13', 'x')`),
      /transparency_notes_month_format/,
    );
    await refused(
      t.app.db.execute(sql`insert into transparency_notes (month, body) values ('2026-09', '')`),
      /transparency_notes_body_length/,
    );
  });
});
