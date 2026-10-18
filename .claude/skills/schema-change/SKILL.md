---
name: schema-change
description: Change the CommonAir database schema safely - edit Drizzle schema, generate a named migration, add protections SQL if needed, and test.
---

<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

1. Edit `packages/db/src/schema/<domain>.ts`. Enum values come from `packages/contracts/src/enums.ts`; JSON column types from `packages/contracts/src/shapes.ts`.
2. `cd packages/db && bunx drizzle-kit generate --name <what_changed>` (never edit a committed migration; add a new one). For triggers/functions: `bunx drizzle-kit generate --custom --name <name>` and write SQL with `--> statement-breakpoint` separators and an SPDX header.
3. Never weaken `0001_protections.sql` behavior without a governance ADR.
4. Add or extend integration tests in `packages/db/tests/*.int.test.ts` using `createTestDatabase()`.
5. `bun run verify`.
