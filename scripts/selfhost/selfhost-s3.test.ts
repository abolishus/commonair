// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The object store choice of scripts/selfhost.sh (R0-b): Garage on the host by default, or an
 * external S3-compatible store with --s3-*. The script runs under `sh` with the same kind of fake
 * host as scripts/tests/selfhost-sh.test.ts: PATH stubs for podman, systemctl and the other host
 * tools, a fake sysroot, real bundles from bundle.ts and the bundled init-env run by the real Bun.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { DEFAULT_REGISTRY, RELEASE_IMAGES, bundleAssetName } from "../release/manifest.ts";
import { buildBundle } from "./bundle.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/selfhost.sh");
const TIMEOUT = 90_000;

const digest = (seed: number, n: number) => `sha256:${(seed * 1000 + n).toString(16).padStart(64, "0")}`;
const manifestJson = (version: string, seed: number) =>
  JSON.stringify({
    schema: 1,
    version,
    tag: `v${version}`,
    commit: String(seed).repeat(40).slice(0, 40),
    registry: DEFAULT_REGISTRY,
    images: Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, { digest: digest(seed, i) }])),
    platforms: ["linux/amd64"],
  });

let releaseDir: string;
beforeAll(async () => {
  releaseDir = mkdtempSync(join(tmpdir(), "commonair-s3-releases-"));
  const sums: string[] = [];
  for (const [i, v] of ["0.1.0", "0.2.0"].entries()) {
    const { name, data } = await buildBundle({ manifestJson: manifestJson(v, i + 1) });
    writeFileSync(join(releaseDir, name), data);
    sums.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  writeFileSync(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
}, TIMEOUT);

const REAL_TOOLS = [
  "sh",
  "awk",
  "basename",
  "cat",
  "chmod",
  "cp",
  "cut",
  "date",
  "dirname",
  "env",
  "find",
  "grep",
  "gzip",
  "head",
  "id",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "paste",
  "readlink",
  "rm",
  "sed",
  "sort",
  "tail",
  "tar",
  "touch",
  "tr",
  "uname",
  "wc",
  "bun",
];

const STUBS: Record<string, string> = {
  podman: String.raw`
case "$1" in
  version) echo 5.4.2 ;;
  run)
    tools="" out="" script="" envfile="" check=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in
              *:/tools:*) tools=\${2%%:/tools:*} ;;
              *:/out:*) out=\${2%%:/out:*} ;;
              *:/models:*) touch "\${2%%:/models:*}/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx" ;;
            esac; shift ;;
        --env-file) envfile=$2; shift ;;
        /tools/init-env.js|/tools/fetch-model.js) script=$1 ;;
        infra/garage/storage-init.ts) script=$1 ;;
        --check) check=1 ;;
      esac
      shift
    done
    case "$script" in
      /tools/init-env.js) cd "$tools" && exec bun init-env.js --out "$out/commonair.env" --merge ;;
      infra/garage/storage-init.ts)
        # What the check container would receive: kept for the test to inspect.
        cp "$envfile" "$STUB_STATE/storage-check.env"
        ls -l "$envfile" > "$STUB_STATE/storage-check.ls"
        echo "media     commonair-media    ok"
        [ -z "\${STUB_STORE_FAIL:-}" ] || { echo "evidence  x  FAILED: bucket x does not exist"; exit 1; }
        ;;
    esac
    ;;
  secret)
    mkdir -p "$STUB_STATE/secrets"
    name=$(printf '%s\n' "$@" | tail -n 2 | head -n 1)
    cat > "$STUB_STATE/secrets/$name"
    ;;
  inspect) echo healthy ;;
  network) case "$2" in inspect) echo 10.89.42.128 ;; esac ;;
  volume) case "$2" in inspect) echo "$STUB_STATE/caddy-data" ;; esac ;;
  unshare) echo "1.0M	x" ;;
esac
exit 0
`,
  systemctl: String.raw`
[ "$1" = --user ] && shift
case "$1" in
  --version) echo "systemd 257 (257.9-1)" ;;
  show-environment) echo HOME=$HOME ;;
  is-active|show) echo active ;;
esac
exit 0
`,
  loginctl: "echo yes",
  ss: "exit 0",
  curl: String.raw`
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in --output) out=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
src="$STUB_RELEASES/\${url##*/}"
[ -f "$src" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }
cp "$src" "$out"
`,
  sleep: "exit 0",
  ip: "exit 0",
};

interface Host {
  dir: string;
  home: string;
  env: Record<string, string>;
  run(args: string[], env?: Record<string, string>): { code: number; out: string; err: string };
  calls(): string[];
  argv(): string;
  clearLog(): void;
}

/** A fresh fake host (Debian 13, Podman 5, user systemd, linger, subuids, port sysctl 80). */
function host(opts: { recordArgv?: boolean } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-s3-host-"));
  const home = join(dir, "home");
  const sys = join(dir, "sys");
  const stub = join(dir, "stub");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const log = join(dir, "calls.log");
  const argvLog = join(dir, "argv.log");
  for (const d of [
    home,
    stub,
    bin,
    state,
    join(dir, "tmp"),
    join(sys, "etc"),
    join(sys, "proc/sys/net/ipv4"),
    join(sys, "usr/libexec/podman"),
    join(sys, "usr/sbin"),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(sys, "etc/os-release"), 'ID=debian\nVERSION_ID="13"\n');
  const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  writeFileSync(join(sys, "etc/subuid"), `${user}:100000:65536\n`);
  writeFileSync(join(sys, "etc/subgid"), `${user}:100000:65536\n`);
  writeFileSync(join(sys, "proc/sys/net/ipv4/ip_unprivileged_port_start"), "80\n");
  for (const helper of ["usr/libexec/podman/catatonit", "usr/libexec/podman/aardvark-dns", "usr/sbin/nft"]) {
    writeFileSync(join(sys, helper), "");
    chmodSync(join(sys, helper), 0o755);
  }
  for (const tool of REAL_TOOLS) {
    const path = tool === "bun" ? process.execPath : Bun.which(tool);
    if (!path) continue;
    if (!opts.recordArgv || tool === "sh" || tool === "bun") symlinkSync(path, join(bin, tool));
    else {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${argvLog}"\nexec ${path} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
  }
  const stubs: Record<string, string> = { ...STUBS };
  const realSha = Bun.which("sha256sum");
  stubs.sha256sum = realSha
    ? `exec ${realSha} "$@"`
    : `[ "$1" = -c ] && exec ${Bun.which("shasum")} -a 256 -c -s "$3"; exec ${Bun.which("shasum")} -a 256 "$@"`;
  for (const [name, body] of Object.entries(stubs)) {
    const logLine = name === "sha256sum" ? "" : `printf '%s\\n' "${name} $*" >> "$STUB_LOG"\n`;
    writeFileSync(join(stub, name), `#!/bin/sh\n${logLine}${body.replaceAll("\\${", "${")}\n`);
    chmodSync(join(stub, name), 0o755);
  }
  const env: Record<string, string> = {
    PATH: `${stub}:${bin}`,
    HOME: home,
    TMPDIR: join(dir, "tmp"),
    COMMONAIR_SYSROOT: sys,
    COMMONAIR_HEALTH_TIMEOUT: "2",
    COMMONAIR_POLL_INTERVAL: "0",
    STUB_LOG: log,
    STUB_STATE: state,
    STUB_RELEASES: releaseDir,
  };
  return {
    dir,
    home,
    env,
    run(args, extra = {}) {
      // stdin is not a terminal, so the script never prompts.
      const r = Bun.spawnSync([join(bin, "sh"), SCRIPT, ...args], {
        env: { ...env, ...extra },
        cwd: home,
        stdin: "ignore",
      });
      return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
    },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    argv: () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8") : ""),
    clearLog: () => writeFileSync(log, ""),
  };
}

const DOMAIN = "stream.example.org";
const INSTALL = ["install", "--version", "v0.1.0", "--domain", DOMAIN, "--email", "ops@example.org"];
const KEYS = {
  S3_ACCESS_KEY_ID: "DO00EXAMPLEMAINKEY01",
  S3_SECRET_ACCESS_KEY: "main/Secret+Value=0123456789abcdefMAIN",
  S3_EVIDENCE_ACCESS_KEY_ID: "DO00EXAMPLEEVIDENCE2",
  S3_EVIDENCE_SECRET_ACCESS_KEY: "evid/Secret+Value=0123456789abcdefEVID",
};
const SPACES = [
  "--s3-endpoint",
  "https://nyc3.digitaloceanspaces.com",
  "--s3-region",
  "nyc3",
  "--s3-path-style",
  "false",
];
const BUCKETS = [
  "--s3-bucket-media",
  "ca-media",
  "--s3-bucket-exports",
  "ca-exports",
  "--s3-bucket-backups",
  "ca-backups",
  "--s3-bucket-evidence",
  "ca-evidence",
];
const GARAGE_UNITS = ["commonair-garage.container", "commonair-garage-data.volume", "commonair-garage-meta.volume"];
const GARAGE_IMAGE = /^Image=(.*)$/m.exec(
  readFileSync(join(ROOT, "infra/quadlet/commonair-garage.container"), "utf8"),
)![1]!;

const envFile = (h: Host) => join(h.home, ".config/commonair/commonair.env");
const envOf = (h: Host) =>
  Object.fromEntries(
    readFileSync(envFile(h), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const installedUnits = (h: Host) => readdirSync(join(h.home, ".config/containers/systemd")).sort();
const releaseUnits = (h: Host) => readdirSync(join(h.home, "commonair/quadlet")).sort();
const expectOk = (r: { code: number; out: string; err: string }) => expect(r.code, `${r.out}\n${r.err}`).toBe(0);
const exampleKeys = readFileSync(join(ROOT, ".env.example"), "utf8")
  .split("\n")
  .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
  .map((l) => l.slice(0, l.indexOf("=")));

describe("default: Garage on this host, as before", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host();
    r = h.run(INSTALL);
  }, TIMEOUT);

  test("installs", () => expectOk(r));

  test("the env file has exactly the keys it always had: .env.example's plus the same few", () => {
    const extra = Object.keys(envOf(h)).filter((k) => !exampleKeys.includes(k));
    // What configure_env adds beyond init-env's keys, as before R0-b: no S3_MODE, no S3_CONNECT_SRC.
    expect(extra.sort()).toEqual([]);
    expect(envOf(h).S3_MODE).toBeUndefined();
    expect(envOf(h).S3_CONNECT_SRC).toBeUndefined();
  });

  test("the endpoint, region and path style the units used to pin now come from the env file", () => {
    expect(envOf(h)).toMatchObject({
      S3_ENDPOINT: "http://garage:3900",
      S3_REGION: "garage",
      S3_FORCE_PATH_STYLE: "true",
      S3_PUBLIC_ENDPOINT: `https://${DOMAIN}`,
      S3_BUCKET_MEDIA: "commonair-media",
      S3_BUCKET_EXPORTS: "commonair-exports",
      S3_BUCKET_BACKUPS: "commonair-backups",
      S3_BUCKET_EVIDENCE: "commonair-evidence",
    });
    // init-env's Garage-format keys, which storage-init imports into Garage.
    expect(envOf(h).S3_ACCESS_KEY_ID).toMatch(/^GK[0-9a-f]{24}$/);
  });

  test("every unit of the release is installed, Garage and its volumes included, and its image pulled", () => {
    expect(installedUnits(h)).toEqual(releaseUnits(h));
    for (const u of [...GARAGE_UNITS, "commonair-storage-init.container"]) expect(installedUnits(h)).toContain(u);
    expect(h.calls()).toContain(`podman pull --quiet ${GARAGE_IMAGE}`);
  });

  test("status names Garage and runs no store check", () => {
    h.clearLog();
    const s = h.run(["status"]);
    expectOk(s);
    expect(s.out).toContain("storage:   Garage on this host (commonair-garage)");
    expect(h.calls().filter((c) => c.startsWith("podman run"))).toEqual([]);
  });

  test("an instance never switches store: --s3-* on a Garage instance is refused, nothing changes", () => {
    const before = readFileSync(envFile(h), "utf8");
    h.clearLog();
    const x = h.run([...INSTALL, "--reinstall", ...SPACES], KEYS);
    expect(x.code).toBe(1);
    expect(x.err).toContain("keeps its objects in Garage on this host");
    expect(x.err).toContain("no --migrate-objects");
    expect(x.err).toContain("backups.md");
    expect(readFileSync(envFile(h), "utf8")).toBe(before);
    expect(h.calls().filter((c) => c.startsWith("curl") || c.startsWith("podman"))).toEqual([]);
  });

  test(
    "an upgrade moves an older env file's development S3 values to Garage's, and keeps Garage",
    () => {
      // What rc.2 left: init-env's development defaults, which the units overrode then.
      writeFileSync(
        envFile(h),
        readFileSync(envFile(h), "utf8")
          .replace(/^S3_ENDPOINT=.*$/m, "S3_ENDPOINT=http://localhost:3900")
          .replace(/^S3_FORCE_PATH_STYLE=.*$/m, "S3_FORCE_PATH_STYLE=false"),
      );
      const u = h.run(["upgrade", "--version", "v0.2.0"]);
      expectOk(u);
      expect(u.err).toContain("setting S3_ENDPOINT=http://garage:3900");
      expect(envOf(h)).toMatchObject({ S3_ENDPOINT: "http://garage:3900", S3_FORCE_PATH_STYLE: "true" });
      expect(envOf(h).S3_MODE).toBeUndefined();
      expect(installedUnits(h)).toEqual(releaseUnits(h));
    },
    TIMEOUT,
  );

  test(
    "rc.2's garage-init unit is stopped before its file goes, then removed",
    () => {
      const dir = join(h.home, ".config/containers/systemd");
      writeFileSync(join(dir, "commonair-garage-init.container"), "[Container]\nContainerName=commonair-garage-init\n");
      h.clearLog();
      expectOk(h.run(["install", "--reinstall"]));
      const calls = h.calls();
      const stop = calls.indexOf("systemctl --user stop commonair-garage-init.service");
      expect(stop).toBeGreaterThan(-1);
      expect(stop).toBeLessThan(calls.indexOf("systemctl --user daemon-reload"));
      expect(existsSync(join(dir, "commonair-garage-init.container"))).toBe(false);
      // Units this release ships are not stopped one by one (restart_stack stops them together).
      expect(calls.filter((c) => /^systemctl --user stop commonair-[a-z-]+\.service$/.test(c))).toEqual([
        "systemctl --user stop commonair-garage-init.service",
      ]);
    },
    TIMEOUT,
  );
});

describe("an external store", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host({ recordArgv: true });
    r = h.run([...INSTALL, ...SPACES, ...BUCKETS], KEYS);
  }, TIMEOUT);

  test("installs", () => expectOk(r));

  test("the env file says so, with the endpoint, buckets and the CSP origin of the media bucket", () => {
    expect(envOf(h)).toMatchObject({
      S3_MODE: "external",
      S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
      S3_PUBLIC_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
      S3_REGION: "nyc3",
      S3_FORCE_PATH_STYLE: "false",
      S3_BUCKET_MEDIA: "ca-media",
      S3_BUCKET_EXPORTS: "ca-exports",
      S3_BUCKET_BACKUPS: "ca-backups",
      S3_BUCKET_EVIDENCE: "ca-evidence",
      // Virtual-hosted URLs: browsers upload to the media bucket's own host.
      S3_CONNECT_SRC: "https://ca-media.nyc3.digitaloceanspaces.com",
      ...KEYS,
    });
    expect(statSync(envFile(h)).mode & 0o777).toBe(0o600);
  });

  test("the keys came from the environment and never reach a command line or the output", () => {
    const seen = `${h.calls().join("\n")}\n${h.argv()}\n${r.out}\n${r.err}`;
    expect(h.argv()).toMatch(/^awk /m);
    for (const v of Object.values(KEYS)) expect(seen).not.toContain(v);
  });

  test("no Garage: neither its unit nor its volumes are installed, nor its image pulled", () => {
    const units = installedUnits(h);
    for (const u of GARAGE_UNITS) expect(units).not.toContain(u);
    expect(units).toContain("commonair-storage-init.container");
    expect(units).toEqual(releaseUnits(h).filter((u) => !GARAGE_UNITS.includes(u)));
    expect(h.calls().filter((c) => c.includes("dxflrs/garage"))).toEqual([]);
    expect(h.calls().find((c) => c.startsWith("systemctl --user start --no-block"))).not.toContain("garage");
  });

  test("status names the store and lists its buckets through storage-init, keys in a file only", () => {
    h.clearLog();
    const s = h.run(["status"]);
    expectOk(s);
    expect(s.out).toContain(
      "storage:   external S3 at https://nyc3.digitaloceanspaces.com (region nyc3, path style false)",
    );
    expect(s.out).toContain("  media     commonair-media    ok");
    const run = h.calls().find((c) => c.startsWith("podman run"))!;
    expect(run).toContain("--network commonair --env-file ");
    expect(run).toMatch(/ bun infra\/garage\/storage-init\.ts --check$/);
    for (const v of Object.values(KEYS)) expect(`${h.calls().join("\n")}\n${s.out}\n${s.err}`).not.toContain(v);
    // The check got the storage-init unit's keys and nothing else, from a 0600 file since removed.
    const got = readFileSync(join(h.dir, "state/storage-check.env"), "utf8");
    expect(got).toContain(`S3_SECRET_ACCESS_KEY=${KEYS.S3_SECRET_ACCESS_KEY}`);
    expect(got).toContain("S3_MODE=external");
    expect(got).not.toMatch(/^(POSTGRES|AUTH_SECRET|VALKEY)/m);
    expect(readFileSync(join(h.dir, "state/storage-check.ls"), "utf8")).toMatch(/^-rw-------/);
    expect(readdirSync(join(h.dir, "tmp")).flatMap((d) => readdirSync(join(h.dir, "tmp", d)))).toEqual([]);
  });

  test("status says when the store is not ready", () => {
    const s = h.run(["status"], { STUB_STORE_FAIL: "1" });
    expectOk(s);
    expect(s.out).toContain("FAILED: bucket x does not exist");
    expect(s.out).toContain("the store is NOT ready");
  });

  test(
    "a re-install without flags or keys keeps the store and its keys",
    () => {
      const before = envOf(h);
      expectOk(h.run(["install", "--reinstall"]));
      const after = envOf(h);
      for (const k of Object.keys(before).filter((k) => k.startsWith("S3_"))) expect(after[k], k).toBe(before[k]);
      for (const u of GARAGE_UNITS) expect(installedUnits(h)).not.toContain(u);
    },
    TIMEOUT,
  );

  test(
    "a re-install may change the public endpoint alone, or replace one key pair",
    () => {
      expectOk(
        h.run(["install", "--reinstall", "--s3-public-endpoint", "https://cdn.example.net"], {
          S3_EVIDENCE_ACCESS_KEY_ID: "DO00EXAMPLEEVIDENCE3",
          S3_EVIDENCE_SECRET_ACCESS_KEY: "rotated/evidence=secret0123456789",
        }),
      );
      expect(envOf(h)).toMatchObject({
        S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        S3_PUBLIC_ENDPOINT: "https://cdn.example.net",
        S3_CONNECT_SRC: "https://ca-media.cdn.example.net",
        S3_ACCESS_KEY_ID: KEYS.S3_ACCESS_KEY_ID,
        S3_EVIDENCE_ACCESS_KEY_ID: "DO00EXAMPLEEVIDENCE3",
        S3_EVIDENCE_SECRET_ACCESS_KEY: "rotated/evidence=secret0123456789",
      });
    },
    TIMEOUT,
  );

  test(
    "an upgrade keeps the external store: mode, settings, keys, and still no Garage",
    () => {
      const before = envOf(h);
      h.clearLog();
      const u = h.run(["upgrade", "--version", "v0.2.0"]);
      expectOk(u);
      const after = envOf(h);
      for (const k of Object.keys(before).filter((k) => k.startsWith("S3_"))) expect(after[k], k).toBe(before[k]);
      expect(after.S3_MODE).toBe("external");
      for (const units of [installedUnits(h)]) for (const g of GARAGE_UNITS) expect(units).not.toContain(g);
      expect(h.calls().filter((c) => c.includes("dxflrs/garage"))).toEqual([]);
      expect(u.err).not.toContain("setting S3_ENDPOINT");
    },
    TIMEOUT,
  );

  test("upgrade takes no --s3-* flag: the store is chosen at install", () => {
    const u = h.run(["upgrade", "--version", "v0.2.0", "--s3-region", "ams3"]);
    expect(u.code).toBe(1);
    expect(u.err).toContain("--s3-* flags apply to install --reinstall, not upgrade");
  });
});

describe("choosing an external store", () => {
  test(
    "path style (the default) and the default bucket names; --s3-allow-http for a LAN store",
    () => {
      const h = host();
      const r = h.run(
        [...INSTALL, "--s3-endpoint", "http://minio.lan:9000/", "--s3-region", "us-east-1", "--s3-allow-http"],
        KEYS,
      );
      expectOk(r);
      expect(envOf(h)).toMatchObject({
        S3_MODE: "external",
        S3_ENDPOINT: "http://minio.lan:9000",
        S3_PUBLIC_ENDPOINT: "http://minio.lan:9000",
        S3_FORCE_PATH_STYLE: "true",
        S3_CONNECT_SRC: "http://minio.lan:9000",
        S3_BUCKET_MEDIA: "commonair-media",
        S3_BUCKET_EVIDENCE: "commonair-evidence",
      });
    },
    TIMEOUT,
  );

  test.each([
    [["--s3-endpoint", "https://s3.example.net/bucket"], "not an S3 endpoint"],
    [["--s3-endpoint", "ftp://s3.example.net"], "not an S3 endpoint"],
    [["--s3-endpoint", "https://user:pw@s3.example.net"], "not an S3 endpoint"],
    [["--s3-endpoint", "http://s3.example.net"], "plain http"],
    [["--s3-public-endpoint", "s3.example.net"], "not an S3 endpoint"],
    [["--s3-region", "nyc3;rm"], "not an S3 region"],
    [["--s3-path-style", "yes"], "--s3-path-style must be true or false"],
    [["--s3-bucket-media", "Media"], "not a bucket name"],
    [["--s3-bucket-exports", "a..b"], "not a bucket name"],
    [["--s3-bucket-backups", "ab"], "not a bucket name"],
    [["--s3-endpoint"], "--s3-endpoint needs a value"],
    [["--s3-secret-access-key", "abc"], "S3 keys are never flags"],
    [["--s3-access-key-id", "abc"], "S3 keys are never flags"],
    [["--s3-bogus", "x"], "unknown option"],
  ])("install %j is refused before touching the host", (args, message) => {
    const h = host();
    const r = h.run([...INSTALL, ...args], KEYS);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(h.calls()).toEqual([]);
  });

  test.each([
    ["no endpoint", ["--s3-bucket-media", "ca-media"], KEYS, "--s3-endpoint is required"],
    ["no region", ["--s3-endpoint", "https://s3.example.net"], KEYS, "--s3-region is required"],
    [
      "the same bucket twice",
      [...SPACES, "--s3-bucket-media", "same", "--s3-bucket-exports", "same"],
      KEYS,
      "four different buckets",
    ],
    [
      "no keys (and no terminal to ask on)",
      SPACES,
      {},
      "missing: S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY",
    ],
    ["half a key pair", SPACES, { ...KEYS, S3_SECRET_ACCESS_KEY: "" }, "missing: S3_SECRET_ACCESS_KEY"],
    [
      "one key for both",
      SPACES,
      { ...KEYS, S3_EVIDENCE_ACCESS_KEY_ID: KEYS.S3_ACCESS_KEY_ID },
      "S3_EVIDENCE_ACCESS_KEY_ID must be its own key",
    ],
  ] as [string, string[], Record<string, string>, string][])(
    "%s: refused before anything is downloaded",
    (_, args, env, message) => {
      const h = host();
      const r = h.run([...INSTALL, ...args], env);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
      expect(h.calls().filter((c) => c.startsWith("curl") || c.startsWith("podman"))).toEqual([]);
      expect(existsSync(envFile(h))).toBe(false);
    },
  );

  test("a malformed key is refused without echoing it", () => {
    const h = host();
    const bad = "has a space in it";
    const r = h.run([...INSTALL, ...SPACES], { ...KEYS, S3_SECRET_ACCESS_KEY: bad });
    expect(r.code).toBe(1);
    expect(r.err).toContain("S3_SECRET_ACCESS_KEY is not an S3 key");
    expect(r.err).not.toContain(bad);
  });

  test("a bogus S3_MODE in the env file stops status with the fix", () => {
    const h = host();
    mkdirSync(join(h.home, ".config/commonair"), { recursive: true });
    writeFileSync(envFile(h), "S3_MODE=minio\n");
    mkdirSync(join(h.home, ".local/share/commonair/releases/0.1.0"), { recursive: true });
    symlinkSync(join(h.home, ".local/share/commonair/releases/0.1.0"), join(h.home, "commonair"));
    const r = h.run(["status"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("S3_MODE=minio");
    expect(r.err).toContain("neither garage nor external");
  });
});

describe("as root", () => {
  test(
    "the --s3-* flags reach the service user's run; the keys only through its environment",
    () => {
      const h = host();
      const sys = h.env.COMMONAIR_SYSROOT!;
      mkdirSync(join(sys, "var/tmp"), { recursive: true });
      const userHome = join(h.dir, "commonair-home");
      mkdirSync(userHome);
      const rt = mkdtempSync("/tmp/ca-rt-");
      const bus = Bun.listen({ unix: join(rt, "bus"), socket: { data() {} } });
      mkdirSync(join(sys, "run/user"), { recursive: true });
      symlinkSync(rt, join(sys, "run/user/1234"));
      const stubs: Record<string, string> = {
        id: `case "$*" in "-u") echo 0 ;; "-un") echo root ;; "-u commonair") echo 1234 ;; *) exit 1 ;; esac`,
        getent: `echo "commonair:x:1234:1234:CommonAir:${userHome}:/bin/sh"`,
        // Records the names (never the values) of the S3 keys the service user's run inherits.
        runuser: `env | sed -n 's/^\\(S3_[A-Z_]*\\)=.*/\\1/p' | sort > "$STUB_STATE/runuser.env"\nexit 0`,
        useradd: "exit 1",
        sysctl: "exit 0",
      };
      for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(join(h.dir, "stub", name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body}\n`);
        chmodSync(join(h.dir, "stub", name), 0o755);
      }
      try {
        const r = h.run(
          [
            "install",
            "--bundle",
            join(releaseDir, bundleAssetName("0.1.0")),
            "--domain",
            DOMAIN,
            "--email",
            "ops@example.org",
            "--yes",
            ...SPACES,
            "--s3-public-endpoint",
            "https://files.example.net",
            ...BUCKETS,
          ],
          KEYS,
        );
        expect(r.code, r.err).toBe(0);
        const call = h.calls().find((c) => c.startsWith("runuser"))!;
        expect(call).toContain(
          "--s3-endpoint https://nyc3.digitaloceanspaces.com --s3-region nyc3 --s3-path-style false " +
            "--s3-public-endpoint https://files.example.net --s3-bucket-media ca-media --s3-bucket-exports ca-exports " +
            "--s3-bucket-backups ca-backups --s3-bucket-evidence ca-evidence",
        );
        for (const v of Object.values(KEYS)) expect(call).not.toContain(v);
        expect(readFileSync(join(h.dir, "state/runuser.env"), "utf8").trim().split("\n")).toEqual(
          Object.keys(KEYS).sort(),
        );
      } finally {
        bus.stop(true);
        Bun.spawnSync(["rm", "-rf", rt]);
      }
    },
    TIMEOUT,
  );
});

describe("--help", () => {
  test("documents every storage flag and where the keys come from", () => {
    const out = host().run(["--help"]).out;
    for (const f of [
      "--s3-endpoint",
      "--s3-region",
      "--s3-path-style true|false",
      "--s3-public-endpoint",
      "--s3-bucket-media",
      "--s3-bucket-exports",
      "--s3-bucket-backups",
      "--s3-bucket-evidence",
      "--s3-allow-http",
      "S3_EVIDENCE_SECRET_ACCESS_KEY",
      "--migrate-objects",
    ])
      expect(out).toContain(f);
  });
});
