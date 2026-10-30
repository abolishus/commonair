// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Upgrades: ordering, env backfills and Valkey passwords. */
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { TIMEOUT, host, INSTALL, envOf, current, expectOk, mode, useReleases } from "./support/selfhost-host.ts";

useReleases();

describe("upgrade", () => {
  test(
    "verify, pull, back up, install units, migrate before api and worker, health",
    () => {
      const h = host();
      expectOk(h.run([...INSTALL, "--public-ip", "203.0.113.7"]));
      const mtxBefore = envOf(h).MTX_WEBRTCADDITIONALHOSTS;
      expect(mtxBefore).toBe("203.0.113.7");
      Bun.spawnSync(["sh", "-c", `: > "${h.log}"`]);
      const r = h.run(["upgrade", "--version", "v0.2.0"]);
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("upgraded to 0.2.0");

      const calls = h.calls();
      const at = (pred: (c: string) => boolean) => calls.findIndex(pred);
      const verified = at((c) => c.includes("curl") && c.includes("commonair-selfhost_0.2.0.tar.gz"));
      const firstPull = at((c) => c.startsWith("podman pull"));
      const lastPull = calls.length - 1 - [...calls].reverse().findIndex((c) => c.startsWith("podman pull"));
      const backup = at((c) => c === "systemctl --user start commonair-backup.service");
      const reload = at((c) => c === "systemctl --user daemon-reload");
      const stop = at((c) => c.startsWith("systemctl --user stop"));
      const migrate = at((c) => c === "systemctl --user start commonair-migrate.service");
      const stack = at((c) => c.startsWith("systemctl --user start --no-block"));
      expect(verified).toBeGreaterThan(-1);
      expect(firstPull).toBeGreaterThan(verified);
      expect(backup).toBeGreaterThan(lastPull);
      expect(reload).toBeGreaterThan(backup);
      expect(stop).toBeGreaterThan(reload);
      expect(migrate).toBeGreaterThan(stop);
      expect(stack).toBeGreaterThan(migrate);
      for (const s of ["api", "worker"]) {
        expect(calls[stop]).toContain(`commonair-${s}.service`);
        expect(calls[stack]).toContain(`commonair-${s}.service`);
      }

      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.2.0"));
      expect(readlinkSync(join(h.home, ".local/share/commonair/previous"))).toBe(
        join(h.home, ".local/share/commonair/releases/0.1.0"),
      );
      // The upgrade rewrites the env file through init-env; keys outside .env.example stay.
      expect(envOf(h).MTX_WEBRTCADDITIONALHOSTS).toBe(mtxBefore);
      const status = h.run(["status"]).out;
      expect(status).toContain("version:   0.2.0");
      expect(status).toContain("previous:  0.1.0");
      expect(readFileSync(join(h.home, ".config/containers/systemd/commonair-api.container"), "utf8")).toContain(
        ":0.2.0@sha256:",
      );
    },
    TIMEOUT,
  );

  test(
    "backfills S3_PUBLIC_ENDPOINT into an env file written before ADR 0024",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      // An install from before the change: the line is missing entirely.
      writeFileSync(file, readFileSync(file, "utf8").replace(/^S3_PUBLIC_ENDPOINT=.*\n/m, ""));
      expect(envOf(h).S3_PUBLIC_ENDPOINT).toBeUndefined();
      const r = h.run(["upgrade", "--version", "v0.2.0"]);
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("setting S3_PUBLIC_ENDPOINT=https://stream.example.org");
      expect(envOf(h).S3_PUBLIC_ENDPOINT).toBe("https://stream.example.org");
      expect(readFileSync(file, "utf8").match(/^S3_PUBLIC_ENDPOINT=/gm)).toHaveLength(1);
      expect(mode(file)).toBe(0o600);
    },
    TIMEOUT,
  );

  test(
    "gives an env file from before Valkey had a password one, and the URL that carries it",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      // An install from before: no VALKEY_PASSWORD, and init-env's development URL.
      writeFileSync(
        file,
        readFileSync(file, "utf8")
          .replace(/^VALKEY_PASSWORD=.*\n/m, "")
          .replace(/^VALKEY_URL=.*$/m, "VALKEY_URL=redis://localhost:6379"),
      );
      const r = h.run(["upgrade", "--version", "v0.2.0"]);
      expect(r.code, r.err).toBe(0);
      const env = envOf(h);
      expect(env.VALKEY_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
      expect(env.VALKEY_URL).toBe(`redis://:${env.VALKEY_PASSWORD}@valkey:6379`);
      expect(readFileSync(join(h.dir, "state/secrets/commonair-valkey-url"), "utf8")).toBe(env.VALKEY_URL);
      expect(r.out + r.err).not.toContain(env.VALKEY_PASSWORD!);
    },
    TIMEOUT,
  );

  test(
    "keeps an existing Valkey password across upgrades",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const before = envOf(h).VALKEY_PASSWORD;
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      expect(envOf(h).VALKEY_PASSWORD).toBe(before);
    },
    TIMEOUT,
  );

  test.each([
    ["empty", "VALKEY_PASSWORD=", "has no VALKEY_PASSWORD"],
    ["not URL-safe", "VALKEY_PASSWORD=a/b@c", "may hold only letters"],
  ])(
    "refuses a Valkey password that is %s",
    (_, line, message) => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^VALKEY_PASSWORD=.*$/m, line));
      const r = h.run(["install", "--reinstall"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
    },
    TIMEOUT,
  );

  test(
    "backfills an empty S3_PUBLIC_ENDPOINT (init-env's default) too",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^S3_PUBLIC_ENDPOINT=.*$/m, "S3_PUBLIC_ENDPOINT="));
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      expect(envOf(h).S3_PUBLIC_ENDPOINT).toBe("https://stream.example.org");
    },
    TIMEOUT,
  );

  test(
    "never overwrites an operator's S3_PUBLIC_ENDPOINT (an external store)",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(/^S3_PUBLIC_ENDPOINT=.*$/m, "S3_PUBLIC_ENDPOINT=https://s3.example.net"),
      );
      const r = h.run(["upgrade", "--version", "v0.2.0"]);
      expect(r.code, r.err).toBe(0);
      expect(r.err).not.toContain("setting S3_PUBLIC_ENDPOINT");
      expect(envOf(h).S3_PUBLIC_ENDPOINT).toBe("https://s3.example.net");
    },
    TIMEOUT,
  );

  test(
    "web push (ADR 0028): off on a first install with a VAPID pair; the flags set it; kept when absent",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const fresh = envOf(h);
      expect(fresh.WEB_PUSH_ENABLED).toBe("false");
      expect(fresh.VAPID_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{87}$/);
      expect(fresh.VAPID_PRIVATE_KEY?.length).toBeGreaterThan(32);
      expectOk(h.run(["install", "--reinstall", "--web-push"]));
      expect(envOf(h).WEB_PUSH_ENABLED).toBe("true");
      // Without either flag the upgrade keeps it, and keeps the pair.
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      const after = envOf(h);
      expect(after.WEB_PUSH_ENABLED).toBe("true");
      expect([after.VAPID_PUBLIC_KEY, after.VAPID_PRIVATE_KEY]).toEqual([
        fresh.VAPID_PUBLIC_KEY,
        fresh.VAPID_PRIVATE_KEY,
      ]);
      expectOk(h.run(["install", "--reinstall", "--no-web-push"]));
      expect(envOf(h).WEB_PUSH_ENABLED).toBe("false");
    },
    TIMEOUT,
  );

  test(
    "an upgrade from before N1 gets a VAPID pair, and --no-web-push turns push off",
    () => {
      const h = host();
      expectOk(h.run([...INSTALL, "--web-push"]));
      const file = join(h.home, ".config/commonair/commonair.env");
      expect(envOf(h).WEB_PUSH_ENABLED).toBe("true");
      // The pair's lines are missing entirely in an older env file.
      writeFileSync(file, readFileSync(file, "utf8").replace(/^VAPID_(PUBLIC|PRIVATE)_KEY=.*\n/gm, ""));
      const r = h.run(["upgrade", "--version", "v0.2.0", "--no-web-push"]);
      expect(r.code, r.err).toBe(0);
      const env = envOf(h);
      expect(env.WEB_PUSH_ENABLED).toBe("false");
      expect(env.VAPID_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{87}$/);
      expect(r.out + r.err).not.toContain(env.VAPID_PRIVATE_KEY!);
    },
    TIMEOUT,
  );

  test(
    "--web-push refuses an env file with an emptied VAPID key",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^VAPID_PRIVATE_KEY=.*$/m, "VAPID_PRIVATE_KEY="));
      const r = h.run(["install", "--reinstall", "--web-push"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--web-push needs the VAPID key pair");
    },
    TIMEOUT,
  );

  test(
    "a network whose lease range already leaves out the trusted addresses is kept, not re-created",
    () => {
      const h = host();
      const r = h.run(INSTALL, { STUB_NETWORK_RM_FAIL: "1", STUB_NETWORK_LEASE_START: "10.89.42.129" });
      expect(r.code, r.err).toBe(0);
      expect(h.calls().some((c) => c.startsWith("podman network rm"))).toBe(false);
    },
    TIMEOUT,
  );
});
