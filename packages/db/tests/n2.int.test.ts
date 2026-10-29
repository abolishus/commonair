// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N2 schema (0036; ADR 0029): `users.locale` is nullable (null = never chosen), has no default,
 * and a `CHECK` holds it to the same BCP 47 pattern as the contract's `LocaleTag`, for the app
 * role too.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));

let t: TestDatabase;
let app: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

async function newUser(): Promise<string> {
  const name = `n2_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function localeOf(id: string): Promise<string | null> {
  const [u] = await owner.select({ locale: s.users.locale }).from(s.users).where(eq(s.users.id, id));
  return u!.locale;
}

describe("users.locale", () => {
  test("a user inserted without a locale has null (not chosen)", async () => {
    expect(await localeOf(await newUser())).toBeNull();
  });

  test("a tag round-trips, and the app role can set and clear it", async () => {
    const id = await newUser();
    await owner.update(s.users).set({ locale: "es" }).where(eq(s.users.id, id));
    expect(await localeOf(id)).toBe("es");
    await app.update(s.users).set({ locale: "pt-BR" }).where(eq(s.users.id, id));
    expect(await localeOf(id)).toBe("pt-BR");
    await app.update(s.users).set({ locale: null }).where(eq(s.users.id, id));
    expect(await localeOf(id)).toBeNull();
    await app.update(s.users).set({ locale: "en-XA" }).where(eq(s.users.id, id));
    expect(await localeOf(id)).toBe("en-XA");
  });

  test.each(["english", "EN", "en_US", "e", ""])("the app role cannot store %j (users_locale_format)", async (bad) => {
    const id = await newUser();
    const err = await app
      .update(s.users)
      .set({ locale: bad })
      .where(eq(s.users.id, id))
      .then(
        () => undefined,
        (e: unknown) => e as Error & { cause?: Error & { code?: string; constraint_name?: string } },
      );
    expect(err, "expected the CHECK to reject").toBeInstanceOf(Error);
    expect(err!.cause?.code).toBe("23514");
    expect(err!.cause?.message ?? err!.message).toMatch(/users_locale_format/);
  });

  test("the migration turns the old default 'en' into null", async () => {
    const file = readdirSync(drizzleDir).find((f) => /^\d{4}_n2_users_locale\.sql$/.test(f));
    expect(file).toBeDefined();
    const statements = readFileSync(`${drizzleDir}${file}`, "utf8").split("--> statement-breakpoint");
    const update = statements.find((st) => /UPDATE "users" SET "locale" = NULL WHERE "locale" = 'en'/.test(st));
    expect(update).toBeDefined();

    // Replay the data change against rows as the old schema left them.
    const defaulted = await newUser();
    const chosen = await newUser();
    await owner.update(s.users).set({ locale: "en" }).where(eq(s.users.id, defaulted));
    await owner.update(s.users).set({ locale: "es" }).where(eq(s.users.id, chosen));
    await owner.execute(sql.raw(update!));
    expect(await localeOf(defaulted)).toBeNull();
    expect(await localeOf(chosen)).toBe("es");
  });
});
