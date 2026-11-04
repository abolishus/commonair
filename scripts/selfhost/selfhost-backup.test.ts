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
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vite-plus/test";
import { linkExecutables } from "../tests/support/exec-cache.ts";

// Each run starts a few dozen processes: seconds apiece, more under load.
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
/** The release's Postgres image, which the dumps and drills run. */
const PG_IMAGE = `ghcr.io/example/commonair/postgres@sha256:${"ab".repeat(32)}`;
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
  "ln",
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
  // The dumps and drills (S1-h).
  "tee",
  "sha256sum",
  "df",
  "mkfifo",
  "od",
  "sleep",
  "dirname",
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
if [ "$1" = run ]; then
  case "$*" in
    *"--entrypoint /usr/local/bin/commonair-dump "*)
      # The dump: counts.json into the -v <dir>:/out mount, the dump's bytes on stdout.
      out=""; prev=""
      for a in "$@"; do
        if [ "$prev" = -v ]; then case "$a" in *:/out:Z) out=\${a%:/out:Z} ;; esac; fi
        prev=$a
      done
      [ -z "\${STUB_DUMP_FAIL:-}" ] || { echo "commonair-dump: pg_dump failed (exit 1)" >&2; exit 1; }
      printf '{\n  "format": "commonair-dump-counts/1",\n  "checks": {\n    "rows.public.channels": 2\n  }\n}\n' > "$out/counts.json"
      printf 'PGDMP-fixture-dump\n'
      exit 0 ;;
    *"--network none --user postgres"*) [ -z "\${STUB_DRILL_START_FAIL:-}" ] || exit 1 ;;
  esac
  exit 0
fi
if [ "$1 $2" = "container exists" ]; then [ -z "\${STUB_NO_COLLECTOR:-}" ] || exit 1; exit 0; fi
[ "$1" = exec ] || exit 0
case "$*" in
  *"sh -c cat > "*) cat > "$STUB_STATE/fetched.dump"; exit 0 ;;
  *"commonair-dump-drill ready"*) exit 0 ;;
  *"commonair-dump-drill restore"*) echo "commonair-dump-restore: 5/5 post-data"; exit "\${STUB_RESTORE_RC:-0}" ;;
  *"commonair-dump-drill check-walg"*) echo "all 7 checks match"; exit "\${STUB_CHECK_RC:-0}" ;;
  *"commonair-dump-drill check"*)
    cat > "$STUB_STATE/check-input"
    if [ "\${STUB_CHECK_RC:-0}" = 0 ]; then echo "all 3 checks match"; else echo "  follows.count_mismatch: dump 0, restored 4"; fi
    exit "\${STUB_CHECK_RC:-0}" ;;
  *"commonair-otel-collector"*)
    n=$(ls "$STUB_STATE" | grep -c '^metrics-' || true)
    printf '%s\n' "$*" > "$STUB_STATE/metrics-$((n + 1))"
    exit 0 ;;
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
last=""
for a in "$@"; do last=$a; done
if [ -n "\${RCLONE_CONFIG_CAANON_TYPE:-}" ]; then
  # Without a key: refused unless the test made the store public.
  case " $* " in
    *" lsf "*) [ -z "\${STUB_PUBLIC_LIST:-}" ] || { echo "dumps/"; exit 0; } ;;
    *" cat "*) [ -z "\${STUB_PUBLIC_READ:-}" ] || { echo "probe"; exit 0; } ;;
  esac
  echo "ERROR : AccessDenied" >&2
  exit 1
fi
case "$last" in
  *"/dumps" | *"/dumps/"*)
    case "$1" in
      lsf)
        case "$*" in
          *--dirs-only*) [ -f "$STUB_STATE/dump-dirs" ] && cat "$STUB_STATE/dump-dirs" ;;
          *) [ -f "$STUB_STATE/dump-files" ] && cat "$STUB_STATE/dump-files" ;;
        esac
        exit 0 ;;
      rcat)
        b=\${last##*/}
        cat > "$STUB_STATE/rcat-$b"
        [ "$b" != "\${STUB_RCAT_FAIL:-none}" ] || { echo "ERROR : connection refused" >&2; exit 5; }
        exit 0 ;;
      cat)
        case "$last" in
          *.sha256) cat "$STUB_STATE/remote-sha" ;;
          */counts.json) printf '{\n  "format": "commonair-dump-counts/1",\n  "checks": {\n    "rows.public.channels": 2\n  }\n}\n' ;;
          *) cat "$STUB_STATE/remote-dump" ;;
        esac
        exit 0 ;;
      lsjson) printf '[{"Path":"commonair.dump","Size":%s}]\n' "\${STUB_DUMP_SIZE:-19}"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
if [ "$1" = lsf ]; then
  # Every place lists one object, except those named in STUB_EMPTY (nothing), STUB_LSF_MISSING
  # (rclone's "directory not found", exit 3) and STUB_LSF_FAIL (an error).
  case " \${STUB_LSF_FAIL:-} " in *" $4 "*) echo "ERROR : AccessDenied" >&2; exit 1 ;; esac
  case " \${STUB_LSF_MISSING:-} " in *" $4 "*) echo "ERROR : directory not found" >&2; exit 3 ;; esac
  case " \${STUB_EMPTY:-} " in *" $4 "*) exit 0 ;; esac
  echo "avatars/"
  exit 0
fi
[ -z "\${STUB_HOLD:-}" ] || : >"$STUB_STATE/lock-seen-$(readlink "$HOME/.local/state/commonair/object-backup.lock")"
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
  /** Every real tool's argv, as ps would show it (only with `recordArgv`). */
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

/** Hosts made by this file, removed after it. */
const hosts: string[] = [];
afterAll(() => {
  for (const d of hosts.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * An installed instance as far as `backup` can tell: a current release and an env file.
 * `recordArgv` wraps every real tool but sh to log its argv first; that triples the run time,
 * so only the tests that read `argv()` turn it on.
 */
function host(env: Record<string, string>, opts: { rclone?: boolean; recordArgv?: boolean } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-backup-host-"));
  hosts.push(dir);
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
  // One installed unit, for status's unit list (and the WAL-G drill's POSTGRES_USER and _DB).
  writeFileSync(
    join(quadlets, "commonair-postgres.container"),
    "[Container]\nContainerName=commonair-postgres\nEnvironment=POSTGRES_USER=commonair\nEnvironment=POSTGRES_DB=commonair\n",
  );
  writeFileSync(join(dir, "release/release.env"), "COMMONAIR_VERSION=0.1.0\n");
  // What the dumps and drills read from the release: the Postgres image, and the env renderer
  // and key list the WAL-G drill renders the Postgres unit's keys with.
  for (const d of ["quadlet", "scripts/selfhost", "infra/selfhost/env"])
    mkdirSync(join(dir, "release", d), { recursive: true });
  writeFileSync(join(dir, "release/quadlet/commonair-postgres.container"), `[Container]\nImage=${PG_IMAGE}\n`);
  for (const f of ["scripts/selfhost/render-env.sh", "infra/selfhost/env/commonair-postgres.keys"])
    writeFileSync(join(dir, "release", f), readFileSync(join(ROOT, f)));
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
    if (!opts.recordArgv || tool === "sh") symlinkSync(path, join(bin, tool));
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
    linkExecutables(stub, {
      [name]: `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body.replaceAll("\\${", "${")}\n`,
    });
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
/** The copies (sync, copy), not the listings that check for an empty bucket first. */
const rcloneCalls = (h: Host) => h.calls().filter((c) => /^rclone (sync|copy) /.test(c));
const lsfCalls = (h: Host) => h.calls().filter((c) => c.startsWith("rclone lsf "));
const lockFile = (h: Host) => join(h.home, ".local/state/commonair/object-backup.lock");
const restoreMark = (h: Host) => join(h.home, ".local/state/commonair/object-restore-incomplete");
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
    [["--bwlimit", "10M"], "--bwlimit applies to --objects, --restore-objects, --dump and --drill only"],
    [["--database", "--bwlimit", "10M"], "--bwlimit applies to --objects, --restore-objects, --dump and --drill only"],
    [["--max-delete"], "--max-delete needs a value"],
    [["--max-delete", "5"], "--max-delete applies to --objects only"],
    [["--restore-objects", "--max-delete", "5"], "--max-delete applies to --objects only"],
    [["--allow-empty-source"], "--allow-empty-source applies to --objects only"],
    [["--restore-objects", "--allow-empty-source"], "--allow-empty-source applies to --objects only"],
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
    for (const flag of [
      "--database",
      "--objects",
      "--restore-objects",
      "--bwlimit",
      "--max-delete",
      "--allow-empty-source",
    ])
      expect(r.out).toContain(flag);
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
      "rclone sync cainstance:commonair-media caoffsite:ca-objects/prod/media --checksum --stats=1m --stats-one-line --stats-log-level=NOTICE --max-delete=1000",
      "rclone sync cainstance:commonair-evidence caoffsite:ca-objects/prod/evidence --checksum --stats=1m --stats-one-line --stats-log-level=NOTICE --max-delete=1000",
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
    const h = host({ ...GARAGE_ENV, ...REMOTE }, { recordArgv: true });
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
    [{ BACKUP_OBJECTS_MAX_DELETE: "-1" }, "not a deletion limit: -1"],
    [{ BACKUP_OBJECTS_MAX_DELETE: "10;rm" }, "not a deletion limit"],
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
    const h = host(
      {
        ...EXTERNAL_ENV,
        ...REMOTE,
        BACKUP_OBJECTS_SOURCE_ENDPOINT: "https://nyc3.example.net",
        BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID: "DO00READONLYSOURCE01",
        BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY: "SrcSecret/OnlyInEnv+0123456789",
      },
      { recordArgv: true },
    );
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
    const h = host({ ...GARAGE_ENV, ...REMOTE }, { recordArgv: true });
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

describe("an empty bucket and mass deletions", () => {
  const MEDIA_SRC = "cainstance:commonair-media";
  const MEDIA_DST = "caoffsite:ca-objects/prod/media";
  const EVIDENCE_SRC = "cainstance:commonair-evidence";
  const EVIDENCE_DST = "caoffsite:ca-objects/prod/evidence";

  test("both buckets are listed, source and copy, before anything is copied", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"]));
    const calls = h.calls().filter((c) => c.startsWith("rclone "));
    expect(calls.slice(0, 2)).toEqual([
      `rclone lsf --max-depth 1 ${MEDIA_SRC}`,
      `rclone lsf --max-depth 1 ${EVIDENCE_SRC}`,
    ]);
    // A bucket that is not empty needs no look at its copy.
    expect(lsfCalls(h).length).toBe(2);
    expect(calls.slice(2).every((c) => c.startsWith("rclone sync "))).toBe(true);
  });

  test.each([
    ["the media bucket", `${MEDIA_SRC}`, "commonair-media"],
    ["the evidence bucket", `${EVIDENCE_SRC}`, "commonair-evidence"],
  ])("%s empty, its copy not (a lost Garage volume): refused, nothing copied, no state, exit 1", (_, src, bucket) => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_EMPTY: src });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${bucket} is empty but its offsite copy is not: refusing to empty the copy`);
    expect(r.err).toContain("selfhost.sh backup --restore-objects");
    expect(r.err).toContain("--allow-empty-source");
    expect(rcloneCalls(h)).toEqual([]);
    expect(existsSync(stateFile(h))).toBe(false);
    expect(h.calls().some((c) => c.includes("enable"))).toBe(false);
    expect(existsSync(lockFile(h))).toBe(false);
  });

  test("the same with an external store (a bucket emptied by mistake)", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_EMPTY: "cainstance:ca-evidence" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("ca-evidence is empty but its offsite copy is not");
    expect(rcloneCalls(h)).toEqual([]);
  });

  test("an empty bucket with an empty or never-written copy (a new instance) is copied", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(
      h.run(["backup", "--objects"], {
        STUB_EMPTY: `${MEDIA_SRC} ${MEDIA_DST} ${EVIDENCE_SRC}`,
        STUB_LSF_MISSING: EVIDENCE_DST,
      }),
    );
    expect(rcloneCalls(h).length).toBe(2);
    expect(existsSync(stateFile(h))).toBe(true);
  });

  test("--allow-empty-source copies it anyway, with a warning", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects", "--allow-empty-source"], { STUB_EMPTY: MEDIA_SRC });
    expectOk(r);
    expect(r.err).toContain("commonair-media is empty: its offsite copy will be emptied too (--allow-empty-source)");
    expect(rcloneCalls(h).length).toBe(2);
  });

  test("a listing that fails stops the run: never read as empty", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_LSF_FAIL: MEDIA_SRC });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not list commonair-media: ERROR : AccessDenied");
    expect(rcloneCalls(h)).toEqual([]);
    const h2 = host({ ...GARAGE_ENV, ...REMOTE });
    const r2 = h2.run(["backup", "--objects"], { STUB_EMPTY: MEDIA_SRC, STUB_LSF_FAIL: MEDIA_DST });
    expect(r2.code).toBe(1);
    expect(r2.err).toContain("could not list the offsite copy of commonair-media");
    expect(rcloneCalls(h2)).toEqual([]);
  });

  test("--max-delete: 1000 by default, from the env file, a flag overrides it, off drops it", () => {
    const limits = (h: Host) => rcloneCalls(h).map((c) => /--max-delete=(\d+)/.exec(c)?.[1] ?? "none");
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"]));
    expect(limits(h)).toEqual(["1000", "1000"]);
    const h2 = host({ ...GARAGE_ENV, ...REMOTE, BACKUP_OBJECTS_MAX_DELETE: "50" });
    expectOk(h2.run(["backup", "--objects"]));
    expect(limits(h2)).toEqual(["50", "50"]);
    const h3 = host({ ...GARAGE_ENV, ...REMOTE, BACKUP_OBJECTS_MAX_DELETE: "50" });
    expectOk(h3.run(["backup", "--objects", "--max-delete", "off"]));
    expect(limits(h3)).toEqual(["none", "none"]);
    // copy deletes nothing: a restore takes no limit.
    const h4 = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h4.run(["backup", "--restore-objects"]));
    expect(limits(h4)).toEqual(["none", "none"]);
  });

  test("a run rclone stops at the limit fails and says how to go on", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--objects"], { STUB_RCLONE_FAIL_ON: MEDIA_SRC });
    expect(r.code).toBe(1);
    expect(r.err).toContain("If rclone stopped at --max-delete (1000)");
    expect(r.err).toContain("--max-delete off");
  });
});

describe("one run at a time, and an unfinished restore", () => {
  test("a lock held by a running process refuses --objects and --restore-objects", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    mkdirSync(join(h.home, ".local/state/commonair"), { recursive: true });
    symlinkSync(String(process.pid), lockFile(h));
    for (const args of [["--objects"], ["--restore-objects"]]) {
      const r = h.run(["backup", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`another object backup or restore is running (pid ${process.pid})`);
    }
    expect(rcloneCalls(h)).toEqual([]);
    expect(lsfCalls(h)).toEqual([]);
    expect(existsSync(stateFile(h))).toBe(false);
    expect(existsSync(restoreMark(h))).toBe(false);
    // Not its lock: it stays.
    expect(readlinkSync(lockFile(h))).toBe(String(process.pid));
  });

  test("the lock is held during the copy and released after success and after failure", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--objects"], { STUB_HOLD: "1" }));
    expect(readdirSync(h.state).filter((f) => f.startsWith("lock-seen-")).length).toBe(1);
    expect(readdirSync(h.state).some((f) => f === "lock-seen-")).toBe(false);
    expect(existsSync(lockFile(h))).toBe(false);
    expect(h.run(["backup", "--objects"], { STUB_RCLONE_FAIL_ON: "cainstance:commonair-media" }).code).toBe(1);
    expect(existsSync(lockFile(h))).toBe(false);
    expectOk(h.run(["backup", "--restore-objects"], { STUB_HOLD: "1" }));
    expect(existsSync(lockFile(h))).toBe(false);
  });

  test("a lock whose process is gone (killed, a reboot) is taken over", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    mkdirSync(join(h.home, ".local/state/commonair"), { recursive: true });
    symlinkSync("999999", lockFile(h));
    const r = h.run(["backup", "--objects"]);
    expectOk(r);
    expect(r.err).toContain("taking over the lock of an object backup that is no longer running (pid 999999)");
    expect(existsSync(lockFile(h))).toBe(false);
  });

  test("a restore that failed blocks --objects (the timer too) until a restore succeeds", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const failed = h.run(["backup", "--restore-objects"], {
      STUB_RCLONE_FAIL_ON: "caoffsite:ca-objects/prod/evidence",
    });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("until it succeeds, backup --objects is refused");
    expect(readFileSync(restoreMark(h), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);

    const blocked = h.run(["backup", "--objects"]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("a backup --restore-objects started on");
    expect(blocked.err).toContain("has not finished");
    expect(rcloneCalls(h).filter((c) => c.startsWith("rclone sync"))).toEqual([]);
    expect(existsSync(stateFile(h))).toBe(false);

    expectOk(h.run(["backup", "--restore-objects"]));
    expect(existsSync(restoreMark(h))).toBe(false);
    expectOk(h.run(["backup", "--objects"]));
    expect(rcloneCalls(h).filter((c) => c.startsWith("rclone sync")).length).toBe(2);
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

// --- logical dumps and restore drills (S1-h) ----------------------------------------------------

/** An external Postgres (S1-b's env file keys), with the provider's CA unless told otherwise. */
const EXTERNAL_STATE = {
  STATE_MODE: "external",
  DATABASE_OWNER_URL: "postgres://doadmin@db-pg.example.ondigitalocean.com:25060/commonair?sslmode=verify-full",
  DATABASE_CA_FILE: "/run/secrets/commonair-pg-ca",
};
const DUMP_BYTES = "PGDMP-fixture-dump\n";
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const DUMPS = "caoffsite:ca-objects/prod/dumps";
const TODAY = new Date().toISOString().slice(0, 10);
const dumpState = (h: Host) => join(h.home, ".local/state/commonair/db-dump");
const drillState = (h: Host, kind: "dump" | "walg") => join(h.home, ".local/state/commonair", `restore-drill-${kind}`);
const dbLock = (h: Host) => join(h.home, ".local/state/commonair/db-backup.lock");
const podmanCalls = (h: Host) => h.calls().filter((c) => c.startsWith("podman "));
const dumpRun = (h: Host) => podmanCalls(h).filter((c) => c.includes("--entrypoint /usr/local/bin/commonair-dump "));
const purges = (h: Host) =>
  h
    .calls()
    .filter((c) => c.startsWith(`rclone purge ${DUMPS}/`))
    .map((c) => c.slice(`rclone purge ${DUMPS}/`.length));
const metrics = (h: Host) =>
  readdirSync(h.state)
    .filter((f) => f.startsWith("metrics-"))
    .sort()
    .map((f) => readFileSync(join(h.state, f), "utf8"));

/** `count` dates ending at `end`, `step` days apart, oldest first. */
function dates(count: number, step = 1, end = TODAY): string[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_v, i) =>
    new Date(last - (count - 1 - i) * step * 86_400_000).toISOString().slice(0, 10),
  );
}

/** What the store lists under dumps/: complete dumps (with a sidecar) and directories only. */
function storeHas(h: Host, complete: string[], partial: string[] = []) {
  writeFileSync(
    join(h.state, "dump-files"),
    [
      ...complete.flatMap((d) => [`${d}/commonair.dump`, `${d}/commonair.dump.sha256`, `${d}/counts.json`]),
      ...partial.map((d) => `${d}/commonair.dump.part`),
    ]
      .map((l) => `${l}\n`)
      .join(""),
  );
  writeFileSync(
    join(h.state, "dump-dirs"),
    [...complete, ...partial]
      .sort()
      .map((d) => `${d}/\n`)
      .join(""),
  );
}

/** The newest dump at the store, its bytes and (unless told otherwise) its sidecar. */
function remoteDump(h: Host, opts: { sha?: string } = {}) {
  storeHas(h, dates(3));
  writeFileSync(join(h.state, "remote-dump"), DUMP_BYTES);
  writeFileSync(join(h.state, "remote-sha"), `${opts.sha ?? sha256(DUMP_BYTES)}  commonair.dump\n`);
}

describe("backup --dump: flags and the default", () => {
  test("no flag with an external Postgres: a dump, never WAL-G", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const dbg = h.run(["backup"]);
    expectOk(dbg);
    expect(dumpRun(h).length).toBe(1);
    expect(h.calls()).not.toContain("systemctl --user start commonair-backup.service");
  });

  test("--database with an external Postgres is refused with the way to back it up", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const r = h.run(["backup", "--database"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("WAL-G cannot run against an external Postgres");
    expect(r.err).toContain("fix: selfhost.sh backup --dump");
    expect(dumpRun(h)).toEqual([]);
  });

  test("with the bundled Postgres a dump is a second copy beside WAL-G: --database first", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    expectOk(h.run(["backup", "--dump", "--database"]));
    const calls = h.calls();
    const walg = calls.indexOf("systemctl --user start commonair-backup.service");
    const dump = calls.findIndex((c) => c.includes("--entrypoint /usr/local/bin/commonair-dump "));
    expect(walg).toBeGreaterThanOrEqual(0);
    expect(dump).toBeGreaterThan(walg);
  });

  test.each([
    [["--walg"], "--walg applies to --drill only"],
    [["--drill", "--dump"], "--drill runs on its own"],
    [["--drill", "--objects"], "--drill runs on its own"],
    [["--restore-objects", "--dump"], "--restore-objects runs on its own"],
    [["--drill", "--walg", "--bwlimit", "4M"], "--bwlimit does not apply to --drill --walg"],
    [["--database", "--bwlimit", "4M"], "--bwlimit applies to --objects, --restore-objects, --dump and --drill only"],
  ])("backup %j is refused", (args, message) => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", ...args]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(podmanCalls(h)).toEqual([]);
  });

  test("BACKUP_DUMP_KEEP below 30 is refused before anything runs", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE, BACKUP_DUMP_KEEP: "7" });
    const r = h.run(["backup", "--dump"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("keep at least 30 dumps");
    expect(dumpRun(h)).toEqual([]);
  });
});

describe("backup --dump", () => {
  test("streams pg_dump from the Postgres image as the owner, then the sidecars, the checksum last", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE }, { recordArgv: true });
    const r = h.run(["backup", "--dump"]);
    expectOk(r);
    const [run] = dumpRun(h);
    // passthrough: the dump never passes through a log driver into the journal.
    expect(run).toContain("podman run --rm --log-driver passthrough --network commonair --user 0:0");
    // The owner's URL only through its secret; the provider's CA as the services get it.
    expect(run).toContain("--secret commonair-owner-database-url,type=env,target=DUMP_PG_URL");
    expect(run).toContain("--secret commonair-pg-ca,type=mount,target=/run/secrets/commonair-pg-ca,mode=0444");
    expect(run).toContain("-e PGSSLROOTCERT=/run/secrets/commonair-pg-ca");
    expect(run).toContain(PG_IMAGE);
    const dir = `${DUMPS}/${TODAY}`;
    const writes = h
      .calls()
      .filter((c) => /^rclone (rcat|moveto|deletefile) /.test(c))
      .map((c) => c.replace(/ --s3-\S+/g, ""));
    expect(writes).toEqual([
      `rclone rcat ${dir}/.private-check`,
      `rclone deletefile ${dir}/.private-check`,
      `rclone rcat ${dir}/commonair.dump.part`,
      `rclone deletefile ${dir}/commonair.dump.sha256`,
      `rclone rcat ${dir}/counts.json`,
      `rclone moveto ${dir}/commonair.dump.part ${dir}/commonair.dump`,
      `rclone rcat ${dir}/commonair.dump.sha256`,
    ]);
    expect(readFileSync(join(h.state, "rcat-commonair.dump.part"), "utf8")).toBe(DUMP_BYTES);
    expect(readFileSync(join(h.state, "rcat-commonair.dump.sha256"), "utf8")).toBe(
      `${sha256(DUMP_BYTES)}  commonair.dump\n`,
    );
    expect(readFileSync(join(h.state, "rcat-counts.json"), "utf8")).toContain('"rows.public.channels": 2');
    const state = parseEnv(readFileSync(dumpState(h), "utf8"));
    expect(state.DUMP).toBe(TODAY);
    expect(state.SIZE).toBe(String(DUMP_BYTES.length));
    expect(state.SHA256).toBe(sha256(DUMP_BYTES));
    expect(state.REMOTE).toBe("https://ams3.digitaloceanspaces.com/ca-objects/prod/dumps");
    expect(r.out).toContain(`dump done: 19 B to https://ams3.digitaloceanspaces.com/ca-objects/prod/dumps/${TODAY}`);
    noSecretIn(h.argv());
    noSecretIn(h.calls().join("\n"));
    noSecretIn(r.out + r.err);
  });

  test("no CA of its own: verify-full against the system's trusted CAs", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE, DATABASE_CA_FILE: "" });
    expectOk(h.run(["backup", "--dump"]));
    const [run] = dumpRun(h);
    expect(run).toContain("-e PGSSLROOTCERT=system");
    expect(run).not.toContain("commonair-pg-ca");
  });

  test("the first success enables the nightly timer; a later one leaves it as it is", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    expectOk(h.run(["backup", "--dump"]));
    expect(h.calls()).toContain("systemctl --user enable --now commonair-dump.timer");
    const h2 = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    mkdirSync(join(h2.home, ".local/state/commonair"), { recursive: true });
    writeFileSync(dumpState(h2), "LAST_SUCCESS=2026-11-01T02:10:00Z\n");
    expectOk(h2.run(["backup", "--dump"]));
    expect(h2.calls()).not.toContain("systemctl --user enable --now commonair-dump.timer");
  });

  test("a failed pg_dump keeps nothing: the part is deleted, no sidecar, the last success stays", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const r = h.run(["backup", "--dump"], { STUB_DUMP_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the dump failed (exit 1); nothing was kept");
    expect(r.err).toContain("commonair-dump: pg_dump failed");
    expect(h.calls()).toContain(`rclone deletefile ${DUMPS}/${TODAY}/commonair.dump.part`);
    expect(h.calls().filter((c) => c.includes("commonair.dump.sha256") || c.includes("moveto"))).toEqual([]);
    expect(existsSync(dumpState(h))).toBe(false);
    expect(purges(h)).toEqual([]);
    expect(existsSync(dbLock(h))).toBe(false);
  });

  test("an unreachable bucket fails the dump and leaves nothing behind, here or there", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const r = h.run(["backup", "--dump"], { STUB_RCAT_FAIL: "commonair.dump.part" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("uploading the dump to https://ams3.digitaloceanspaces.com/ca-objects/prod failed");
    expect(h.calls()).toContain(`rclone deletefile ${DUMPS}/${TODAY}/commonair.dump.part`);
    expect(existsSync(dumpState(h))).toBe(false);
    // Streamed, not staged: the run's temporary directory is gone.
    expect(readdirSync(join(h.home, "..", "tmp"))).toEqual([]);
  });

  test("a bucket anyone can list is refused before anything is written", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const r = h.run(["backup", "--dump"], { STUB_PUBLIC_LIST: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("lists its contents to anyone, without a key: a dump holds personal data");
    expect(r.err).toContain("fix: make the bucket private");
    expect(h.calls().filter((c) => c.startsWith("rclone rcat"))).toEqual([]);
    expect(dumpRun(h)).toEqual([]);
  });

  test("a bucket whose objects anyone can read is refused, and its probe deleted", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const r = h.run(["backup", "--dump"], { STUB_PUBLIC_READ: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("can be read without a key");
    expect(h.calls()).toContain(`rclone deletefile ${DUMPS}/${TODAY}/.private-check`);
    expect(dumpRun(h)).toEqual([]);
  });
});

describe("dump retention: 30, never fewer", () => {
  const run = (complete: string[], partial: string[] = [], env: Record<string, string> = {}) => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE, ...env });
    storeHas(h, complete, partial);
    const r = h.run(["backup", "--dump"]);
    expectOk(r);
    return { h, r };
  };

  test("fewer than 30 complete dumps: nothing is deleted", () => {
    const { h, r } = run(dates(29), dates(3, 40, "2026-01-01"));
    expect(purges(h)).toEqual([]);
    expect(r.err).toContain("29 dumps kept (retention deletes only beyond the newest 30)");
  });

  test("exactly 30: nothing is deleted", () => {
    const { h } = run(dates(30));
    expect(purges(h)).toEqual([]);
  });

  test("31: the oldest goes, the newest 30 stay", () => {
    const all = dates(31);
    const { h } = run(all);
    expect(purges(h)).toEqual([all[0]]);
  });

  test("gaps in the dates: it counts dumps, not days, and removes failed runs' leftovers older than the 30th", () => {
    // 33 dumps three days apart, with a failed run long ago and one yesterday (not a dump date).
    const all = dates(33, 3);
    const oldPartial = "2025-01-01";
    const [yesterday = ""] = dates(2);
    const { h } = run(all, [oldPartial, yesterday]);
    const gone = purges(h);
    expect(gone).toEqual([oldPartial, ...all.slice(0, 3)].sort());
    for (const kept of [...all.slice(3), yesterday]) expect(gone).not.toContain(kept);
  });

  test("an incomplete directory newer than the 30th complete dump stays", () => {
    const all = dates(31);
    const recentPartial = all[20] ?? "";
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    // The same date twice: complete in one listing would be wrong, so take a date between.
    storeHas(
      h,
      all.filter((d) => d !== recentPartial),
      [recentPartial],
    );
    expectOk(h.run(["backup", "--dump"]));
    expect(purges(h)).toEqual([]);
  });

  test("BACKUP_DUMP_KEEP keeps more, never fewer", () => {
    const all = dates(41);
    const { h } = run(all, [], { BACKUP_DUMP_KEEP: "40" });
    expect(purges(h)).toEqual([all[0]]);
  });
});

describe("one dump, drill or upgrade at a time", () => {
  test("a lock held by a running upgrade refuses a dump and a drill, and stays", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    mkdirSync(join(h.home, ".local/state/commonair"), { recursive: true });
    symlinkSync(`${process.pid}:upgrade`, dbLock(h));
    for (const args of [["--dump"], ["--drill"]]) {
      const r = h.run(["backup", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        `a database upgrade is running (pid ${process.pid}): one dump, drill or upgrade at a time`,
      );
    }
    expect(dumpRun(h)).toEqual([]);
    expect(readlinkSync(dbLock(h))).toBe(`${process.pid}:upgrade`);
  });

  test("a stale lock is taken over, and every run releases its own", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    mkdirSync(join(h.home, ".local/state/commonair"), { recursive: true });
    symlinkSync("999999:dump", dbLock(h));
    const r = h.run(["backup", "--dump"]);
    expectOk(r);
    expect(r.err).toContain("taking over the lock of a database dump that is no longer running (pid 999999)");
    expect(existsSync(dbLock(h))).toBe(false);
    expect(h.run(["backup", "--dump"], { STUB_DUMP_FAIL: "1" }).code).toBe(1);
    expect(existsSync(dbLock(h))).toBe(false);
  });
});

describe("backup --drill (the dump)", () => {
  const drillCalls = (h: Host) => podmanCalls(h).filter((c) => c.includes("commonair-drill-"));

  test("restores the newest dump in a container with no network and checks it against counts.json", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    remoteDump(h);
    const r = h.run(["backup", "--drill"]);
    expectOk(r);
    const start = podmanCalls(h).find((c) => c.startsWith("podman run -d --name commonair-drill-dump-"));
    expect(start).toBeDefined();
    expect(start).toContain("--network none --user postgres");
    expect(start).toContain("--entrypoint /usr/local/bin/commonair-dump-drill");
    expect(start).toMatch(/ serve$/);
    // Nothing that could reach the live database: no published port, no secret, no URL.
    for (const c of drillCalls(h)) {
      expect(c).not.toMatch(/ (-p|--publish|--secret|--network commonair)\b/);
      expect(c).not.toMatch(/DATABASE_URL|DUMP_PG_URL|commonair-postgres\b/);
    }
    expect(podmanCalls(h).filter((c) => c.includes("commonair-owner-database-url"))).toEqual([]);
    const execs = podmanCalls(h).filter((c) => c.startsWith("podman exec "));
    for (const e of execs)
      expect(e).toMatch(/^podman exec (-i )?--user postgres commonair-drill-dump-\d+ |commonair-otel-collector/);
    expect(execs.some((e) => e.endsWith("commonair-dump-drill restore /var/lib/postgresql/data/commonair.dump"))).toBe(
      true,
    );
    expect(readFileSync(join(h.state, "fetched.dump"), "utf8")).toBe(DUMP_BYTES);
    expect(readFileSync(join(h.state, "check-input"), "utf8")).toContain('"format": "commonair-dump-counts/1"');
    // Gone afterwards, container and volume.
    expect(podmanCalls(h).some((c) => /^podman rm -f -v -t 0 commonair-drill-dump-\d+$/.test(c))).toBe(true);
    expect(podmanCalls(h).some((c) => /^podman volume rm -f commonair-drill-dump-\d+$/.test(c))).toBe(true);
    const state = parseEnv(readFileSync(drillState(h, "dump"), "utf8"));
    expect(state.RESULT).toBe("success");
    expect(state.SOURCE).toBe(`dump ${TODAY}`);
    expect(r.out).toMatch(new RegExp(`restore drill passed \\(dump, dump ${TODAY}\\) in \\d+s`));
    const [m] = metrics(h);
    expect(m).toContain('"name":"commonair_restore_drill_success"');
    expect(m).toContain('"asDouble":1,');
    expect(m).toContain('"name":"commonair_restore_drill_seconds","unit":"s"');
    expect(m).toContain('"key":"kind","value":{"stringValue":"dump"}');
    expect(h.calls()).toContain("systemctl --user enable --now commonair-drill.timer");
  });

  test("a corrupt or truncated dump fails its checksum before any restore", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    remoteDump(h, { sha: sha256("something else") });
    const r = h.run(["backup", "--drill"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not match its SHA-256 (corrupt or truncated): nothing was restored");
    expect(podmanCalls(h).filter((c) => c.includes("commonair-dump-drill restore"))).toEqual([]);
    expect(parseEnv(readFileSync(drillState(h, "dump"), "utf8")).RESULT).toBe("failure");
    expect(metrics(h)).toHaveLength(1);
    expect(metrics(h)[0]).toContain('"asDouble":0,');
    expect(metrics(h)[0]).not.toContain("commonair_restore_drill_seconds");
    expect(podmanCalls(h).some((c) => c.startsWith("podman volume rm -f commonair-drill-dump-"))).toBe(true);
    expect(h.calls()).not.toContain("systemctl --user enable --now commonair-drill.timer");
  });

  test("counts that do not match fail the drill and say which", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    remoteDump(h);
    const r = h.run(["backup", "--drill"], { STUB_CHECK_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("follows.count_mismatch: dump 0, restored 4");
    expect(r.err).toContain("the restored copy of the dump of");
    expect(r.err).toContain("the dump restore drill FAILED");
    expect(parseEnv(readFileSync(drillState(h, "dump"), "utf8")).RESULT).toBe("failure");
    expect(podmanCalls(h).some((c) => c.startsWith("podman rm -f -v -t 0 commonair-drill-dump-"))).toBe(true);
  });

  test("too little disk: refused with a fix: line before any container starts", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    remoteDump(h);
    const r = h.run(["backup", "--drill"], { STUB_DUMP_SIZE: String(4 * 1024 ** 5) });
    expect(r.code).toBe(1);
    // Three times the dump's size, in TiB (the largest unit it names).
    expect(r.err).toContain("not enough free disk for the drill: it needs 12288.0 TiB (the dump, 4096.0 TiB, times 3)");
    expect(r.err).toContain("fix: free disk space there");
    expect(podmanCalls(h).filter((c) => c.startsWith("podman run"))).toEqual([]);
  });

  test("no complete dump yet: refused with the way to take one", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    storeHas(h, [], [TODAY]);
    const r = h.run(["backup", "--drill"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no complete dump at https://ams3.digitaloceanspaces.com/ca-objects/prod/dumps to drill");
    expect(r.err).toContain("fix: selfhost.sh backup --dump first");
  });

  test("a collector that is not running costs a warning, not the drill", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    remoteDump(h);
    const r = h.run(["backup", "--drill"], { STUB_NO_COLLECTOR: "1" });
    expectOk(r);
    expect(r.err).toContain("commonair-otel-collector is not running");
    expect(metrics(h)).toEqual([]);
  });
});

describe("backup --drill --walg", () => {
  test("restores the newest base backup into a throwaway volume, replays it without archiving or TCP, checks it", () => {
    const h = host({ ...GARAGE_ENV, ...REMOTE });
    const r = h.run(["backup", "--drill", "--walg"]);
    expectOk(r);
    const runs = podmanCalls(h).filter((c) => c.startsWith("podman run"));
    expect(runs[0]).toMatch(
      /^podman run --rm --network commonair --env-file \S+\/drill\/postgres\.env -v commonair-drill-walg-\d+:\/var\/lib\/postgresql\/data \S+ commonair-restore$/,
    );
    expect(runs[1]).toContain("--network none");
    expect(runs[2]).toMatch(/^podman run -d --name commonair-drill-walg-\d+ --network commonair /);
    expect(runs[2]).toContain("-e POSTGRES_USER=commonair -e POSTGRES_DB=commonair");
    expect(runs[2]).toMatch(/ postgres -c listen_addresses= -c archive_mode=off$/);
    // Never the live container's volume, never its secrets.
    for (const c of runs) {
      expect(c).not.toContain("commonair-postgres-data:");
      expect(c).not.toContain("--secret");
    }
    expect(podmanCalls(h).some((c) => c.endsWith("commonair-dump-drill check-walg"))).toBe(true);
    expect(parseEnv(readFileSync(drillState(h, "walg"), "utf8")).RESULT).toBe("success");
    expect(metrics(h)[0]).toContain('"key":"kind","value":{"stringValue":"walg"}');
    noSecretIn(h.calls().join("\n"));
  });

  test("with an external Postgres it is refused: WAL-G does not run there", () => {
    const h = host({ ...EXTERNAL_ENV, ...REMOTE, ...EXTERNAL_STATE });
    const r = h.run(["backup", "--drill", "--walg"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("fix: selfhost.sh backup --drill (the dump drill)");
  });
});

describe("the dump and drill units", () => {
  const unit = (f: string) => readFileSync(join(ROOT, "infra/systemd", f), "utf8");
  const keys = (u: string, key: string) => [...u.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]);

  test.each([
    ["commonair-dump", "backup --dump"],
    ["commonair-drill", "backup --drill"],
    ["commonair-drill-walg", "backup --drill --walg"],
  ])("%s.service runs selfhost.sh %s as a oneshot that starts nothing else", (name, args) => {
    const s = unit(`${name}.service`);
    expect(keys(s, "Type")).toEqual(["oneshot"]);
    expect(keys(s, "ExecStart")).toEqual([`/bin/sh %h/commonair/selfhost.sh ${args}`]);
    expect(keys(s, "Requires")).toEqual([]);
    expect(keys(s, "Requisite")).toEqual([]);
    expect(s).not.toMatch(/^\[Install\]$/m);
    const t = unit(`${name}.timer`);
    expect(keys(t, "Unit")).toEqual([`${name}.service`]);
    expect(keys(t, "Persistent")).toEqual(["true"]);
    expect(keys(t, "RandomizedDelaySec")).toHaveLength(1);
    expect(keys(t, "WantedBy")).toEqual(["timers.target"]);
  });

  test("the dump runs nightly, the drills weekly", () => {
    expect(keys(unit("commonair-dump.timer"), "OnCalendar")).toEqual(["*-*-* 02:00:00 UTC"]);
    expect(keys(unit("commonair-drill.timer"), "OnCalendar")).toEqual(["Sun *-*-* 05:00:00 UTC"]);
    expect(keys(unit("commonair-drill-walg.timer"), "OnCalendar")).toEqual(["Sun *-*-* 05:00:00 UTC"]);
  });
});
