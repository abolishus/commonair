// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). `reset-staging`: the staging guard and the reset's order. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { linkExecutables } from "./support/exec-cache.ts";
import { type Host, TIMEOUT, host, INSTALL, expectOk, useReleases } from "./support/selfhost-host.ts";

useReleases();

const HOSTNAME = "stream.example.org";

/** An installed instance with DEMO_SEED_FULL set to `flag` (null: the line removed), and an empty call log. */
function installed(flag: string | null): Host {
  const h = host();
  expectOk(h.run(INSTALL));
  const file = join(h.home, ".config/commonair/commonair.env");
  const text = readFileSync(file, "utf8").replace(/^DEMO_SEED_FULL=.*\n/m, "");
  writeFileSync(file, flag === null ? text : `${text}DEMO_SEED_FULL=${flag}\n`);
  writeFileSync(h.log, "");
  return h;
}

/** Calls other than check_systemd's read-only probes. */
const changes = (h: Host) =>
  h.calls().filter((c) => c !== "" && c !== "systemctl --version" && c !== "systemctl --user show-environment");

describe("reset-staging refuses", () => {
  test.each([
    ["DEMO_SEED_FULL=false", "false", ["--confirm", HOSTNAME], "DEMO_SEED_FULL is false"],
    ["DEMO_SEED_FULL unset", null, ["--confirm", HOSTNAME], "DEMO_SEED_FULL is unset"],
    ["DEMO_SEED_FULL=yes", "yes", ["--confirm", HOSTNAME], "DEMO_SEED_FULL is yes"],
    ["no --confirm", "true", [], `pass --confirm ${HOSTNAME}`],
    ["a wrong --confirm", "true", ["--confirm", "prod.example.org"], "is not this instance (stream.example.org)"],
    ["a --confirm that only contains the host", "true", ["--confirm", `${HOSTNAME}.evil`], "is not this instance"],
    ["an empty --confirm", "true", ["--confirm", ""], "--confirm needs a value"],
  ])(
    "%s, touching nothing",
    (_, flag, args, message) => {
      const h = installed(flag);
      const r = h.run(["reset-staging", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
      expect(changes(h)).toEqual([]);
    },
    TIMEOUT,
  );

  test("before any install, and as root", () => {
    const h = host();
    const none = h.run(["reset-staging", "--confirm", HOSTNAME]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("no instance installed here");
    linkExecutables(join(h.dir, "stub"), { id: `#!/bin/sh\ncase "$*" in "-u") echo 0 ;; *) echo root ;; esac\n` });
    const root = h.run(["reset-staging", "--confirm", HOSTNAME]);
    expect(root.code).toBe(1);
    expect(root.err).toContain("reset-staging runs as the user that owns the instance, not as root");
    expect(h.calls()).toEqual([]);
  });

  test("an unknown option", () => {
    const h = host();
    const r = h.run(["reset-staging", "--wipe-everything"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown reset-staging option: --wipe-everything");
    expect(h.calls()).toEqual([]);
  });
});

describe("reset-staging on a staging instance", () => {
  const order = (h: Host) => {
    const calls = h.calls();
    const at = (pred: (c: string) => boolean) => calls.findIndex(pred);
    return {
      calls,
      stop: at((c) => c.startsWith("systemctl --user stop")),
      drop: at(
        (c) => c.startsWith("podman exec --user postgres commonair-postgres psql") && c.includes("DROP DATABASE"),
      ),
      flush: at((c) => c.startsWith("podman exec commonair-valkey") && c.includes("FLUSHALL")),
      migrate: at((c) => c === "systemctl --user start commonair-migrate.service"),
      seed: at((c) => c.startsWith("podman run") && c.includes("packages/db/src/demo/cli.ts seed")),
      start: at((c) => c.startsWith("systemctl --user start --no-block") && c.includes("commonair-api.service")),
      health: calls.findLastIndex((c) => c.startsWith("podman inspect")),
    };
  };

  test(
    "stop, drop and recreate, flush, migrate, start, health; prints the next step",
    () => {
      const h = installed("true");
      const r = h.run(["reset-staging", "--confirm", HOSTNAME]);
      expectOk(r);
      const o = order(h);
      expect(o.stop).toBeGreaterThan(-1);
      expect(o.drop).toBeGreaterThan(o.stop);
      expect(o.flush).toBeGreaterThan(o.drop);
      expect(o.migrate).toBeGreaterThan(o.flush);
      expect(o.start).toBeGreaterThan(o.migrate);
      expect(o.health).toBeGreaterThan(o.start);
      // No base seed without --base-seed: the full seed needs a database without users.
      expect(o.seed).toBe(-1);

      const stop = o.calls[o.stop]!;
      for (const u of ["api", "worker", "web", "chat", "migrate", "caddy"]) expect(stop).toContain(`commonair-${u}.`);
      for (const u of ["postgres", "valkey", "garage"]) expect(stop).not.toContain(`commonair-${u}.service`);
      expect(o.calls[o.drop]).toContain("CREATE DATABASE commonair OWNER commonair");
      expect(o.calls[o.drop]).toContain("-U commonair -d postgres");
      // Nothing touched object storage.
      expect(o.calls.filter((c) => c.startsWith("podman exec commonair-garage"))).toEqual([]);

      expect(r.err).toContain("every row in its database is deleted");
      expect(r.out).toContain(`Reset ${HOSTNAME}`);
      expect(r.out).toContain("Not reset: object storage");
      expect(r.out).toContain(
        "DEMO_SEED_FULL=true bun harness/src/cli.ts seed full --confirm postgres:5432/commonair --scale medium",
      );
    },
    TIMEOUT,
  );

  test(
    "--base-seed runs demo:seed after the migrations and before the start; the password passes by name",
    () => {
      const h = installed("true");
      const r = h.run(["reset-staging", "--confirm", HOSTNAME, "--base-seed"], {
        DEMO_SEED_PASSWORD: "staging-demo-pass-123",
      });
      expectOk(r);
      const o = order(h);
      expect(o.seed).toBeGreaterThan(o.migrate);
      expect(o.start).toBeGreaterThan(o.seed);
      const seed = o.calls[o.seed]!;
      expect(seed).toContain("--network commonair");
      expect(seed).toContain("--secret commonair-owner-database-url,type=env,target=DATABASE_URL");
      expect(seed).toContain("--env=DEMO_SEED_PASSWORD");
      expect(seed).toMatch(/\/commonair\/tools:0\.1\.0@sha256:[0-9a-f]{64} bun packages\/db\/src\/demo\/cli\.ts seed$/);
      expect(o.calls.join("\n")).not.toContain("staging-demo-pass-123");
      expect(r.out).toContain("seed full refuses a database with users");
    },
    TIMEOUT,
  );

  test(
    "DEMO_SEED_FULL=1 counts as true, as packages/config reads it",
    () => {
      const h = installed("1");
      expectOk(h.run(["reset-staging", "--confirm", HOSTNAME]));
    },
    TIMEOUT,
  );
});

describe("reset-staging help", () => {
  test("--help lists the command and its options", () => {
    const r = host().run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  reset-staging");
    expect(r.out).toContain("--confirm <host>");
    expect(r.out).toContain("--base-seed");
    expect(host().run(["reset-staging", "--help"]).out).toContain("Usage: selfhost.sh");
  });
});
