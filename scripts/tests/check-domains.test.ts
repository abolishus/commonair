// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { SITE } from "../../packages/config/src/site.ts";
import { findStrayLiterals } from "../check-domains.ts";

describe("check-domains", () => {
  test("flags the domain and contacts in code, case-insensitively", () => {
    const problems = findStrayLiterals([
      ["apps/web/src/x.ts", `const u = "https://${SITE.domain.toUpperCase()}/x";`],
      ["services/api/src/y.ts", `send("${SITE.contacts.security}")`],
    ]);
    expect(problems).toHaveLength(3); // domain in URL, domain inside the email, and the email itself
    expect(problems[0]).toMatch(/^apps\/web\/src\/x\.ts:1:/);
  });

  test("allows the config module and prose", () => {
    expect(
      findStrayLiterals([
        ["packages/config/src/site.ts", SITE.domain],
        ["docs/decisions/0001-name.md", SITE.domain],
        ["SECURITY.md", SITE.contacts.security],
      ]),
    ).toEqual([]);
  });

  test("reports correct line numbers", () => {
    const [p] = findStrayLiterals([["a.ts", `a\nb\n${SITE.domain}`]]);
    expect(p).toMatch(/^a\.ts:3:/);
  });
});
