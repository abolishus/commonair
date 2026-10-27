// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Upgrades: the Podman network and foreign containers. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { TIMEOUT, host, INSTALL, current, expectOk, useReleases } from "./support/selfhost-host.ts";

useReleases();

describe("upgrade", () => {
  test(
    "an upgrade that would have to re-create a network a foreign container holds changes nothing",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const before = h.calls().length;
      const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_NETWORK_FOREIGN: "someone-elses-db" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("containers outside the instance use it: someone-elses-db");
      expect(r.err).toContain("nothing was changed");
      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
      // Nothing was stopped, backed up or removed.
      const during = h.calls().slice(before);
      expect(
        during.filter((c) => /^systemctl --user (stop|start commonair-backup)|^podman network rm/.test(c)),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a container named like ours but run by no installed unit counts as foreign",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_NETWORK_FOREIGN: "commonair-test-db" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("containers outside the instance use it: commonair-test-db");
    },
    TIMEOUT,
  );

  test(
    "a re-install checks the network before it stops anything",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const before = h.calls().length;
      const r = h.run([...INSTALL, "--reinstall"], { STUB_NETWORK_FOREIGN: "someone-elses-db" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("containers outside the instance use it: someone-elses-db");
      const during = h.calls().slice(before);
      expect(during.filter((c) => /^systemctl --user stop|^podman network rm/.test(c))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "our own containers on an old network do not block the upgrade; the network is re-created",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_NETWORK_FOREIGN: "commonair-api" });
      expect(r.code, r.err).toBe(0);
      expect(h.calls().some((c) => c.startsWith("podman network rm commonair"))).toBe(true);
    },
    TIMEOUT,
  );

  test.each([
    ["no lease range (a network from before IPRange)", ""],
    ["a lease range that covers 10.89.42.10", "10.89.42.2"],
  ])(
    "a network that cannot be re-created and has %s stops the start before migrations",
    (_name, lease) => {
      const h = host();
      const r = h.run(INSTALL, { STUB_NETWORK_RM_FAIL: "1", STUB_NETWORK_LEASE_START: lease });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("can lease the fixed addresses 10.89.42.10/.11");
      expect(h.calls().some((c) => c.startsWith("systemctl --user start commonair-migrate.service"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a failed pre-upgrade backup changes nothing",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_BACKUP_FAIL: "1" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("pre-upgrade backup failed; nothing was changed");
      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
    },
    TIMEOUT,
  );

  test(
    "rolls back to the previous release when the new one is not healthy",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      const r = h.run(["upgrade", "--version", "v0.3.0"], { STUB_BAD_VERSION: "0.3.0" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("rolling back to 0.2.0");
      expect(r.err).toContain("upgrade failed; rolled back to 0.2.0, which is healthy");
      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.2.0"));
      expect(readFileSync(join(h.home, ".config/containers/systemd/commonair-api.container"), "utf8")).toContain(
        ":0.2.0@sha256:",
      );
      // The rollback re-ran migrate before the stack, as any start does.
      const calls = h.calls();
      const lastReload = calls.lastIndexOf("systemctl --user daemon-reload");
      const migrate = calls.indexOf("systemctl --user start commonair-migrate.service", lastReload);
      expect(migrate).toBeGreaterThan(lastReload);
      expect(
        calls.findIndex((c, i) => i > migrate && c.startsWith("systemctl --user start --no-block")),
      ).toBeGreaterThan(migrate);
      expect(h.run(["status"]).out).toContain("version:   0.2.0");
    },
    TIMEOUT,
  );
});
