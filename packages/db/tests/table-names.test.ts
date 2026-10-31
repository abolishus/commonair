// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { schemaTableNames } from "../src/table-names.ts";

describe("schemaTableNames", () => {
  test("lists each table once, sorted, without views or enums", () => {
    const names = schemaTableNames();
    expect(names).toEqual([...new Set(names)].sort());
    for (const t of ["users", "channels", "ledger_entries", "audit_log", "overlay_tokens"]) expect(names).toContain(t);
    expect(names.length).toBeGreaterThan(100);
  });
});
