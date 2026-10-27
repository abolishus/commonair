// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Re-installing over an existing instance. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { TIMEOUT, host, INSTALL, envOf, expectOk, mode, useReleases } from "./support/selfhost-host.ts";

useReleases();

describe("re-install", () => {
  test(
    "refuses without --reinstall (also with --yes), and keeps every secret with --reinstall",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const before = envOf(h);
      const secretsBefore = readFileSync(join(h.dir, "state/secrets/commonair-owner-database-url"), "utf8");

      const again = h.run(INSTALL);
      expect(again.code).toBe(1);
      expect(again.err).toContain("an instance is already installed (version 0.1.0)");
      expect(envOf(h)).toEqual(before);

      // --yes is root's consent to prepare the host, never to reinstall.
      const onlyYes = h.run([...INSTALL, "--yes"]);
      expect(onlyYes.code).toBe(1);
      expect(onlyYes.err).toContain("re-run with --reinstall");

      const yes = h.run([...INSTALL.slice(0, 3), "--reinstall"]);
      expect(yes.code, yes.err).toBe(0);
      const after = envOf(h);
      for (const key of Object.keys(before).filter((k) => /SECRET|PASSWORD|_KEY|TOKEN/.test(k)))
        expect(after[key], key).toBe(before[key]);
      // Domain and contacts were kept from the first run.
      expect(after.PUBLIC_HOSTNAME).toBe("stream.example.org");
      expect(readFileSync(join(h.dir, "state/secrets/commonair-owner-database-url"), "utf8")).toBe(secretsBefore);
      expect(mode(join(h.home, ".config/commonair/commonair.env"))).toBe(0o600);
    },
    TIMEOUT,
  );

  test(
    "an operator's edits to contacts survive a re-install",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^ABUSE_EMAIL=.*$/m, "ABUSE_EMAIL=abuse@example.net"));
      expectOk(h.run([...INSTALL, "--reinstall"]));
      expect(envOf(h).ABUSE_EMAIL).toBe("abuse@example.net");
    },
    TIMEOUT,
  );

  test(
    "a re-install keeps the WebRTC address unless a new --public-ip is given",
    () => {
      const h = host();
      expectOk(h.run([...INSTALL, "--public-ip", "203.0.113.7"]));
      const file = join(h.home, ".config/commonair/commonair.env");
      // An operator behind NAT corrects the address by hand.
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(/^MTX_WEBRTCADDITIONALHOSTS=.*$/m, "MTX_WEBRTCADDITIONALHOSTS=198.51.100.9"),
      );
      expectOk(h.run([...INSTALL, "--reinstall"]));
      expect(envOf(h).MTX_WEBRTCADDITIONALHOSTS).toBe("198.51.100.9");
      expectOk(h.run([...INSTALL, "--reinstall", "--public-ip", "203.0.113.8"]));
      expect(envOf(h).MTX_WEBRTCADDITIONALHOSTS).toBe("203.0.113.8");
      // Keys init-env does not know (not in .env.example) survive the env rewrite.
      writeFileSync(file, `${readFileSync(file, "utf8")}OPERATOR_NOTE=kept\n`);
      expectOk(h.run([...INSTALL, "--reinstall"]));
      expect(envOf(h)).toMatchObject({ MTX_WEBRTCADDITIONALHOSTS: "203.0.113.8", OPERATOR_NOTE: "kept" });
    },
    TIMEOUT,
  );

  test(
    "a re-install points S3_PUBLIC_ENDPOINT at a new domain, but keeps an external store's",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      expectOk(h.run(["install", "--reinstall", "--domain", "tv.example.org"]));
      expect(envOf(h)).toMatchObject({
        PUBLIC_HOSTNAME: "tv.example.org",
        S3_PUBLIC_ENDPOINT: "https://tv.example.org",
      });
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(/^S3_PUBLIC_ENDPOINT=.*$/m, "S3_PUBLIC_ENDPOINT=https://s3.example.net"),
      );
      expectOk(h.run(["install", "--reinstall", "--domain", "stream.example.org"]));
      expect(envOf(h)).toMatchObject({
        PUBLIC_HOSTNAME: "stream.example.org",
        S3_PUBLIC_ENDPOINT: "https://s3.example.net",
      });
    },
    TIMEOUT,
  );

  test(
    "operator drop-in directories survive a re-install",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const quadletDropIn = join(h.home, ".config/containers/systemd/commonair-media.container.d");
      const serviceDropIn = join(h.home, ".config/systemd/user/commonair-backup.service.d");
      for (const d of [quadletDropIn, serviceDropIn]) {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "10-local.conf"), "[Unit]\n");
      }
      expectOk(h.run([...INSTALL, "--reinstall"]));
      expect(existsSync(join(quadletDropIn, "10-local.conf"))).toBe(true);
      expect(existsSync(join(serviceDropIn, "10-local.conf"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a re-install after a failed migration is not refused by the start limit",
    () => {
      const h = host();
      expect(h.run(INSTALL, { STUB_MIGRATE_FAIL: "0.1.0" }).code).toBe(1);
      expectOk(h.run([...INSTALL, "--reinstall"]));
      expect(h.calls()).toContain("systemctl --user reset-failed commonair-*");
    },
    TIMEOUT,
  );

  test(
    "~/commonair that is not a link (a git clone) is never replaced",
    () => {
      const h = host();
      mkdirSync(join(h.home, "commonair"));
      const r = h.run([...INSTALL, "--reinstall"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is not a symlink");
      expect(statSync(join(h.home, "commonair")).isDirectory()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a mirror registry is used for our images and remembered for upgrades",
    () => {
      const h = host();
      expectOk(h.run([...INSTALL, "--registry", "zot.internal:5000/commonair"]));
      const api = readFileSync(join(h.home, ".config/containers/systemd/commonair-api.container"), "utf8");
      expect(api).toMatch(/^Image=zot\.internal:5000\/commonair\/api:0\.1\.0@sha256:/m);
      const caddy = readFileSync(join(h.home, ".config/containers/systemd/commonair-caddy.container"), "utf8");
      expect(caddy).toMatch(/^Image=docker\.io\/library\/caddy:/m);
      expect(readFileSync(join(h.home, ".config/commonair/selfhost.conf"), "utf8")).toBe(
        "REGISTRY=zot.internal:5000/commonair\n",
      );
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      const pulls = h.calls().filter((c) => c.startsWith("podman pull") && c.includes(":0.2.0@"));
      expect(pulls.length).toBeGreaterThan(0);
      for (const p of pulls) expect(p).toContain("zot.internal:5000/commonair/");
    },
    TIMEOUT,
  );
});
