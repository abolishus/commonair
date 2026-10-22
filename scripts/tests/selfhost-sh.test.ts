// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * scripts/selfhost.sh under `sh`, with PATH stubs for everything that touches the host
 * (podman, systemctl, loginctl, ss, curl, sha256sum, cosign, sleep, ip) and a fake sysroot for
 * the files it reads (/etc/os-release, /etc/subuid, the port sysctl). Real bundles from
 * bundle.ts, real tar, and the bundled init-env run by the real Bun.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { SITE } from "../../packages/config/src/site.ts";
import { DEFAULT_REGISTRY, RELEASE_IMAGES, bundleAssetName } from "../release/manifest.ts";
import { buildBundle } from "../selfhost/bundle.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/selfhost.sh");
const TIMEOUT = 60_000;

// --- fixtures -----------------------------------------------------------------------------

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

const VERSIONS = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"] as const;
/** Release assets as the release page serves them: bundles plus SHA256SUMS. */
let releaseDir: string;

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

// Real tools the script may use; anything else is either stubbed or absent.
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
  version) echo "\${STUB_PODMAN_VERSION:-5.4.2}" ;;
  pull)
    [ -z "\${STUB_PULL_FAIL:-}" ] || exit 125
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
    echo active; exit 0 ;;
  show) echo active; exit 0 ;;
  start)
    case "$*" in *commonair-migrate.service*) [ "$cur" != "\${STUB_MIGRATE_FAIL:-none}" ] || exit 1 ;; esac
    case "$*" in *commonair-backup.service*) [ -z "\${STUB_BACKUP_FAIL:-}" ] || exit 1 ;; esac
    exit 0 ;;
esac
exit 0
`,
  loginctl: `echo "\${STUB_LINGER:-yes}"`,
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
[ -f "$src" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }
cp "$src" "$out"
`,
  cosign: `exit "\${STUB_COSIGN_EXIT:-0}"`,
  sleep: "exit 0",
  ip: "exit 0",
};

interface Host {
  dir: string;
  home: string;
  log: string;
  env: Record<string, string>;
  run(args: string[], env?: Record<string, string>): { code: number; out: string; err: string };
  calls(): string[];
}

/** A fresh fake host: Debian 13, Podman 5, user systemd, linger, subuids, port sysctl 80. */
function host(opts: { cosign?: boolean; osRelease?: string } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-selfhost-host-"));
  const home = join(dir, "home");
  const sys = join(dir, "sys");
  const stub = join(dir, "stub");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const log = join(dir, "calls.log");
  for (const d of [
    home,
    stub,
    bin,
    state,
    join(sys, "etc"),
    join(sys, "proc/sys/net/ipv4"),
    join(sys, "usr/libexec/podman"),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(sys, "etc/os-release"), opts.osRelease ?? 'ID=debian\nVERSION_ID="13"\n');
  const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  writeFileSync(join(sys, "etc/subuid"), `${user}:100000:65536\n`);
  writeFileSync(join(sys, "etc/subgid"), `${user}:100000:65536\n`);
  writeFileSync(join(sys, "proc/sys/net/ipv4/ip_unprivileged_port_start"), "80\n");
  writeFileSync(join(sys, "usr/libexec/podman/catatonit"), "");
  chmodSync(join(sys, "usr/libexec/podman/catatonit"), 0o755);

  for (const tool of REAL_TOOLS) {
    // The Bun running this test (PATH may hold a wrapper that only works from its own directory).
    const path = tool === "bun" ? process.execPath : Bun.which(tool);
    if (path) symlinkSync(path, join(bin, tool));
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
  };
}

const INSTALL = ["install", "--version", "v0.1.0", "--domain", "stream.example.org", "--email", "ops@example.org"];
const envOf = (h: Host) =>
  Object.fromEntries(
    readFileSync(join(h.home, ".config/commonair/commonair.env"), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const current = (h: Host) => readlinkSync(join(h.home, "commonair"));
const expectOk = (r: { code: number; out: string; err: string }) => expect(r.code, `${r.out}\n${r.err}`).toBe(0);
const mode = (p: string) => statSync(p).mode & 0o777;

// --- tests --------------------------------------------------------------------------------

describe("arguments", () => {
  test("--help prints the commands and every install flag", () => {
    const r = host().run(["--help"]);
    expect(r.code).toBe(0);
    for (const word of ["install", "upgrade", "backup", "status"]) expect(r.out).toContain(`  ${word}`);
    for (const flag of [
      "--version",
      "--bundle",
      "--domain",
      "--email",
      "--tls acme|internal",
      "--registry",
      "--public-ip",
      "--require-signature",
      "--yes",
      "--unsupported-distro",
    ])
      expect(r.out).toContain(flag);
    expect(host().run(["install", "--help"]).out).toContain("Usage: selfhost.sh");
  });

  test("no command prints usage and exits 2; unknown ones are refused", () => {
    const h = host();
    expect(h.run([]).code).toBe(2);
    expect(h.run(["frobnicate"]).err).toContain("unknown command: frobnicate");
    expect(h.run(["install", "--bogus"]).err).toContain("unknown option: --bogus");
  });

  test.each([
    [["--tls", "selfsigned"], "--tls must be acme or internal"],
    [["--version", "1.2"], "not a release version"],
    [["--version", "v1.2.3", "--bundle", "x.tar.gz"], "exclusive"],
    [["--domain", "not a host"], "not a hostname"],
    [["--domain", "-bad.example.org"], "not a hostname"],
    [["--email", "nope"], "not an email address"],
    [["--registry", "UPPER/case"], "not a registry"],
    [["--public-ip", "1.2.3.4;rm"], "not a comma-separated address list"],
    [["--domain"], "--domain needs a value"],
  ])("install %j is refused before touching the host", (args, message) => {
    const h = host();
    const r = h.run(["install", ...args]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(h.calls()).toEqual([]);
  });
});

describe("host checks", () => {
  const debian = 'ID=debian\nVERSION_ID="13"\n';
  test.each([
    ["Ubuntu", 'ID=ubuntu\nVERSION_ID="24.04"\n', {}, "unsupported distribution: ubuntu 24.04"],
    ["Debian 12", 'ID=debian\nVERSION_ID="12"\n', {}, "unsupported distribution: debian 12"],
    ["Fedora 41", 'ID=fedora\nVERSION_ID="41"\n', {}, "unsupported distribution: fedora 41"],
    ["Podman older than 5", debian, { STUB_PODMAN_VERSION: "4.9.3" }, "Podman 4.9.3 is too old"],
    ["systemd without RestartSteps", debian, { STUB_SYSTEMD_VERSION: "252" }, "systemd 252 is too old"],
    ["no user systemd", debian, { STUB_NO_USER_SYSTEMD: "1" }, "no systemd user manager"],
    ["linger off", debian, { STUB_LINGER: "no" }, "linger is off"],
    ["port 443 taken", debian, { STUB_TCP_PORTS: "22 443" }, "ports already in use: 443/tcp"],
    ["ICE port taken", debian, { STUB_UDP_PORTS: "8189" }, "ports already in use: 8189/udp"],
  ] as [string, string, Record<string, string>, string][])("%s is refused with a fix", (_, osRelease, env, message) => {
    const h = host({ osRelease });
    const r = h.run(INSTALL, env);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(r.err).toContain("fix:");
    // Nothing was downloaded or installed.
    expect(h.calls().filter((c) => c.startsWith("curl"))).toEqual([]);
    expect(existsSync(join(h.home, "commonair"))).toBe(false);
  });

  test(
    "accepts Fedora 42 and later",
    () => {
      const h = host({ osRelease: "ID=fedora\nVERSION_ID=43\n" });
      expectOk(h.run(INSTALL));
    },
    TIMEOUT,
  );

  test(
    "--unsupported-distro continues with a warning",
    () => {
      const h = host({ osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n' });
      const r = h.run([...INSTALL, "--unsupported-distro"]);
      expect(r.err).toContain("unsupported distribution ubuntu 24.04; continuing");
      expect(r.code).toBe(0);
    },
    TIMEOUT,
  );

  test("no subuid range", () => {
    const h = host();
    writeFileSync(join(h.env.COMMONAIR_SYSROOT!, "etc/subuid"), "someone-else:100000:65536\n");
    const r = h.run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no /etc/subuid entry");
    expect(r.err).toContain("usermod --add-subuids");
  });

  test("unprivileged ports start above 80", () => {
    const h = host();
    writeFileSync(join(h.env.COMMONAIR_SYSROOT!, "proc/sys/net/ipv4/ip_unprivileged_port_start"), "1024\n");
    const r = h.run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ip_unprivileged_port_start is 1024");
    expect(r.err).toContain("net.ipv4.ip_unprivileged_port_start=80");
  });

  test("catatonit missing", () => {
    const h = host();
    Bun.spawnSync(["rm", join(h.env.COMMONAIR_SYSROOT!, "usr/libexec/podman/catatonit")]);
    const r = h.run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.err).toContain("catatonit is missing");
  });

  test("as root without --yes it explains what it would do and stops", () => {
    const h = host();
    writeFileSync(
      join(h.dir, "stub/id"),
      '#!/bin/sh\n[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }\necho root\n',
    );
    chmodSync(join(h.dir, "stub/id"), 0o755);
    const r = h.run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.err).toContain("running as root");
    expect(r.err).toContain("--yes");
    expect(h.calls()).toEqual([]);
  });
});

describe("download and verification", () => {
  test(
    "downloads only over HTTPS from the repository's release URL",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const urls = h.calls().filter((c) => c.startsWith("curl"));
      const base = `${SITE.repository.url}/releases/download/v0.1.0`;
      expect(urls.map((c) => c.split(" ").at(-1))).toEqual([
        `${base}/SHA256SUMS`,
        `${base}/${bundleAssetName("0.1.0")}`,
      ]);
      for (const c of urls) expect(c).toContain("--proto =https");
    },
    TIMEOUT,
  );

  test("the script names the repository URL once, and it is SITE.repository.url", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh.match(/https:\/\/github\.com\/[^\s"'/}]+\/[^\s"'/}]+/g)).toEqual([SITE.repository.url]);
    expect(sh).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  test("a checksum mismatch aborts before anything is extracted", () => {
    const h = host();
    const bad = join(h.dir, "bad");
    mkdirSync(bad);
    const name = bundleAssetName("0.1.0");
    writeFileSync(join(bad, name), readFileSync(join(releaseDir, name)));
    writeFileSync(join(bad, "SHA256SUMS"), `${"0".repeat(64)}  ${name}\n`);
    const r = h.run([...INSTALL.filter((_, i) => i < 1 || i > 2), "--bundle", join(bad, name)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`checksum mismatch for ${name}`);
    expect(existsSync(join(h.home, ".local/share/commonair/releases"))).toBe(false);
    expect(h.calls().filter((c) => c.startsWith("podman pull"))).toEqual([]);
  });

  test("a bundle without an entry in SHA256SUMS is refused", () => {
    const h = host({});
    const r = h.run(INSTALL, {
      STUB_RELEASES: (() => {
        const d = join(h.dir, "rel");
        mkdirSync(d);
        writeFileSync(join(d, "SHA256SUMS"), `${"1".repeat(64)}  something-else\n`);
        writeFileSync(join(d, bundleAssetName("0.1.0")), readFileSync(join(releaseDir, bundleAssetName("0.1.0"))));
        return d;
      })(),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("SHA256SUMS has no entry");
  });

  test("--require-signature without cosign aborts before downloading", () => {
    const h = host();
    const r = h.run([...INSTALL, "--require-signature"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--require-signature: cosign is not installed");
    expect(h.calls().filter((c) => c.startsWith("curl"))).toEqual([]);
  });

  test("--require-signature with a local bundle and no cosign aborts too", () => {
    const h = host();
    const r = h.run([
      "install",
      "--bundle",
      join(releaseDir, bundleAssetName("0.1.0")),
      "--domain",
      "stream.example.org",
      "--email",
      "ops@example.org",
      "--require-signature",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cosign is not installed");
    expect(existsSync(join(h.home, ".local/share/commonair/releases"))).toBe(false);
  });

  test(
    "with cosign it verifies SHA256SUMS against the release workflow identity",
    () => {
      const h = host({ cosign: true });
      writeFileSync(join(releaseDir, "SHA256SUMS.sigstore.json"), "{}");
      try {
        expectOk(h.run([...INSTALL, "--require-signature"]));
        const verify = h.calls().find((c) => c.startsWith("cosign verify-blob"))!;
        const re = `^${SITE.repository.url.replaceAll(".", "\\.")}/\\.github/workflows/release\\.yml@refs/tags/v`;
        expect(verify).toContain(`--certificate-identity-regexp ${re}`);
        expect(verify).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
        expect(verify).toMatch(/SHA256SUMS$/);
        // A signature that does not verify stops the install.
        const h2 = host({ cosign: true });
        const r = h2.run(INSTALL, { STUB_COSIGN_EXIT: "1" });
        expect(r.code).toBe(1);
        expect(r.err).toContain("does not verify");
      } finally {
        Bun.spawnSync(["rm", join(releaseDir, "SHA256SUMS.sigstore.json")]);
      }
    },
    TIMEOUT,
  );
});

describe("install", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host();
    r = h.run([...INSTALL, "--tls", "internal", "--public-ip", "203.0.113.7,2001:db8::7"]);
  }, TIMEOUT);

  test("succeeds and prints the URL and next steps", () => {
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("CommonAir 0.1.0 is running: https://stream.example.org/");
    expect(r.out).toContain("Trust its root");
    expect(r.out).toContain(`${h.dir}/state/caddy-data/caddy/pki/authorities/local/root.crt`);
  });

  test("installs the release into its versioned directory and links ~/commonair to it", () => {
    expect(lstatSync(join(h.home, "commonair")).isSymbolicLink()).toBe(true);
    expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
    expect(readFileSync(join(h.home, "commonair/infra/caddy/Caddyfile"), "utf8")).toBe(
      readFileSync(join(ROOT, "infra/caddy/Caddyfile"), "utf8"),
    );
  });

  test(".env is mode 0600 in a 0700 directory", () => {
    expect(mode(join(h.home, ".config/commonair"))).toBe(0o700);
    expect(mode(join(h.home, ".config/commonair/commonair.env"))).toBe(0o600);
  });

  test("the env file carries the instance settings and generated secrets", () => {
    const env = envOf(h);
    expect(env).toMatchObject({
      NODE_ENV: "production",
      PUBLIC_HOSTNAME: "stream.example.org",
      PUBLIC_URL: "https://stream.example.org",
      API_PUBLIC_URL: "https://stream.example.org",
      PLAYBACK_PUBLIC_URL: "https://stream.example.org",
      CHAT_PUBLIC_URL: "wss://stream.example.org/chat",
      P2P_TRACKER_URL: "wss://stream.example.org/tracker",
      MEDIA_PUBLIC_URL: "https://stream.example.org/media",
      INGEST_WHIP_PUBLIC_URL: "https://stream.example.org/live",
      INGEST_RTMP_PUBLIC_URL: "rtmp://stream.example.org/live",
      IRC_PUBLIC_HOST: "stream.example.org",
      TLS_MODE: "internal",
      ACME_EMAIL: "ops@example.org",
      SECURITY_EMAIL: "ops@example.org",
      MTX_WEBRTCADDITIONALHOSTS: "203.0.113.7,2001:db8::7",
    });
    expect(env.POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(20);
    expect(env.DATABASE_URL).toBe(`postgres://commonair_app:${env.POSTGRES_APP_PASSWORD}@postgres:5432/commonair`);
  });

  test("never prints a secret", () => {
    const env = envOf(h);
    for (const key of ["POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "GRAFANA_ADMIN_PASSWORD", "AUTH_SECRET"]) {
      expect(env[key], key).toBeTruthy();
      expect(r.out + r.err, key).not.toContain(env[key]!);
    }
    // And never passes one on a command line.
    expect(h.calls().join("\n")).not.toContain(env.POSTGRES_PASSWORD!);
  });

  test("podman secrets hold the role URLs and the Grafana password", () => {
    const env = envOf(h);
    const secret = (n: string) => readFileSync(join(h.dir, "state/secrets", n), "utf8");
    expect(secret("commonair-database-url")).toBe(
      `postgres://commonair_app:${env.POSTGRES_APP_PASSWORD}@postgres:5432/commonair`,
    );
    expect(secret("commonair-owner-database-url")).toBe(
      `postgres://commonair:${env.POSTGRES_PASSWORD}@postgres:5432/commonair`,
    );
    expect(secret("commonair-grafana-admin-password")).toBe(env.GRAFANA_ADMIN_PASSWORD);
    expect(h.calls().filter((c) => c.startsWith("podman secret create"))).toEqual([
      "podman secret create --replace commonair-database-url -",
      "podman secret create --replace commonair-owner-database-url -",
      "podman secret create --replace commonair-grafana-admin-password -",
    ]);
  });

  test("pulls every image of the release by digest", () => {
    const pulls = h.calls().filter((c) => c.startsWith("podman pull"));
    const units = readdirSync(join(h.home, "commonair/quadlet")).filter((f) => f.endsWith(".container"));
    const images = new Set(
      units.flatMap((f) =>
        [...readFileSync(join(h.home, "commonair/quadlet", f), "utf8").matchAll(/^Image=(.*)$/gm)].map((m) => m[1]!),
      ),
    );
    expect(new Set(pulls.map((c) => c.split(" ").at(-1)))).toEqual(images);
    expect(pulls).toHaveLength(images.size);
    for (const img of images) expect(img).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("creates the mounted files: empty hash lists (loudly), the model, the IRC cert directory", () => {
    const share = join(h.home, ".local/share/commonair");
    expect(readFileSync(join(share, "moderation/csam.pdq"), "utf8")).toBe("");
    expect(readFileSync(join(share, "moderation/ncii.pdq"), "utf8")).toBe("");
    expect(r.err).toMatch(/WARNING: EMPTY hash list .*csam\.pdq/);
    expect(existsSync(join(share, "models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx"))).toBe(true);
    expect(statSync(join(h.home, ".config/commonair/irc-tls")).isDirectory()).toBe(true);
  });

  test("installs the units and timers, reloads, migrates first, then starts the stack", () => {
    expect(readdirSync(join(h.home, ".config/containers/systemd")).sort()).toEqual(
      readdirSync(join(h.home, "commonair/quadlet")).sort(),
    );
    expect(readdirSync(join(h.home, ".config/systemd/user")).sort()).toEqual(
      readdirSync(join(ROOT, "infra/systemd")).sort(),
    );
    const calls = h.calls();
    const at = (s: string) => calls.findIndex((c) => c.startsWith(s));
    expect(at("systemctl --user daemon-reload")).toBeGreaterThan(-1);
    expect(at("systemctl --user start commonair-migrate.service")).toBeGreaterThan(
      at("systemctl --user daemon-reload"),
    );
    const stack = calls.find((c) => c.startsWith("systemctl --user start --no-block"))!;
    for (const s of ["api", "worker", "web", "caddy", "postgres", "grafana"])
      expect(stack).toContain(`commonair-${s}.service`);
    expect(stack).not.toContain("commonair-migrate.service");
    expect(at("systemctl --user start --no-block")).toBeGreaterThan(
      at("systemctl --user start commonair-migrate.service"),
    );
    expect(calls).toContain("systemctl --user enable --now commonair-backup.timer commonair-irc-cert.timer");
    expect(calls).toContain("systemctl --user start commonair-irc-cert.service");
  });

  test("status reports the version, TLS and every unit", () => {
    const s = h.run(["status"]);
    expect(s.code, s.err).toBe(0);
    expect(s.out).toContain("version:   0.1.0");
    expect(s.out).toContain("tls: internal");
    expect(s.out).toContain("commonair-api");
    expect(s.out).toContain("commonair-irc-cert");
  });

  test("backup runs the backup unit and lists the backups", () => {
    const b = h.run(["backup"]);
    expect(b.code, b.err).toBe(0);
    expect(h.calls()).toContain("systemctl --user start commonair-backup.service");
    expect(b.out).toContain("backup-list");
  });
});

describe("re-install", () => {
  test(
    "refuses without --yes, and keeps every secret with --yes",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const before = envOf(h);
      const secretsBefore = readFileSync(join(h.dir, "state/secrets/commonair-owner-database-url"), "utf8");

      const again = h.run(INSTALL);
      expect(again.code).toBe(1);
      expect(again.err).toContain("an instance is already installed (version 0.1.0)");
      expect(envOf(h)).toEqual(before);

      const yes = h.run([...INSTALL.slice(0, 3), "--yes"]);
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
      expectOk(h.run([...INSTALL, "--yes"]));
      expect(envOf(h).ABUSE_EMAIL).toBe("abuse@example.net");
    },
    TIMEOUT,
  );

  test(
    "~/commonair that is not a link (a git clone) is never replaced",
    () => {
      const h = host();
      mkdirSync(join(h.home, "commonair"));
      const r = h.run([...INSTALL, "--yes"]);
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

describe("upgrade", () => {
  test(
    "verify, pull, back up, install units, migrate before api and worker, health",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
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

  test(
    "a failed migration rolls back as well",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      // Fails only for the new release (the stub reads the version ~/commonair points at).
      const r = h.run(["upgrade", "--version", "v0.2.0"], { STUB_MIGRATE_FAIL: "0.2.0" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("rolled back to 0.1.0, which is healthy");
      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
      // The new release's stack was never started.
      const calls = h.calls();
      const failed = calls.indexOf(
        "systemctl --user start commonair-migrate.service",
        calls.indexOf("systemctl --user start commonair-backup.service"),
      );
      expect(calls[failed + 1]).not.toMatch(/^systemctl --user start --no-block/);
    },
    TIMEOUT,
  );

  test(
    "keeps only the current and the previous release on disk",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      expectOk(h.run(["upgrade", "--version", "v0.4.0"]));
      expect(readdirSync(join(h.home, ".local/share/commonair/releases")).sort()).toEqual(["0.2.0", "0.4.0"]);
    },
    TIMEOUT,
  );

  test(
    "refuses the version that is already installed, and needs an instance",
    () => {
      const h = host();
      expect(h.run(["upgrade", "--version", "v0.2.0"]).err).toContain("no instance installed here");
      expectOk(h.run(INSTALL));
      const r = h.run(["upgrade", "--version", "v0.1.0"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("version 0.1.0 is already installed");
    },
    TIMEOUT,
  );
});

describe("shellcheck", () => {
  // The binary when installed, else the pinned image; CI must not skip (CI=true).
  const SHELLCHECK_IMAGE =
    "docker.io/koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d";
  const bin = Bun.which("shellcheck");
  const podman = Bun.which("podman");
  // Skips only on a developer machine with neither; in CI the test runs and fails instead.
  test.skipIf(!bin && !podman && process.env.CI !== "true")(
    "selfhost.sh is clean (POSIX sh)",
    () => {
      if (!bin && !podman) throw new Error("shellcheck (or podman for the pinned image) is required in CI");
      const r = bin
        ? Bun.spawnSync([bin, "--shell=sh", "--severity=style", SCRIPT])
        : Bun.spawnSync([
            podman!,
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            `${SCRIPT}:/mnt/selfhost.sh:ro,Z`,
            SHELLCHECK_IMAGE,
            "--shell=sh",
            "--severity=style",
            "/mnt/selfhost.sh",
          ]);
      expect(r.exitCode, `${r.stdout.toString()}${r.stderr.toString()}`).toBe(0);
    },
    300_000,
  );
});
