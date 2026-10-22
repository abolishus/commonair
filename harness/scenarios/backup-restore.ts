// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The backup/restore drill (docs/testing/e6-selectors.md, ADR 0021 §3): WAL-G backup of a
 * throwaway Postgres, wipe, restore with WAL replay, then every trigger, protection function and
 * app-role grant back, the ledger balanced, and the app role refused every protected write.
 * Never touches the running stack's database. Needs podman and the built Postgres image.
 */
import { runDrill } from "../src/drill/drill.ts";
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "backup-restore",
  description:
    "throwaway Postgres → migrate, demo seed + 20 ledger postings as the app role → fingerprint → WAL-G backup → marker + WAL switch → wipe → restore + replay → triggers, functions, grants, rows and ledger match; protected writes refused",
  needs: ["podman"],
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    await runDrill(ctx);
  },
});
