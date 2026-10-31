// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.ts";

/** Every table the Drizzle schema declares, sorted (the full seed's coverage check reads it). */
export function schemaTableNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(schema)) if (is(value, PgTable)) names.add(getTableName(value));
  return [...names].sort();
}
