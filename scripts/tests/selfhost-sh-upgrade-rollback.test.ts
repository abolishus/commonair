// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Upgrades: backups, rollbacks and old releases. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { TIMEOUT, host, INSTALL, current, expectOk, useReleases } from "./support/selfhost-host.ts";

useReleases();

describe("upgrade", () => {
  test(
    "a failed migration rolls back as well",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      // Fails only for the new release (the stub reads the version ~/commonair points at).
      const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_MIGRATE_FAIL: "0.2.0" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("rolled back to 0.1.0, which is healthy");
      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
      // The new release's stack was never started.
      const calls = h.calls();
      const failed = calls.indexOf(
        "systemctl --user start commonair-migrate.service",
        calls.indexOf("systemctl --user start commonair-backup.service"),
      );
      expect(calls[failed + 1]).not.toMatch(/^systemctl --user start --no-block/);
      // The rollback cleared the start limit the failed migrate left before starting migrate again.
      const retry = calls.indexOf("systemctl --user start commonair-migrate.service", failed + 1);
      expect(retry).toBeGreaterThan(failed);
      const reset = calls.lastIndexOf("systemctl --user reset-failed commonair-*", retry);
      expect(reset).toBeGreaterThan(failed);
    },
    TIMEOUT,
  );

  test("a migration stuck behind a Postgres that never gets healthy times out and rolls back", () => {
    const h = host();
    expectOk(h.run(INSTALL));
    const started = Date.now();
    const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_MIGRATE_HANG: "0.2.0" });
    // COMMONAIR_HEALTH_TIMEOUT is 2 s; the stub gives up on its own only after 60 s.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(r.code).toBe(1);
    expect(r.err).toContain("migrations did not finish within 2s");
    expect(r.err).toContain("rolled back to 0.1.0, which is healthy");
    expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
    const calls = h.calls();
    const stop = calls.indexOf("systemctl --user stop commonair-migrate.service commonair-postgres.service");
    expect(stop).toBeGreaterThan(-1);
    // The new release's stack was never started; the rollback migrated and started the old one.
    const hung = calls.lastIndexOf("systemctl --user start commonair-migrate.service", stop);
    expect(calls.slice(hung, stop).some((c) => c.startsWith("systemctl --user start --no-block"))).toBe(false);
    const retry = calls.indexOf("systemctl --user start commonair-migrate.service", stop);
    expect(retry).toBeGreaterThan(stop);
    expect(calls.findIndex((c, i) => i > retry && c.startsWith("systemctl --user start --no-block"))).toBeGreaterThan(
      retry,
    );
  }, 90_000);

  test(
    "keeps only the current and the previous release on disk",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      expectOk(h.run(["upgrade", "--version", "v0.4.0"]));
      expect(readdirSync(join(h.home, ".local/share/commonair/releases")).sort()).toEqual(["0.2.0", "0.4.0"]);
    },
    TIMEOUT,
  );

  test(
    "refuses the version that is already installed, and needs an instance",
    () => {
      const h = host();
      expect(h.run(["upgrade", "--version", "v0.2.0"]).err).toContain("no instance installed here");
      expectOk(h.run(INSTALL));
      const r = h.run(["upgrade", "--version", "v0.1.0"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("version 0.1.0 is already installed");
    },
    TIMEOUT,
  );
});
