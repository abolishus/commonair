<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Dependency patches

`bun install` applies these through `patchedDependencies` in the root `package.json`. Edit one
with `bun patch <pkg>@<version>` and `bun patch --commit node_modules/<pkg>`. Drop it when
upstream ships the fix, and check the regression test still passes.

## `postgres@3.4.9`

postgres.js 3.4.9 (the latest release as of 2026-10-22) mishandles a connection that closes
while a `sql.begin` transaction is between statements: Postgres restart, crash recovery,
failover or `pg_terminate_backend`.

- The transaction handle keeps executing on the closed connection. The deferred write then
  throws `TypeError: null is not an object (evaluating 'socket.write')` from a `setImmediate`
  callback. That is uncaught and kills the process, which is how the worker died.
- When the pool reconnects that same connection object for another query, the dead
  transaction's later statements run there in autocommit, which commits partial work.
- `closed()` leaves a stale unsent chunk and timer behind for the next session.

The patch rejects such statements with `CONNECTION_CLOSED` and clears the write state on close.
Regression test: `packages/db/tests/reconnect.int.test.ts`.
