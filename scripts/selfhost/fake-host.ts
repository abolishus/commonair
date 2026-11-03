// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fake host for the external-state shell tests (S1-b): scripts/selfhost.sh runs under `sh` with
 * PATH stubs for podman, systemctl and the other host tools, a fake sysroot, real bundles from
 * bundle.ts and the bundled init-env run by the real Bun, as in selfhost-s3.test.ts. The podman
 * stub also plays infra/selfhost/state-check.ts (its preflight and status) and `podman secret
 * exists`, and records what each state-check run received:
 *
 *   state/secrets/<name>              each secret's content
 *   state/state-check-<mode>.env      STATE_* variables podman passed by name (--env)
 *   state/state-check-<mode>.args     its arguments (secrets and mounts), never a value
 *   state/state-check-<mode>.mount/   the files of the mounted CA directory
 *
 * STUB_PREFLIGHT_FAIL: the preflight fails with that message.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY, RELEASE_IMAGES } from "../release/manifest.ts";
import { linkExecutables } from "../tests/support/exec-cache.ts";
import { buildBundle } from "./bundle.ts";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const SCRIPT = join(ROOT, "scripts/selfhost.sh");

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

/** Bundles 0.1.0 and 0.2.0 with their SHA256SUMS, in a fresh directory. */
export async function buildReleases(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "commonair-ext-releases-"));
  const sums: string[] = [];
  for (const [i, v] of ["0.1.0", "0.2.0"].entries()) {
    const { name, data } = await buildBundle({ manifestJson: manifestJson(v, i + 1) });
    writeFileSync(join(dir, name), data);
    sums.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return dir;
}

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
  "od",
  "paste",
  "readlink",
  "rm",
  "rmdir",
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
    tools="" out="" script="" mode="" mount=""
    args=""
    for a in "$@"; do args="$args $a"; done
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in
              *:/tools:*) tools=\${2%%:/tools:*} ;;
              *:/out:*) out=\${2%%:/out:*} ;;
              *:/models:*) touch "\${2%%:/models:*}/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx" ;;
              *:/run/state-check:*) mount=\${2%%:/run/state-check:*} ;;
            esac; shift ;;
        /tools/init-env.js|/tools/fetch-model.js) script=$1 ;;
        infra/selfhost/state-check.ts) script=$1; mode=$2 ;;
      esac
      shift
    done
    case "$script" in
      /tools/init-env.js) cd "$tools" && exec bun init-env.js --out "$out/commonair.env" --merge ;;
      infra/selfhost/state-check.ts)
        printf '%s\n' "$args" > "$STUB_STATE/state-check-$mode.args"
        env | grep '^STATE_' | sort > "$STUB_STATE/state-check-$mode.env" || true
        rm -rf "$STUB_STATE/state-check-$mode.mount"
        [ -z "$mount" ] || cp -R "$mount" "$STUB_STATE/state-check-$mode.mount"
        if [ "$mode" = status ]; then
          echo "postgres  reachable, TLS verified, PostgreSQL 17.6, 3/22 connections in use (doadmin@db.example.com:25060/commonair, 12 ms)"
          echo "valkey    reachable, TLS verified, PING ok (cache.example.com:25061, 4 ms)"
          exit 0
        fi
        if [ -n "\${STUB_PREFLIGHT_FAIL:-}" ]; then
          echo "error: postgres: \${STUB_PREFLIGHT_FAIL}"
          echo "  fix: what the operator does"
          exit 1
        fi
        echo "ok: postgres: TLS verified (CN=db.example.com)"
        echo "ok: valkey: maxmemory-policy noeviction"
        ;;
    esac
    ;;
  secret)
    mkdir -p "$STUB_STATE/secrets"
    case "$2" in
      exists) [ -f "$STUB_STATE/secrets/$3" ] ;;
      rm) rm -f "$STUB_STATE/secrets/$3" ;;
      *)
        # "secret create --replace <name> <file|->": the name is the argument before the data.
        name=$(printf '%s\n' "$@" | tail -n 2 | head -n 1)
        data=$(printf '%s\n' "$@" | tail -n 1)
        if [ "$data" = - ]; then
          # As podman (cmd/podman/secrets/create.go): "-" reads a pipe only, never a redirected file.
          [ -p /dev/stdin ] || { echo 'Error: if - is used, data must be passed into stdin' >&2; exit 125; }
          cat > "$STUB_STATE/secrets/$name"
        else
          cat "$data" > "$STUB_STATE/secrets/$name"
        fi ;;
    esac
    exit $?
    ;;
  inspect) echo healthy ;;
  network)
    case "$2" in
      inspect) echo 10.89.42.128 ;;
      exists) [ -e "$STUB_STATE/network" ]; exit $? ;;
    esac ;;
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

export interface Run {
  code: number;
  out: string;
  err: string;
}

export interface Host {
  dir: string;
  home: string;
  env: Record<string, string>;
  run(args: string[], env?: Record<string, string>): Run;
  calls(): string[];
  argv(): string;
  clearLog(): void;
  state(file: string): string;
}

/** A fresh fake host (Debian 13, Podman 5, user systemd, linger, subuids, port sysctl 80). */
export function host(releases: string, opts: { recordArgv?: boolean } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-ext-host-"));
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
    STUB_RELEASES: releases,
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
    state: (file) => readFileSync(join(state, file), "utf8"),
  };
}

export const envFile = (h: Host) => join(h.home, ".config/commonair/commonair.env");
export const envOf = (h: Host): Record<string, string> =>
  existsSync(envFile(h))
    ? Object.fromEntries(
        readFileSync(envFile(h), "utf8")
          .split("\n")
          .filter((l) => /^[A-Z0-9_]+=/.test(l))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      )
    : {};
export const quadletDir = (h: Host) => join(h.home, ".config/containers/systemd");
export const systemdDir = (h: Host) => join(h.home, ".config/systemd/user");
export const secretPath = (h: Host, name: string) => join(h.dir, "state/secrets", name);
