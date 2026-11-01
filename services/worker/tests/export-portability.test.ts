// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The portability export file's allow-list (ADR 0037): what of a member's grants, imports and move
 * links leaves the platform. A change here is a change to the export: never a nonce hash, an
 * archive key, raw import choices, a preview or anyone else's identity.
 */
import { createDb } from "@commonair/db";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { PORTABILITY_EXPORT_FILES } from "../src/portability/export.ts";

const handle = createDb({ url: "postgres://nobody:nothing@127.0.0.1:9/none", max: 1 });
afterAll(() => handle.close());
const scope = { userId: "0190f0f0-0000-7000-8000-00000000aaaa", channelId: null };

describe("portability.json", () => {
  test("one account file with three sections and their column allow-lists", () => {
    expect(PORTABILITY_EXPORT_FILES.map((f) => [f.name, f.kind])).toEqual([["portability.json", "account"]]);
    const file = PORTABILITY_EXPORT_FILES[0]!;
    expect(Object.fromEntries(Object.entries(file.sections).map(([n, s]) => [n, Object.keys(s.fields)]))).toEqual({
      grants: ["channelSlug", "createdAt"],
      imports: [
        "id",
        "channelSlug",
        "source",
        "status",
        "standingVerified",
        "standingIssuer",
        "assertedAt",
        "assertionVersion",
        "createdAt",
        "finishedAt",
      ],
      moveLinks: ["id", "createdAt", "revokedAt", "expiresAt", "conversions"],
    });
  });

  test("every section is scoped to the member (or the channel they own) and reads no secret column", () => {
    const file = PORTABILITY_EXPORT_FILES[0]!;
    for (const [name, section] of Object.entries(file.sections)) {
      const { sql, params } = section.query(handle.db, scope).toSQL();
      expect([name, params]).toEqual([name, expect.arrayContaining([scope.userId])]);
      expect(sql).not.toMatch(/nonce_hash|archive_key|"choices"|"preview"|"result"|email/);
    }
    expect(file.sections.moveLinks!.query(handle.db, scope).toSQL().sql).toContain('"owner_id"');
    expect(file.sections.moveLinks!.query(handle.db, scope).toSQL().sql).toContain('"excluded_at" is null');
  });
});
