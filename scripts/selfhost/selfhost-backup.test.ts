// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `selfhost.sh backup` (R0-c): the database by default, the media and evidence buckets offsite
 * with --objects, back with --restore-objects. The script runs under `sh` on a fake installed
 * instance (a current-release symlink and an env file; nothing is installed), with PATH stubs for
 * systemctl, podman and rclone. Every real tool's argv is logged, so the tests can show that no
 * key ever reaches a command line, and the rclone stub records the environment it was given.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";

// Each run starts a few dozen processes (every real tool is wrapped to log its argv): seconds
// apiece, more under load.
vi.setConfig({ testTimeout: 60_000 });

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/selfhost.sh");

const INSTANCE_KEYS = {
  S3_ACCESS_KEY_ID: "GK0123456789abcdef01234567",
  S3_SECRET_ACCESS_KEY: "a1".repeat(32),
  S3_EVIDENCE_ACCESS_KEY_ID: "GKfedcba9876543210fedcba98",
  S3_EVIDENCE_SECRET_ACCESS_KEY: "e2".repeat(32),
};
const REMOTE_KEYS = {
  BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID: "DO00OFFSITEKEY0000001",
  BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY: "offsite/Secret+Value=0123456789abcdefOFF",
};
/** What the podman stub's `garage key create` prints (Garage v2's layout). */
const GARAGE_KEY = { id: "GK00aa11bb22cc33dd44ee55ff", secret: "5e".repeat(32) };
const REMOTE = {
  BACKUP_OBJECTS_REMOTE_ENDPOINT: "https://ams3.digitaloceanspaces.com",
  BACKUP_OBJECTS_REMOTE_REGION: "ams3",
  BACKUP_OBJECTS_REMOTE_BUCKET: "ca-objects",
  BACKUP_OBJECTS_REMOTE_PREFIX: "prod",
  ...REMOTE_KEYS,
};
const SECRETS = [
  ...Object.values(INSTANCE_KEYS),
  ...Object.values(REMOTE_KEYS),
  GARAGE_KEY.secret,
  "SrcSecret/OnlyInEnv+0123456789",
];

const REAL_TOOLS = [
  "sh",
  "awk",
  "basename",
  "cat",
  "chmod",
  "cut",
  "date",
  "grep",
  "head",
  "id",
  "mkdir",
  "mktemp",
  "mv",
  "readlink",
  "rm",
  "sed",
  "sort",
  "tail",
  "tr",
  "wc",
];

const STUBS: Record<string, string> = {
  systemctl: String.raw`
[ "$1" = --user ] && shift
case "$1" in
  --version) echo "systemd 257 (257.9-1)" ;;
  show-environment) echo HOME=$HOME ;;
  start) case "$*" in *commonair-backup.service*) [ -z "\${STUB_BACKUP_FAIL:-}" ] || exit 1 ;; esac ;;
  enable) [ -z "\${STUB_ENABLE_FAIL:-}" ] || exit 1 ;;
esac
exit 0
`,
  podman: String.raw`
[ "$1" = exec ] || exit 0
case "$*" in
  *"/garage key info"*) [ -e "$STUB_STATE/garage-key" ] || { echo "Error: no such key" >&2; exit 1; } ;;
  *"/garage key create"*)
    [ -z "\${STUB_GARAGE_DOWN:-}" ] || { echo "Error: connection refused" >&2; exit 1; }
    : >"$STUB_STATE/garage-key"
    echo "2026-10-26T00:00:00Z  INFO garage_net::netapp: Connected to 127.0.0.1:3901" >&2
    printf '==== ACCESS KEY INFORMATION ====\nKey ID:              %s\nKey name:            %s\nSecret key:          %s\nCreated:             2026-10-26\n' \
      "$STUB_GARAGE_ID" "$6" "$STUB_GARAGE_SECRET" ;;
  *"/garage bucket allow"*) : ;;
  *commonair-postgres*) echo "backup-list: base_000000010000000000000003" ;;
esac
exit 0
`,
  rclone: String.raw`
n=$(ls "$STUB_STATE" | grep -c '^rclone-env-' || true)
env | grep '^RCLONE_' | sort > "$STUB_STATE/rclone-env-$((n + 1))"
[ "$2" != "\${STUB_RCLONE_FAIL_ON:-none}" ] || { echo "ERROR : AccessDenied" >&2; exit 7; }
exit 0
`,
};

interface Run {
  code: number;
  out: string;
  err: string;
}
interface Host {
  home: string;
  envFile: string;
  state: string;
  run(args: string[], env?: Record<string, string>): Run;
  /** Every stub call (podman, systemctl, rclone) as "name args". */
  calls(): string[];
  /** Every real tool's argv, as ps would show it. */
  argv(): string;
  /** The RCLONE_* environment of each rclone call, in order. */
  rcloneEnvs(): Record<string, string>[];
  setEnv(values: Record<string, string>): void;
  envOf(): Record<string, string>;
}

const parseEnv = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

/** An installed instance as far as `backup` can tell: a current release and an env file. */
function host(env: Record<string, string>, opts: { rclone?: boolean } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-backup-host-"));
  const home = join(dir, "home");
  const stub = join(dir, "stub");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const log = join(dir, "calls.log");
  const argvLog = join(dir, "argv.log");
  const quadlets = join(home, ".config/containers/systemd");
  for (const d of [
    home,
    stub,
    bin,
    state,
    quadlets,
    join(dir, "tmp"),
    join(dir, "release"),
    join(home, ".config/commonair"),
  ])
    mkdirSync(d, { recursive: true });
  // One installed unit, for status's unit list.
  writeFileSync(join(quadlets, "commonair-postgres.container"), "[Container]\nContainerName=commonair-postgres\n");
  writeFileSync(join(dir, "release/release.env"), "COMMONAIR_VERSION=0.1.0\n");
  symlinkSync(join(dir, "release"), join(home, "commonair"));
  const envFile = join(home, ".config/commonair/commonair.env");
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    { mode: 0o600 },
  );
  for (const tool of REAL_TOOLS) {
    const path = Bun.which(tool);
    if (!path) continue;
    if (tool === "sh") symlinkSync(path, join(bin, tool));
    else {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${argvLog}"\nexec ${path} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
  }
  // The stubs use these unlogged (they are the test's, not the script's).
  for (const tool of ["ls", "env"]) {
    const path = Bun.which(tool);
    if (path) symlinkSync(path, join(stub, tool));
  }
  for (const [name, body] of Object.entries(STUBS)) {
    if (name === "rclone" && opts.rclone === false) continue;
    writeFileSync(
      join(stub, name),
      `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body.replaceAll("\\${", "${")}\n`,
    );
    chmodSync(join(stub, name), 0o755);
  }
  const base: Record<string, string> = {
    PATH: `${stub}:${bin}`,
    HOME: home,
    TMPDIR: join(dir, "tmp"),
    STUB_LOG: log,
    STUB_STATE: state,
    STUB_GARAGE_ID: GARAGE_KEY.id,
    STUB_GARAGE_SECRET: GARAGE_KEY.secret,
  };
  return {
    home,
    envFile,
    state,
    run(args, extra = {}) {
      const r = Bun.spawnSync([join(bin, "sh"), SCRIPT, ...args], {
        env: { ...base, ...extra },
        cwd: home,
        stdin: "ignore",
      });
      return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
    },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    argv: () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8") : ""),
    rcloneEnvs: () =>
      readdirSync(state)
        .filter((f) => f.startsWith("rclone-env-"))
        .sort((a, b) => Number(a.slice(11)) - Number(b.slice(11)))
        .map((f) => parseEnv(readFileSync(join(state, f), "utf8"))),
    setEnv(values) {
      const cur = { ...parseEnv(readFileSync(envFile, "utf8")), ...values };
      writeFileSync(
        envFile,
        Object.entries(cur)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(""),
        { mode: 0o600 },
      );
    },
    envOf: () => parseEnv(readFileSync(envFile, "utf8")),
  };
}

const GARAGE_ENV = {
  S3_ENDPOINT: "http://garage:3900",
  S3_REGION: "garage",
  S3_FORCE_PATH_STYLE: "true",
  S3_BUCKET_MEDIA: "commonair-media",
  S3_BUCKET_EXPORTS: "commonair-exports",
  S3_BUCKET_BACKUPS: "commonair-backups",
  S3_BUCKET_EVIDENCE: "commonair-evidence",
  ...INSTANCE_KEYS,
};
const EXTERNAL_ENV = {
  ...GARAGE_ENV,
  S3_MODE: "external",
  S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
  S3_REGION: "nyc3",
  S3_FORCE_PATH_STYLE: "false",
  S3_BUCKET_MEDIA: "ca-media",
  S3_BUCKET_EVIDENCE: "ca-evidence",
};

const expectOk = (r: Run) => expect(r.code, `${r.out}\n${r.err}`).toBe(0);
const rcloneCalls = (h: Host) => h.calls().filter((c) => c.startsWith("rclone "));
const stateFile = (h: Host) => join(h.home, ".local/state/commonair/object-backup");
const noSecretIn = (text: string) => {
  for (const s of SECRETS) expect(text).not.toContain(s);
};

describe("flags", () => {
  test("no flag: the database backup, as before, and no object copy", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup"]);
    expectOk(r);
    expect(h.calls()).toContain("systemctl --user start commonair-backup.service");
    expect(r.out).toContain("backup-list");
    expect(rcloneCalls(h)).toEqual([]);
  });

  test("--database alone is the same", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--database"]));
    expect(h.calls()).toContain("systemctl --user start commonair-backup.service");
    expect(rcloneCalls(h)).toEqual([]);
  });

  test("--objects alone: the buckets, no database backup", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"]));
    expect(h.calls()).not.toContain("systemctl --user start commonair-backup.service");
    expect(rcloneCalls(h).length).toBe(2);
  });

  test("both: the database first, then the buckets", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects", "--database"]));
    const calls = h.calls();
    const db = calls.indexOf("systemctl --user start commonair-backup.service");
    const firstCopy = calls.findIndex((c) => c.startsWith("rclone "));
    expect(db).toBeGreaterThan(-1);
    expect(firstCopy).toBeGreaterThan(db);
  });

  test("a failed database backup stops before the objects", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--database", "--objects"], { STUB_BACKUP_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the backup failed");
    expect(rcloneCalls(h)).toEqual([]);
  });

  test.each([
    [["--frobnicate"], "unknown backup option: --frobnicate"],
    [["--objects", "--all"], "unknown backup option: --all"],
    [["--restore-objects", "--objects"], "--restore-objects runs on its own"],
    [["--database", "--restore-objects"], "--restore-objects runs on its own"],
    [["--bwlimit"], "--bwlimit needs a value"],
    [["--bwlimit", "10M"], "--bwlimit applies to --objects and --restore-objects only"],
    [["--database", "--bwlimit", "10M"], "--bwlimit applies to --objects and --restore-objects only"],
  ])("%j is refused before anything runs", (args, message) => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", ...args]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(h.calls()).toEqual([]);
  });

  test("--help prints the backup options", () => {
    const h = host(GARAGE_ENV);
    const r = h.run(["backup", "--help"]);
    expectOk(r);
    for (const flag of ["--database", "--objects", "--restore-objects", "--bwlimit"]) expect(r.out).toContain(flag);
  });
});

describe("--objects with Garage on this host", () => {
  test("creates a read-only Garage key once, keeps it in the env file, grants it read on media and evidence", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"]);
    expectOk(r);
    expect(h.envOf()).toMatchObject({
      BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID: GARAGE_KEY.id,
      BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY: GARAGE_KEY.secret,
    });
    const garage = h.calls().filter((c) => c.includes("/garage"));
    expect(garage).toEqual([
      "podman exec commonair-garage /garage key create commonair-object-backup",
      `podman exec commonair-garage /garage bucket allow --read commonair-media --key ${GARAGE_KEY.id}`,
      `podman exec commonair-garage /garage bucket allow --read commonair-evidence --key ${GARAGE_KEY.id}`,
    ]);
    // Read only: never --write or --owner, never the exports or backups bucket.
    for (const c of garage) expect(c).not.toMatch(/--write|--owner|exports|backups/);
    // A second run reuses the key Garage knows.
    expectOk(h.run(["backup", "--objects"]));
    expect(h.calls().filter((c) => c.includes("/garage key create")).length).toBe(1);
    expect(h.calls()).toContain(`podman exec commonair-garage /garage key info ${GARAGE_KEY.id}`);
  });

  test("a stored key this Garage does not know (a restored env file) is replaced", () => {
    const h = host({
      ...GARAGE_ENV,
      ...REMOTE,
      BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID: "GK999999999999999999999999",
      BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY: "9".repeat(64),
    });
    const r = h.run(["backup", "--objects"]);
    expectOk(r);
    expect(r.err).toContain("this Garage has no key GK999999999999999999999999");
    expect(h.envOf().BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID).toBe(GARAGE_KEY.id);
  });

  test("Garage down: a clear error, no copy, no state", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_GARAGE_DOWN: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not create a Garage key: Error: connection refused");
    expect(rcloneCalls(h)).toEqual([]);
    expect(existsSync(stateFile(h))).toBe(false);
  });

  test("rclone syncs media and evidence to <bucket>/<prefix>/{media,evidence}, with --checksum", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"]));
    expect(rcloneCalls(h)).toEqual([
      "rclone sync cainstance:commonair-media caoffsite:ca-objects/prod/media --checksum --stats=1m --stats-one-line --stats-log-level=NOTICE",
      "rclone sync cainstance:commonair-evidence caoffsite:ca-objects/prod/evidence --checksum --stats=1m --stats-one-line --stats-log-level=NOTICE",
    ]);
  });

  test("rclone's remotes come from its environment only: Garage's loopback port, the offsite store, no_check_bucket on both", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"]));
    const envs = h.rcloneEnvs();
    expect(envs.length).toBe(2);
    for (const e of envs) {
      expect(e).toMatchObject({
        RCLONE_CONFIG_CAINSTANCE_TYPE: "s3",
        RCLONE_CONFIG_CAINSTANCE_ENDPOINT: "http://127.0.0.1:3900",
        RCLONE_CONFIG_CAINSTANCE_REGION: "garage",
        RCLONE_CONFIG_CAINSTANCE_FORCE_PATH_STYLE: "true",
        RCLONE_CONFIG_CAINSTANCE_NO_CHECK_BUCKET: "true",
        RCLONE_CONFIG_CAINSTANCE_ENV_AUTH: "false",
        // The read-only key for both buckets, never the instance's read-write keys.
        RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID: GARAGE_KEY.id,
        RCLONE_CONFIG_CAINSTANCE_SECRET_ACCESS_KEY: GARAGE_KEY.secret,
        RCLONE_CONFIG_CAOFFSITE_TYPE: "s3",
        RCLONE_CONFIG_CAOFFSITE_ENDPOINT: "https://ams3.digitaloceanspaces.com",
        RCLONE_CONFIG_CAOFFSITE_REGION: "ams3",
        RCLONE_CONFIG_CAOFFSITE_FORCE_PATH_STYLE: "true",
        RCLONE_CONFIG_CAOFFSITE_NO_CHECK_BUCKET: "true",
        RCLONE_CONFIG_CAOFFSITE_ACCESS_KEY_ID: REMOTE_KEYS.BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID,
        RCLONE_CONFIG_CAOFFSITE_SECRET_ACCESS_KEY: REMOTE_KEYS.BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY,
      });
      // An empty config file of its own: an operator's rclone.conf cannot add to the remotes.
      expect(e.RCLONE_CONFIG).toMatch(/commonair-selfhost\.[^/]+\/rclone\.conf$/);
    }
  });

  test("no key ever reaches a command line, and none is printed", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"]);
    expectOk(r);
    expect(h.argv()).not.toBe("");
    noSecretIn(h.argv());
    noSecretIn(h.calls().join("\n"));
    noSecretIn(r.out + r.err);
  });

  test("the bandwidth limit: from the env file, a flag overrides it", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE, BACKUP_OBJECTS_BWLIMIT: "08:00,4M 23:00,off" });
    expectOk(h.run(["backup", "--objects"]));
    for (const c of rcloneCalls(h)) expect(c.endsWith(" --bwlimit=08:00,4M 23:00,off")).toBe(true);
    const h2 = host({ ...GARAGE_ENV, ...REMOTE, BACKUP_OBJECTS_BWLIMIT: "4M" });
    expectOk(h2.run(["backup", "--objects", "--bwlimit", "20M"]));
    for (const c of rcloneCalls(h2)) expect(c.endsWith(" --bwlimit=20M")).toBe(true);
  });

  test("no prefix: the copies sit at the bucket's top", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE, BACKUP_OBJECTS_REMOTE_PREFIX: "" });
    expectOk(h.run(["backup", "--objects"]));
    expect(rcloneCalls(h).map((c) => c.split(" ")[3])).toEqual([
      "caoffsite:ca-objects/media",
      "caoffsite:ca-objects/evidence",
    ]);
  });
});

describe("the state file and the timer", () => {
  test("success writes the time and place under ~/.local/state, enables the timer once, and status shows it", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"]);
    expectOk(r);
    const s = parseEnv(readFileSync(stateFile(h), "utf8"));
    expect(s.LAST_SUCCESS).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(s.REMOTE).toBe("https://ams3.digitaloceanspaces.com/ca-objects/prod");
    expect(r.out).toContain("object backup done");
    expect(h.calls()).toContain("systemctl --user enable --now commonair-object-backup.timer");
    // Later runs leave the timer as the operator set it (perhaps disabled on purpose).
    expectOk(h.run(["backup", "--objects"]));
    expect(h.calls().filter((c) => c.includes("enable --now commonair-object-backup.timer")).length).toBe(1);
  });

  test("a failed copy writes no state and enables no timer; an earlier success stays recorded", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_RCLONE_FAIL_ON: "cainstance:commonair-evidence" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("copying commonair-evidence offsite failed");
    expect(existsSync(stateFile(h))).toBe(false);
    expect(h.calls().some((c) => c.includes("enable"))).toBe(false);
    expect(existsSync(join(h.home, ".local/state/commonair/object-backup.tmp"))).toBe(false);

    expectOk(h.run(["backup", "--objects"]));
    const before = readFileSync(stateFile(h), "utf8");
    expect(h.run(["backup", "--objects"], { STUB_RCLONE_FAIL_ON: "cainstance:commonair-media" }).code).toBe(1);
    expect(readFileSync(stateFile(h), "utf8")).toBe(before);
  });

  test("a timer that cannot be enabled is a warning, not a failed backup", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_ENABLE_FAIL: "1" });
    expectOk(r);
    expect(r.err).toContain("could not enable commonair-object-backup.timer");
    expect(existsSync(stateFile(h))).toBe(true);
  });

  test("status: not configured, never, then the last success", () => {
    const h = host(GARAGE_ENV);
    expect(h.run(["status"]).out).toContain("last object backup: not configured (docs/self-hosting/backups.md)");
    h.setEnv(REMOTE);
    expect(h.run(["status"]).out).toContain("last object backup: never (selfhost.sh backup --objects)");
    expectOk(h.run(["backup", "--objects"]));
    expect(h.run(["status"]).out).toMatch(
      /last object backup: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(to https:\/\/ams3\.digitaloceanspaces\.com\/ca-objects\/prod\)/,
    );
  });
});

describe("the offsite store's configuration", () => {
  test("missing entirely: refused with the keys to set and where it is documented", () => {
    const h = host(GARAGE_ENV);
    const r = h.run(["backup", "--objects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "no offsite store for objects: " +
        `${h.envFile} lacks BACKUP_OBJECTS_REMOTE_ENDPOINT BACKUP_OBJECTS_REMOTE_REGION BACKUP_OBJECTS_REMOTE_BUCKET ` +
        "BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY",
    );
    expect(r.err).toContain("backups.md");
    expect(r.err).toContain("never on the command line");
    expect(h.calls().filter((c) => !c.startsWith("systemctl"))).toEqual([]);
  });

  test("one key missing: only that one is named", () => {
    const { BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY: _, ...partial } = REMOTE;
    const h = host({ ...GARAGE_ENV, ...partial });
    const r = h.run(["backup", "--objects"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/lacks BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY\n/);
  });

  test.each([
    [{ BACKUP_OBJECTS_REMOTE_ENDPOINT: "https://ams3.digitaloceanspaces.com/path" }, "is not an S3 endpoint"],
    [{ BACKUP_OBJECTS_REMOTE_ENDPOINT: "http://10.0.0.5:3900" }, "is plain http"],
    [{ BACKUP_OBJECTS_REMOTE_REGION: "ams 3" }, "is not an S3 region"],
    [{ BACKUP_OBJECTS_REMOTE_BUCKET: "Ca_Objects" }, "is not a bucket name"],
    [{ BACKUP_OBJECTS_REMOTE_PREFIX: "prod/../other" }, "is not a path"],
    [{ BACKUP_OBJECTS_REMOTE_PREFIX: "prod daily" }, "is not a path"],
    [{ BACKUP_OBJECTS_REMOTE_PATH_STYLE: "yes" }, "must be true or false"],
    [{ BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID: "k" }, "BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID is not an S3 key"],
    [{ BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY: "secret with spaces" }, "SECRET_ACCESS_KEY is not an S3 key"],
    [{ BACKUP_OBJECTS_BWLIMIT: "10M;rm" }, "not an rclone bandwidth limit"],
  ])("%j is refused", (bad, message) => {
    const h = host({ ...GARAGE_ENV, ...REMOTE, ...bad });
    const r = h.run(["backup", "--objects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(rcloneCalls(h)).toEqual([]);
    // A bad key's value is never echoed back.
    expect(r.err).not.toContain("secret with spaces");
  });

  test("plain http with BACKUP_OBJECTS_REMOTE_ALLOW_HTTP=true (a store on a trusted network)", () => {
    const h = host({
      ...GARAGE_ENV,
      ...REMOTE,
      BACKUP_OBJECTS_REMOTE_ENDPOINT: "http://127.0.0.1:3910",
      BACKUP_OBJECTS_REMOTE_ALLOW_HTTP: "true",
    });
    expectOk(h.run(["backup", "--objects"]));
    expect(h.rcloneEnvs()[0]!.RCLONE_CONFIG_CAOFFSITE_ENDPOINT).toBe("http://127.0.0.1:3910");
  });

  test("a prefix's stray slashes are dropped", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE, BACKUP_OBJECTS_REMOTE_PREFIX: "/prod/objects/" });
    expectOk(h.run(["backup", "--objects"]));
    expect(rcloneCalls(h)[0]).toContain(" caoffsite:ca-objects/prod/objects/media ");
  });

  test("rclone missing: the package to install", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE }, { rclone: false });
    const r = h.run(["backup", "--objects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rclone is not installed");
    expect(r.err).toContain("apt install rclone");
  });
});

describe("--objects with an external store", () => {
  test("bucket to bucket from the store's endpoint, each bucket with its own instance key", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"]));
    expect(h.calls().filter((c) => c.startsWith("podman"))).toEqual([]);
    expect(rcloneCalls(h).map((c) => c.split(" ").slice(1, 4).join(" "))).toEqual([
      "sync cainstance:ca-media caoffsite:ca-objects/prod/media",
      "sync cainstance:ca-evidence caoffsite:ca-objects/prod/evidence",
    ]);
    const [media, evidence] = h.rcloneEnvs();
    for (const e of [media!, evidence!])
      expect(e).toMatchObject({
        RCLONE_CONFIG_CAINSTANCE_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        RCLONE_CONFIG_CAINSTANCE_REGION: "nyc3",
        RCLONE_CONFIG_CAINSTANCE_FORCE_PATH_STYLE: "false",
        RCLONE_CONFIG_CAINSTANCE_NO_CHECK_BUCKET: "true",
      });
    expect(media!.RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID).toBe(INSTANCE_KEYS.S3_ACCESS_KEY_ID);
    expect(evidence!.RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID).toBe(INSTANCE_KEYS.S3_EVIDENCE_ACCESS_KEY_ID);
    expect(evidence!.RCLONE_CONFIG_CAINSTANCE_SECRET_ACCESS_KEY).toBe(INSTANCE_KEYS.S3_EVIDENCE_SECRET_ACCESS_KEY);
  });

  test("a read-only key and a host-side endpoint of the operator's, when set", () => {
    const h = host({
      ...EXTERNAL_ENV,
      ...REMOTE,
      BACKUP_OBJECTS_SOURCE_ENDPOINT: "https://nyc3.example.net",
      BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID: "DO00READONLYSOURCE01",
      BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY: "SrcSecret/OnlyInEnv+0123456789",
    });
    const r = h.run(["backup", "--objects"]);
    expectOk(r);
    for (const e of h.rcloneEnvs())
      expect(e).toMatchObject({
        RCLONE_CONFIG_CAINSTANCE_ENDPOINT: "https://nyc3.example.net",
        RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID: "DO00READONLYSOURCE01",
        RCLONE_CONFIG_CAINSTANCE_SECRET_ACCESS_KEY: "SrcSecret/OnlyInEnv+0123456789",
      });
    noSecretIn(h.argv());
    noSecretIn(r.out + r.err);
  });
});

describe("--restore-objects", () => {
  test("copies (never syncs) the offsite copy back, with the instance's own write keys", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--restore-objects"]);
    expectOk(r);
    expect(rcloneCalls(h).map((c) => c.split(" ").slice(1, 4).join(" "))).toEqual([
      "copy caoffsite:ca-objects/prod/media cainstance:commonair-media",
      "copy caoffsite:ca-objects/prod/evidence cainstance:commonair-evidence",
    ]);
    const [media, evidence] = h.rcloneEnvs();
    expect(media).toMatchObject({
      RCLONE_CONFIG_CAINSTANCE_ENDPOINT: "http://127.0.0.1:3900",
      RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID: INSTANCE_KEYS.S3_ACCESS_KEY_ID,
      RCLONE_CONFIG_CAINSTANCE_SECRET_ACCESS_KEY: INSTANCE_KEYS.S3_SECRET_ACCESS_KEY,
      RCLONE_CONFIG_CAINSTANCE_NO_CHECK_BUCKET: "true",
      RCLONE_CONFIG_CAOFFSITE_NO_CHECK_BUCKET: "true",
    });
    expect(evidence).toMatchObject({
      RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID: INSTANCE_KEYS.S3_EVIDENCE_ACCESS_KEY_ID,
      RCLONE_CONFIG_CAINSTANCE_SECRET_ACCESS_KEY: INSTANCE_KEYS.S3_EVIDENCE_SECRET_ACCESS_KEY,
    });
    // It needs no backup key, takes no database backup, records no backup and enables no timer.
    expect(h.calls().filter((c) => c.startsWith("podman") || c.startsWith("systemctl --user start"))).toEqual([]);
    expect(existsSync(stateFile(h))).toBe(false);
    expect(h.calls().some((c) => c.includes("enable"))).toBe(false);
    expect(r.out).toContain("EVIDENCE_PRIVATE_KEY");
    noSecretIn(h.argv());
    noSecretIn(r.out + r.err);
  });

  test("a failure says that re-running is safe", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--restore-objects"], { STUB_RCLONE_FAIL_ON: "caoffsite:ca-objects/prod/media" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("restoring commonair-media failed");
    expect(r.err).toContain("re-running it is safe");
  });

  test("without an offsite store it is refused like --objects", () => {
    const h = host(GARAGE_ENV);
    const r = h.run(["backup", "--restore-objects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no offsite store for objects");
  });
});

describe("the daily timer's units", () => {
  const unit = (f: string) => readFileSync(join(ROOT, "infra/systemd", f), "utf8");
  const keys = (u: string, key: string) => [...u.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]);

  test("the service runs the release's selfhost.sh backup --objects, a oneshot that never starts Garage", () => {
    const s = unit("commonair-object-backup.service");
    expect(keys(s, "Type")).toEqual(["oneshot"]);
    expect(keys(s, "ExecStart")).toEqual(["/bin/sh %h/commonair/selfhost.sh backup --objects"]);
    expect(keys(s, "Requires")).toEqual([]);
    expect(keys(s, "Requisite")).toEqual([]);
    expect(s).not.toMatch(/^\[Install\]$/m);
  });

  test("the timer runs daily after the base backup, catches up after downtime", () => {
    const t = unit("commonair-object-backup.timer");
    expect(keys(t, "Unit")).toEqual(["commonair-object-backup.service"]);
    expect(keys(t, "Persistent")).toEqual(["true"]);
    expect(keys(t, "OnCalendar")).toEqual(["*-*-* 04:00:00 UTC"]);
    expect(keys(t, "WantedBy")).toEqual(["timers.target"]);
  });

  test("install never enables it: only the first successful --objects run does", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    const enables = [...sh.matchAll(/enable --now ([^\n]*)/g)].map((m) => m[1]);
    expect(enables.filter((e) => e?.includes("commonair-object-backup.timer"))).toEqual([]);
    expect(sh).toContain('systemctl --user enable --now "$OBJECT_TIMER"');
  });
});
