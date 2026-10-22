// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A backend that dies under an open transaction (Postgres restart, crash recovery, failover,
 * `pg_terminate_backend`) must fail that transaction, not the process. Unpatched postgres.js
 * 3.4.9 let the transaction's next statement write to the closed socket from a timer, an
 * uncaught TypeError that took the worker down (patches/postgres@3.4.9.patch).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import type postgres from "postgres";
import { createDb, type DbHandle } from "../src/client.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let t: TestDatabase;
let db: DbHandle;
const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Terminates the backend and waits until it has exited (the server has closed the socket). */
async function backendPid(sql: postgres.Sql | postgres.TransactionSql): Promise<number> {
  const [row] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return row!.pid;
}

async function terminate(pid: number): Promise<void> {
  const [row] = await t.sql<{ ok: boolean }[]>`select pg_terminate_backend(${pid}, 5000) as ok`;
  expect(row?.ok).toBe(true);
}

beforeAll(async () => {
  t = await createTestDatabase();
  await t.sql`create table reconnect_probe (id int not null)`;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  // One connection, so the pool reconnects the very connection object the transaction held.
  db = createDb({ url: t.url, max: 1, applicationName: "commonair-reconnect-test" });
});
afterEach(async () => {
  await db.close();
  process.off("uncaughtException", onUncaught);
});

test("a statement after the backend died rejects the transaction instead of throwing", async () => {
  const started = deferred<number>();
  const resume = deferred();
  let later: unknown;
  const tx = db.sql.begin(async (sql) => {
    started.resolve(await backendPid(sql));
    await resume.promise; // app work between statements, e.g. a Valkey or S3 call
    later = await sql`select 2`.then(
      () => "ran",
      (e: { code?: string }) => e.code,
    );
  });
  const outcome = tx.then(
    () => "committed",
    (e: { code?: string }) => e.code,
  );
  await terminate(await started.promise);

  expect(await outcome).toBe("CONNECTION_CLOSED");
  resume.resolve();
  await sleep(100); // past the statement and the setImmediate flush that used to throw
  expect(later).toBe("CONNECTION_CLOSED");
  expect(uncaught).toEqual([]);
  // The pool recovers on its own.
  expect(await db.sql`select 1 as ok`).toEqual([{ ok: 1 }]);
});

test("a dead transaction's statements never run in autocommit on the reconnected session", async () => {
  const started = deferred<number>();
  const resume = deferred();
  let inserted: unknown;
  const tx = db.sql.begin(async (sql) => {
    started.resolve(await backendPid(sql));
    await resume.promise;
    inserted = await sql`insert into reconnect_probe (id) values (1)`.then(
      () => "ran",
      (e: { code?: string }) => e.code,
    );
  });
  const outcome = tx.then(
    () => "committed",
    (e: { code?: string }) => e.code,
  );
  const pid = await started.promise;
  await terminate(pid);
  expect(await outcome).toBe("CONNECTION_CLOSED");

  // Another caller makes the pool reconnect the same connection; then the transaction goes on.
  expect(await backendPid(db.sql)).not.toBe(pid);
  resume.resolve();
  await sleep(100);

  expect(inserted).toBe("CONNECTION_CLOSED");
  expect(await t.sql`select count(*)::int as n from reconnect_probe`).toEqual([{ n: 0 }]);
  expect(uncaught).toEqual([]);
});

test("a Postgres-side kill of an idle pooled connection is invisible to the next query", async () => {
  await terminate(await backendPid(db.sql));
  await sleep(100); // let the close reach the client, so the next query sees a closed connection
  expect(await db.sql`select 1 as ok`).toEqual([{ ok: 1 }]);
  expect(uncaught).toEqual([]);
});
