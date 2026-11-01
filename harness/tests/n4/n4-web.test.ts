// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N4-web's harness steps, pure parts: the ids they select by are the documented ones (or the
 * web's own extras), the routes are the documented pages, and only serious and critical axe
 * violations fail a step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { blockingViolations, FEDERATION_IDS, FEDERATION_ROUTES } from "../../src/n4/web.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const doc = readFileSync(`${ROOT}docs/testing/b7-selectors.md`, "utf8");
const webSource = ["settings.tsx", "followers.tsx", "blocks.tsx"]
  .map((f) => readFileSync(`${ROOT}apps/web/src/components/federation/${f}`, "utf8"))
  .join("\n");

describe("n4 web steps", () => {
  test("select by ids the web renders, documented unless they are the shared confirm or a web extra", () => {
    const ids = Object.values(FEDERATION_IDS);
    const ownIds = ids.filter((id) => id !== "confirm-dialog-confirm");
    const documented = ids.filter((id) => id !== "confirm-dialog-confirm" && id !== "federation-followers-more");
    expect(ownIds.filter((id) => !webSource.includes(`data-testid="${id}"`))).toEqual([]);
    expect(documented.filter((id) => !doc.includes(`| \`${id}\``))).toEqual([]);
  });

  test("open the documented pages", () => {
    expect(doc).toContain(`| \`${FEDERATION_ROUTES.admin}\``);
    expect(doc).toContain(`| \`${FEDERATION_ROUTES.studio}\``);
  });

  test("fail only on serious and critical axe violations", () => {
    const v = (id: string, impact: string | null) => ({ id, impact, help: `${id} help`, nodes: [1, 2] });
    expect(
      blockingViolations([
        v("color-contrast", "serious"),
        v("label", "critical"),
        v("region", "moderate"),
        v("landmark-one-main", "minor"),
        v("unknown", null),
      ]),
    ).toEqual([
      "axe color-contrast (serious): color-contrast help (2 nodes)",
      "axe label (critical): label help (2 nodes)",
    ]);
    expect(blockingViolations([])).toEqual([]);
  });
});
