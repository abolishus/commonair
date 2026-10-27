// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fixtures for the selfhost.sh shell tests (selfhost-sh-*.test.ts): scripts/selfhost.sh under `sh`, with PATH stubs for everything that touches the host
 * (podman, systemctl, loginctl, ss, curl, sha256sum, cosign, sleep, ip) and a fake sysroot for
 * the files it reads (/etc/os-release, /etc/subuid, the port sysctl). Real bundles from
 * bundle.ts, real tar, and the bundled init-env run by the real Bun.
 *
 * The tests are split over several files because each run of the script forks a few hundred
 * processes (seconds apiece): in one file they ran serially for minutes, the unit gate's tail.
 * The package runs at most 4 files at once (`--maxWorkers=4` in package.json): with every core
 * forking shells, each test slowed past its timeout and the whole run got longer, not shorter.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, vi } from "vite-plus/test";
import { DEFAULT_REGISTRY, RELEASE_IMAGES } from "../../release/manifest.ts";
import { buildBundle } from "../../selfhost/bundle.ts";
import { linkExecutables } from "./exec-cache.ts";

export const ROOT = new URL("../../../", import.meta.url).pathname;
export const SCRIPT = join(ROOT, "scripts/selfhost.sh");
export const TIMEOUT = 60_000;
// Every test runs selfhost.sh in a shell; under the gate's parallel load 5 s is too short.
vi.setConfig({ testTimeout: TIMEOUT });

// --- fixtures -----------------------------------------------------------------------------

export const digest = (seed: number, n: number) => `sha256:${(seed * 1000 + n).toString(16).padStart(64, "0")}`;
export const manifestJson = (version: string, seed: number) =>
  JSON.stringify({
    schema: 1,
    version,
    tag: `v${version}`,
    commit: String(seed).repeat(40).slice(0, 40),
    registry: DEFAULT_REGISTRY,
    images: Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, { digest: digest(seed, i) }])),
    platforms: ["linux/amd64"],
  });

export const VERSIONS = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"] as const;
/** Release assets as the release page serves them: bundles plus SHA256SUMS. */
export let releaseDir: string;
/** Hosts made by this file, removed after it (each holds a sysroot and tool links). */
const hosts: string[] = [];

/** Builds the release assets for this test file and removes its hosts afterwards. */
export function useReleases(): void {
  beforeAll(async () => {
    releaseDir = mkdtempSync(join(tmpdir(), "commonair-selfhost-releases-"));
    const sums: string[] = [];
    for (const [i, v] of VERSIONS.entries()) {
      const { name, data } = await buildBundle({ manifestJson: manifestJson(v, i + 1) });
      writeFileSync(join(releaseDir, name), data);
      sums.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
    }
    writeFileSync(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  }, TIMEOUT);
  afterAll(() => {
    for (const d of [releaseDir, ...hosts.splice(0)]) if (d) rmSync(d, { recursive: true, force: true });
  });
}

// Real tools the script may use; anything else is either stubbed or absent.
export const REAL_TOOLS = [
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

export const STUBS: Record<string, string> = {
  podman: String.raw`
case "$1" in
  version)
    if [ -n "\${STUB_PODMAN_BROKEN:-}" ]; then echo "\${STUB_PODMAN_BROKEN}" >&2; exit 125; fi
    echo "\${STUB_PODMAN_VERSION:-5.4.2}" ;;
  pull)
    [ -z "\${STUB_PULL_FAIL:-}" ] || exit 125
    # A registry error for the first STUB_PULL_ERR_TIMES pulls (every pull when unset).
    if [ -n "\${STUB_PULL_ERR:-}" ]; then
      n=$(cat "$STUB_STATE/pulls" 2>/dev/null || echo 0)
      echo $((n + 1)) > "$STUB_STATE/pulls"
      if [ $n -lt "\${STUB_PULL_ERR_TIMES:-999}" ]; then echo "Error: \${STUB_PULL_ERR}" >&2; exit 125; fi
    fi
    ;;
  run)
    tools="" out="" models="" script=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in
              *:/tools:*) tools=\${2%%:/tools:*} ;;
              *:/out:*) out=\${2%%:/out:*} ;;
              *:/models:*) models=\${2%%:/models:*} ;;
            esac; shift ;;
        /tools/init-env.js|/tools/fetch-model.js) script=$1 ;;
      esac
      shift
    done
    case "$script" in
      /tools/init-env.js) cd "$tools" && exec bun init-env.js --out "$out/commonair.env" --merge ;;
      /tools/fetch-model.js)
        [ -z "\${STUB_MODEL_FAIL:-}" ] || exit 1
        touch "$models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx" ;;
    esac
    ;;
  secret)
    mkdir -p "$STUB_STATE/secrets"
    # "secret create --replace <name> -": the name is the argument before "-".
    name=$(printf '%s\n' "$@" | tail -n 2 | head -n 1)
    cat > "$STUB_STATE/secrets/$name"
    ;;
  inspect) echo healthy ;;
  ps) [ -z "\${STUB_NETWORK_FOREIGN:-}" ] || echo "\${STUB_NETWORK_FOREIGN}" ;;
  network)
    case "$2" in
      rm) [ -z "\${STUB_NETWORK_RM_FAIL:-}" ] || exit 2 ;;
      inspect) echo "\${STUB_NETWORK_LEASE_START:-}" ;;
    esac ;;
  volume)
    case "$2" in inspect) echo "$STUB_STATE/caddy-data" ;; esac ;;
  exec) echo "backup-list: base_000000010000000000000003" ;;
  unshare) echo "1.0M	x" ;;
esac
exit 0
`,
  systemctl: String.raw`
cur=$(sed -n 's/^COMMONAIR_VERSION=//p' "$HOME/commonair/release.env" 2>/dev/null)
[ "$1" = --user ] && shift
case "$1" in
  --version) echo "systemd \${STUB_SYSTEMD_VERSION:-257} (257.9-1)"; exit 0 ;;
  show-environment) [ -z "\${STUB_NO_USER_SYSTEMD:-}" ] || exit 1; echo HOME=$HOME; exit 0 ;;
  is-active)
    if [ -n "\${STUB_BAD_VERSION:-}" ] && [ "$cur" = "$STUB_BAD_VERSION" ]; then echo activating; exit 3; fi
    # A unit whose start job failed with result 'dependency': inactive, and no Restart= retry.
    if [ "$2" = "\${STUB_DEP_FAILED:-none}" ] && [ -e "$STUB_STATE/dep-failed" ]; then echo inactive; exit 3; fi
    echo active; exit 0 ;;
  show) echo active; exit 0 ;;
  reset-failed) rm -f "$STUB_STATE/migrate-start-limit"; exit 0 ;;
  stop) case "$*" in *commonair-migrate.service*) : >"$STUB_STATE/migrate-stopped" ;; esac; exit 0 ;;
  start)
    if [ -n "\${STUB_DEP_FAILED:-}" ]; then
      if [ "$*" = "start --no-block $STUB_DEP_FAILED" ]; then rm -f "$STUB_STATE/dep-failed"
      elif [ "$2" = --no-block ] && [ ! -e "$STUB_STATE/dep-seen" ]; then : >"$STUB_STATE/dep-failed"; : >"$STUB_STATE/dep-seen"; fi
    fi
    case "$*" in *commonair-irc-cert.service*) [ -z "\${STUB_IRC_CERT_FAIL:-}" ] || exit 1 ;; esac
    # A failed migrate ends start-limit-hit (Restart=on-failure + StartLimitBurst), refusing
    # every later start until reset-failed.
    case "$*" in *commonair-migrate.service*)
      # A Postgres that never gets healthy: the start job waits behind it until a stop cancels
      # it (or 60 s, so a regression fails the test instead of hanging it).
      if [ "$cur" = "\${STUB_MIGRATE_HANG:-none}" ]; then
        rm -f "$STUB_STATE/migrate-stopped"; n=0
        until [ -e "$STUB_STATE/migrate-stopped" ] || [ $n -ge 1200 ]; do /bin/sleep 0.05; n=$((n + 1)); done
        echo "Job for commonair-migrate.service canceled." >&2; exit 1
      fi
      [ ! -e "$STUB_STATE/migrate-start-limit" ] || { echo "Start request repeated too quickly." >&2; exit 1; }
      [ "$cur" != "\${STUB_MIGRATE_FAIL:-none}" ] || { : >"$STUB_STATE/migrate-start-limit"; exit 1; } ;;
    esac
    case "$*" in *commonair-backup.service*) [ -z "\${STUB_BACKUP_FAIL:-}" ] || exit 1 ;; esac
    exit 0 ;;
esac
exit 0
`,
  loginctl: `echo "\${STUB_LINGER:-yes}"`,
  // Unset: synchronized; STUB_NTP=no or an empty value for the other answers.
  timedatectl: `echo "\${STUB_NTP-yes}"`,
  ss: String.raw`
case "$1" in
  -Hltn) for p in \${STUB_TCP_PORTS:-22}; do echo "LISTEN 0 4096 0.0.0.0:$p 0.0.0.0:*"; done ;;
  -Hlun) for p in \${STUB_UDP_PORTS:-}; do echo "UNCONN 0 0 0.0.0.0:$p 0.0.0.0:*"; done ;;
esac
`,
  curl: String.raw`
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in --output) out=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
src="$STUB_RELEASES/\${url##*/}"
[ "\${url##*/}" != "\${STUB_CURL_FAIL:-none}" ] || { echo "curl: (6) Could not resolve host" >&2; exit 6; }
[ -f "$src" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }
cp "$src" "$out"
`,
  cosign: `exit "\${STUB_COSIGN_EXIT:-0}"`,
  sleep: "exit 0",
  ip: "exit 0",
};

export interface Host {
  dir: string;
  home: string;
  log: string;
  /** Every real tool's argv, one line per call (what ps and /proc/<pid>/cmdline would show). */
  argv(): string;
  env: Record<string, string>;
  run(args: string[], env?: Record<string, string>): { code: number; out: string; err: string };
  calls(): string[];
}

/** A fresh fake host: Debian 13, Podman 5, user systemd, linger, subuids, port sysctl 80. */
/**
 * `recordArgv` wraps every real tool but sh and Bun to log its argv first. It triples the run
 * time, so only the install whose argv the secrets test reads turns it on.
 */
export function host(opts: { cosign?: boolean; osRelease?: string; recordArgv?: boolean } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-selfhost-host-"));
  hosts.push(dir);
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
    join(sys, "etc"),
    join(sys, "proc/sys/net/ipv4"),
    join(sys, "usr/libexec/podman"),
    join(sys, "usr/sbin"),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(sys, "etc/os-release"), opts.osRelease ?? 'ID=debian\nVERSION_ID="13"\n');
  const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  writeFileSync(join(sys, "etc/subuid"), `${user}:100000:65536\n`);
  writeFileSync(join(sys, "etc/subgid"), `${user}:100000:65536\n`);
  writeFileSync(join(sys, "proc/sys/net/ipv4/ip_unprivileged_port_start"), "80\n");
  for (const helper of ["usr/libexec/podman/catatonit", "usr/libexec/podman/aardvark-dns", "usr/sbin/nft"]) {
    writeFileSync(join(sys, helper), "");
    chmodSync(join(sys, helper), 0o755);
  }

  for (const tool of REAL_TOOLS) {
    // The Bun running this test (PATH may hold a wrapper that only works from its own directory).
    const path = tool === "bun" ? process.execPath : Bun.which(tool);
    if (!path) continue;
    if (!opts.recordArgv || tool === "sh" || tool === "bun") symlinkSync(path, join(bin, tool));
    else {
      // Records the argv, then runs the real tool.
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${argvLog}"\nexec ${path} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
  }
  const stubs: Record<string, string> = { ...STUBS };
  // sha256sum: the real one when present, else shasum (macOS) with the same flags.
  const realSha = Bun.which("sha256sum");
  stubs.sha256sum = realSha
    ? `exec ${realSha} "$@"`
    : `[ "$1" = -c ] && exec ${Bun.which("shasum")} -a 256 -c -s "$3"; exec ${Bun.which("shasum")} -a 256 "$@"`;
  if (!opts.cosign) delete stubs.cosign;
  for (const [name, body] of Object.entries(stubs)) {
    const logLine = name === "sha256sum" ? "" : `printf '%s\\n' "${name} $*" >> "$STUB_LOG"\n`;
    // String.raw keeps the backslash of `\${`, which only stops TS interpolation.
    linkExecutables(stub, { [name]: `#!/bin/sh\n${logLine}${body.replaceAll("\\${", "${")}\n` });
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
  mkdirSync(env.TMPDIR!, { recursive: true });
  return {
    dir,
    home,
    log,
    env,
    run(args, extra = {}) {
      const r = Bun.spawnSync([join(bin, "sh"), SCRIPT, ...args], { env: { ...env, ...extra }, cwd: home });
      return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
    },
    calls() {
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    },
    argv() {
      return existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "";
    },
  };
}

export const INSTALL = [
  "install",
  "--version",
  "v0.1.0",
  "--domain",
  "stream.example.org",
  "--email",
  "ops@example.org",
];
export const envOf = (h: Host) =>
  Object.fromEntries(
    readFileSync(join(h.home, ".config/commonair/commonair.env"), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
export const current = (h: Host) => readlinkSync(join(h.home, "commonair"));
export const expectOk = (r: { code: number; out: string; err: string }) => expect(r.code, `${r.out}\n${r.err}`).toBe(0);
export const mode = (p: string) => statSync(p).mode & 0o777;

// --- tests --------------------------------------------------------------------------------
