// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The self-host e2e's options, its pull-through mirror (scripts/selfhost/e2e-mirror.ts) and
 * where it runs the checks of e2e-irc.ts, e2e-s3.ts, e2e-external.ts and the generated units'
 * ExecStopPost= order. The e2e itself needs a privileged Podman; these are the parts that do not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  MIRROR_CONF_PATH,
  MIRROR_CONTAINER,
  MIRROR_DIR,
  MIRROR_UPSTREAMS,
  mirrorRegistriesConf,
  mirrorRunArgs,
  mirrorWanted,
  mirrorZotConfig,
} from "../../scripts/selfhost/e2e-mirror.ts";
import { ZOT_IMAGE, e2eOptions, timingsTable, withoutPorts } from "../../scripts/selfhost/e2e.ts";
import {
  E2E_STATE,
  MAKE_CERTS,
  POSTGRES_IMAGE,
  VALKEY_IMAGE,
  VALKEY_RULES,
  externalStateEnv,
  externalStateFlags,
  setupScript,
} from "../../scripts/selfhost/e2e-external.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const E2E = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");

describe("e2eOptions", () => {
  test("defaults: Debian, the instance's own Garage, Postgres and Valkey, the default mirror choice, no --keep", () => {
    expect(e2eOptions([])).toEqual({
      distro: "debian",
      storage: "garage",
      state: "bundled",
      keep: false,
      mirror: undefined,
    });
  });

  test("every option", () => {
    expect(e2eOptions(["--distro", "fedora", "--storage", "external", "--keep", "--no-mirror"])).toEqual({
      distro: "fedora",
      storage: "external",
      state: "bundled",
      keep: true,
      mirror: false,
    });
    expect(e2eOptions(["--state", "external", "--storage", "external"])).toMatchObject({
      state: "external",
      storage: "external",
    });
    expect(e2eOptions(["--mirror"]).mirror).toBe(true);
    // The last of --mirror / --no-mirror wins, as with most command lines.
    expect(e2eOptions(["--mirror", "--no-mirror"]).mirror).toBe(false);
  });

  test.each([
    [["--distro", "ubuntu"], "--distro must be debian or fedora, not ubuntu"],
    [["--distro"], "--distro must be debian or fedora, not nothing"],
    [["--storage", "s3"], "--storage must be garage or external, not s3"],
    [["--storage", "--keep"], "--storage must be garage or external, not --keep"],
    [["--state", "managed"], "--state must be bundled or external, not managed"],
    [["--state", "external", "--storage", "garage"], "--state external runs with --storage external"],
    [["--strorage", "external"], "unknown option --strorage"],
    [["fedora"], "unknown option fedora"],
    [["-k"], "unknown option -k"],
  ])("%j is refused, not ignored", (argv, message) => {
    expect(() => e2eOptions(argv)).toThrow(message);
  });
});

describe("--state external: external Postgres and Valkey on managed-service terms (S1-b)", () => {
  test("implies the external store: an instance on managed services", () => {
    expect(e2eOptions(["--state", "external"])).toMatchObject({ state: "external", storage: "external" });
  });

  test("the servers use the images the stack already pins (decision (q))", () => {
    expect(POSTGRES_IMAGE).toMatch(/^docker\.io\/library\/postgres:17\.\S+@sha256:[0-9a-f]{64}$/);
    expect(VALKEY_IMAGE).toMatch(/^ghcr\.io\/valkey-io\/valkey:\S+@sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(ROOT, "infra/quadlet/commonair-valkey.container"), "utf8")).toContain(
      `Image=${VALKEY_IMAGE}`,
    );
  });

  test("Postgres: TLS only, a CREATEROLE owner with no superuser, a database it owns", () => {
    const script = setupScript();
    expect(script).toContain("hostssl all all 0.0.0.0/0 scram-sha-256");
    expect(script).not.toMatch(/^host all/m);
    expect(script).toContain(`create role ${E2E_STATE.owner} login createrole password :'pw';`);
    expect(script).not.toMatch(/superuser|bypassrls/i);
    expect(script).toContain(`create database ${E2E_STATE.database} owner ${E2E_STATE.owner};`);
    // The certificate names the host the instance reaches, from a CA made for the run.
    expect(MAKE_CERTS).toContain(`subjectAltName=DNS:${E2E_STATE.host}`);
  });

  test("Valkey: TLS only, the password-only default user and an ACL user, neither with @admin or @dangerous", () => {
    const script = setupScript();
    expect(script).toContain("--port 0 --tls-port 6380");
    expect(script).toContain("--maxmemory-policy noeviction");
    expect(VALKEY_RULES).toBe('"~*" "&*" +@all -@admin -@dangerous +info');
    expect(script).toContain(`--user default on ">$VK_DEFAULT" ${VALKEY_RULES}`);
    expect(script).toContain(`--user ${E2E_STATE.aclUser} on ">$VK_ACL" ${VALKEY_RULES}`);
  });

  test("the install's flags carry no password; the passwords go in its environment", () => {
    for (const user of ["acl", "default"] as const) {
      const flags = externalStateFlags(user);
      const env = externalStateEnv(user);
      expect(flags).toContain("?sslmode=verify-full");
      expect(flags).toContain(`--database-ca ${E2E_STATE.dir}/ca.crt`);
      for (const v of Object.values(env)) {
        expect(flags).not.toContain(v);
        expect(flags).not.toContain(encodeURIComponent(v));
      }
      expect(Object.keys(env).sort()).toEqual(["DATABASE_PASSWORD", "VALKEY_PASSWORD"]);
    }
    expect(externalStateFlags("acl")).toContain(`rediss://${E2E_STATE.aclUser}@${E2E_STATE.host}:`);
    expect(externalStateFlags("default")).toContain(`rediss://${E2E_STATE.host}:`);
  });
});

describe("timingsTable", () => {
  test("one aligned row per step and the total", () => {
    const table = timingsTable([
      ["install 0.0.0-e2e.1", 238.04],
      ["start the pull-through mirror", 1.2],
    ]);
    expect(table.split("\n")).toEqual([
      "install 0.0.0-e2e.1              238.0 s",
      "start the pull-through mirror      1.2 s",
      "total                            239.2 s",
    ]);
  });

  test("no steps: only the total", () => {
    expect(timingsTable([])).toBe("total      0.0 s");
  });
});

describe("withoutPorts: the e2e's own fixtures are not the instance's listeners", () => {
  const ss = [
    "LISTEN 0 4096 *:443 *:* uid:1000 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/x",
    "LISTEN 0 4096 0.0.0.0:3910 0.0.0.0:* cgroup:/machine.slice/libpod-conmon-abc.scope",
    "LISTEN 0 4096 [::]:3910 [::]:* cgroup:/machine.slice/libpod-conmon-abc.scope",
    "LISTEN 0 4096 127.0.0.1:39100 0.0.0.0:* cgroup:/user.slice/x",
  ].join("\n");

  test("drops exactly the given ports, on any address", () => {
    expect(withoutPorts(ss, new Set([3910])).split("\n")).toEqual([
      expect.stringContaining("*:443"),
      expect.stringContaining("127.0.0.1:39100"),
    ]);
  });

  test("no ports: unchanged", () => {
    expect(withoutPorts(ss, new Set())).toBe(ss);
  });
});

describe("pull-through mirror", () => {
  const config = JSON.parse(mirrorZotConfig()) as {
    storage: { rootDirectory: string; gc: boolean };
    http: { address: string; port: string; compat: string[] };
    extensions: {
      sync: {
        enable: boolean;
        registries: { urls: string[]; onDemand: boolean; tlsVerify: boolean; content: object[] }[];
      };
    };
  };

  test("Zot syncs on demand from each upstream over TLS, each under its own prefix", () => {
    expect(config.extensions.sync.enable).toBe(true);
    expect(config.extensions.sync.registries).toEqual(
      Object.entries(MIRROR_UPSTREAMS).map(([name, url]) =>
        expect.objectContaining({
          urls: [url],
          onDemand: true,
          tlsVerify: true,
          content: [{ prefix: "**", destination: `/${name}` }],
        }),
      ),
    );
    expect(Object.keys(MIRROR_UPSTREAMS)).toEqual(["docker.io", "ghcr.io", "quay.io"]);
  });

  test("keeps Docker media types and everything it fetched", () => {
    // Without docker2s2 a Docker manifest list would be served in another form: a new digest.
    expect(config.http.compat).toEqual(["docker2s2"]);
    expect(config.storage).toEqual(expect.objectContaining({ rootDirectory: "/var/lib/registry", gc: false }));
    expect(config.http).toEqual(expect.objectContaining({ address: "0.0.0.0", port: "5000" }));
  });

  test("every third-party image of the instance comes from a mirrored registry", () => {
    const dir = join(ROOT, "infra/quadlet");
    const images = readdirSync(dir)
      .filter((f) => f.endsWith(".container"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^Image=(.*)$/gm)].map((m) => m[1]!))
      .filter((i) => !i.startsWith("localhost/"));
    expect(images.length).toBeGreaterThanOrEqual(6);
    for (const image of images) {
      expect(Object.keys(MIRROR_UPSTREAMS)).toContain(image.slice(0, image.indexOf("/")));
      // A mirror can serve only what the digest names.
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  test("the host's registries.conf.d entry: the mirror for each upstream, plain HTTP", () => {
    expect(mirrorRegistriesConf("10.89.0.3")).toBe(
      [
        "[[registry]]",
        'location = "docker.io"',
        "[[registry.mirror]]",
        'location = "10.89.0.3:5000/docker.io"',
        "insecure = true",
        "",
        "[[registry]]",
        'location = "ghcr.io"',
        "[[registry.mirror]]",
        'location = "10.89.0.3:5000/ghcr.io"',
        "insecure = true",
        "",
        "[[registry]]",
        'location = "quay.io"',
        "[[registry.mirror]]",
        'location = "10.89.0.3:5000/quay.io"',
        "insecure = true",
        "",
      ].join("\n"),
    );
  });

  test("an IPv6 address is bracketed; anything but an address is refused (it goes into a heredoc)", () => {
    expect(mirrorRegistriesConf("fd00::3")).toContain('location = "[fd00::3]:5000/quay.io"');
    for (const bad of ["", "zot", "10.0.0.1\nEOF", '1.2.3.4"'])
      expect(() => mirrorRegistriesConf(bad)).toThrow(/not an IP address/);
  });

  test("its file sorts before the e2e registry's 50-e2e.conf", () => {
    expect(MIRROR_CONF_PATH).toBe("/etc/containers/registries.conf.d/40-e2e-mirror.conf");
    expect(E2E).toContain("/etc/containers/registries.conf.d/50-e2e.conf");
  });

  test("runs the e2e's pinned Zot with outer-Podman 4.9 flags, its cache kept between runs", () => {
    const args = mirrorRunArgs(ZOT_IMAGE, "commonair-e2e-net", "/repo/.cache/selfhost-e2e-mirror");
    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      MIRROR_CONTAINER,
      "--network",
      "commonair-e2e-net",
      "-v",
      "/repo/.cache/selfhost-e2e-mirror/config.json:/etc/zot/config.json:ro",
      "-v",
      "/repo/.cache/selfhost-e2e-mirror/data:/var/lib/registry",
      ZOT_IMAGE,
    ]);
    // Each run starts by removing .cache/selfhost-e2e/; the cache lives beside it.
    expect(MIRROR_DIR).toBe(join(ROOT, ".cache/selfhost-e2e-mirror"));
  });

  test("on by default locally, off on CI, the flag decides either way", () => {
    expect(mirrorWanted(undefined, {})).toBe(true);
    expect(mirrorWanted(undefined, { CI: "true" })).toBe(false);
    expect(mirrorWanted(true, { CI: "true" })).toBe(true);
    expect(mirrorWanted(false, {})).toBe(false);
  });

  test("the e2e writes the host entry before the install pulls anything, and removes the container", () => {
    const host = E2E.indexOf("await startHost(distro, model, zotAddress);");
    expect(host).toBeGreaterThan(0);
    expect(E2E.indexOf("mirrorRegistriesConf(mirrorAddress)")).toBeGreaterThan(host);
    expect(E2E.indexOf("mirrorRegistriesConf(mirrorAddress)")).toBeLessThan(E2E.indexOf("await step(`install"));
    expect(E2E).toMatch(/for \(const c of \[HOST, ZOT, MIRROR_CONTAINER\]\)/);
  });
});

/** The body of the step whose name starts with `name`, up to the next step. */
function stepBody(name: string): string {
  const start = Math.max(E2E.indexOf(`await step(\`${name}`), E2E.indexOf(`await step("${name}`));
  expect(start, name).toBeGreaterThan(0);
  const next = E2E.indexOf("await step(", start + 1);
  return E2E.slice(start, next === -1 ? undefined : next);
}
const callsIn = (body: string) => [...body.matchAll(/^\s+(check\w+)\(/gm)].map((m) => m[1]!);

describe("wiring of the other units' checks", () => {
  test("install: IRC client addresses right after the API's, then the ExecStopPost= order", () => {
    const calls = callsIn(stepBody("install"));
    expect(calls.indexOf("checkIrcClientAddresses")).toBe(calls.indexOf("checkClientAddresses") + 1);
    expect(calls.at(-1)).toBe("checkStopPostOrder");
  });

  test("upgrade: IRC client addresses next to the repeated listener check, and the order again", () => {
    const calls = callsIn(stepBody("release ${v2}"));
    expect(calls.indexOf("checkIrcClientAddresses")).toBe(calls.indexOf("checkListeners") + 1);
    expect(calls).toContain("checkStopPostOrder");
  });

  test("external store: set up before the install, its flags and keys passed, checked instead of Caddy's S3 route", () => {
    const setup = stepBody("start the external S3 store");
    expect(setup).toContain("externalStoreSetup(inHost, expectThat);");
    expect(E2E.indexOf('await step("start the external S3 store"')).toBeLessThan(E2E.indexOf("await step(`install"));
    const install = stepBody("install");
    expect(install).toContain("externalInstallFlags()");
    expect(install).toContain("...(external ? externalInstallEnv() : {})");
    for (const body of [install, stepBody("release ${v2}")]) {
      const calls = callsIn(body);
      expect(calls).toContain("checkExternalStore");
      expect(calls).toContain("checkBrowserStorage");
      expect(body).toMatch(
        /if \(external\) \{\s+(\/\/[^\n]*\s+)?checkExternalStore\(inHost, expectThat\);\s+\} else \{/,
      );
    }
  });

  test("external state: set up before the install, checked after install, upgrade, the default user and the rollback", () => {
    expect(E2E.indexOf('await step("start the external Postgres and Valkey"')).toBeGreaterThan(
      E2E.indexOf('await step("start the external S3 store"'),
    );
    expect(E2E.indexOf('await step("start the external Postgres and Valkey"')).toBeLessThan(
      E2E.indexOf("await step(`install"),
    );
    expect(stepBody("start the external Postgres and Valkey")).toContain("externalStateSetup(inHost, expectThat);");
    const install = stepBody("install");
    expect(install).toContain('externalStateFlags("acl")');
    expect(install).toContain('externalStateEnv("acl")');
    expect(install).toContain('checkExternalState(inHost, expectThat, "install")');
    const upgrade = stepBody("release ${v2}");
    expect(upgrade).toContain('checkExternalState(inHost, expectThat, "upgrade")');
    expect(upgrade).toContain("migrateRestarts(inHost)");
    const def = stepBody("re-install onto Valkey's password-only default user");
    expect(def).toContain("install --reinstall --valkey-url rediss://");
    expect(def).toContain('checkExternalState(inHost, expectThat, "default user")');
    expect(stepBody("broken release")).toContain('checkExternalState(inHost, expectThat, "rollback")');
    // The bundled Valkey's own checks run only with bundled state.
    expect(E2E.match(/if \(!externalState\) \{\s+checkValkeyAuth\(\);\s+\}/g)).toHaveLength(2);
  });

  test("R0-c's object backup runs between the worker restart and the rollback, set up and torn down", () => {
    const step = E2E.indexOf('await step("backups: objects offsite and an object restore"');
    expect(step).toBeGreaterThan(E2E.indexOf('await step("a killed worker comes back by itself"'));
    expect(step).toBeLessThan(E2E.indexOf("await step(`broken release"));
    const body = stepBody("backups: objects offsite");
    const order = ["objectBackupSetup(", "checkObjectBackup(", "objectBackupTeardown("].map((c) => body.indexOf(c));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // With --storage external the second Garage is the instance's store: never set it up again.
    expect(body).not.toContain("externalStoreSetup");
  });
});

describe("CI", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  selfhost-e2e:"), ci.indexOf("\n  ci-ok:"));
  const matrix = job
    .slice(job.indexOf("matrix:"), job.indexOf("steps:"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  // S1-b's external-state row is the orchestrator's change to ci.yml (a contract request); until it
  // lands, the matrix is batch 7's. Drop this branch once it has.
  const pendingState = !job.includes("state: external");

  const BATCH7_MATRIX = [
    "matrix:",
    "distro: [debian, fedora]",
    "storage: [garage]",
    "include:",
    "- distro: debian",
    "storage: external",
  ];
  const S1B_MATRIX = [
    "matrix:",
    "distro: [debian, fedora]",
    "storage: [garage]",
    "state: [bundled]",
    "include:",
    "- distro: debian",
    "storage: external",
    "state: bundled",
    "- distro: debian",
    "storage: external",
    "state: external",
  ];

  test("both distributions with everything bundled, the external store, and external state on Debian", () => {
    expect(matrix).toEqual(pendingState ? BATCH7_MATRIX : S1B_MATRIX);
  });

  test("the run passes the variant, and each variant keeps its own logs", () => {
    const lines = pendingState
      ? [
          'scripts/selfhost/e2e.ts --distro "$DISTRO" --storage "$STORAGE"',
          "STORAGE: ${{ matrix.storage }}",
          "name: selfhost-e2e-${{ matrix.distro }}-${{ matrix.storage }}-${{ github.run_attempt }}",
        ]
      : [
          'scripts/selfhost/e2e.ts --distro "$DISTRO" --storage "$STORAGE" --state "$STATE"',
          "STORAGE: ${{ matrix.storage }}",
          "STATE: ${{ matrix.state }}",
          "name: selfhost-e2e-${{ matrix.distro }}-${{ matrix.storage }}-${{ matrix.state }}-${{ github.run_attempt }}",
        ];
    for (const line of lines) expect(job).toContain(line);
  });
});
