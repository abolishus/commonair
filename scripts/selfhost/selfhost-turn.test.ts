// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * coturn in scripts/selfhost.sh (P1-turn): the STUN URL and the address coturn advertises, the
 * TURN relay switch (--turn-relay, off by default, kept across upgrades), 3478/udp in the port
 * check and the firewall hints, and the status line. The script runs under `sh` on a fake host
 * as in selfhost-s3.test.ts: PATH stubs for podman, systemctl and the other host tools, a fake
 * sysroot, real bundles from bundle.ts and the bundled init-env run by the real Bun.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_REGISTRY, RELEASE_IMAGES } from "../release/manifest.ts";
import { buildBundle } from "./bundle.ts";
import { linkExecutables } from "../tests/support/exec-cache.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/selfhost.sh");
const TIMEOUT = 90_000;
vi.setConfig({ testTimeout: TIMEOUT });

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
  releaseDir = mkdtempSync(join(tmpdir(), "commonair-turn-releases-"));
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
    tools="" out="" script=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in
              *:/tools:*) tools=\${2%%:/tools:*} ;;
              *:/out:*) out=\${2%%:/out:*} ;;
              *:/models:*) touch "\${2%%:/models:*}/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx" ;;
            esac; shift ;;
        /tools/init-env.js|/tools/fetch-model.js) script=$1 ;;
      esac
      shift
    done
    case "$script" in
      /tools/init-env.js) cd "$tools" && exec bun init-env.js --out "$out/commonair.env" --merge ;;
    esac
    ;;
  secret) cat >/dev/null ;;
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
  ss: String.raw`
case "$1" in
  -Hltn) echo "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*" ;;
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
  sleep: "exit 0",
  // The host's global addresses: STUB_ADDRS, space separated (IPv4 and IPv6).
  ip: String.raw`
six=""; [ "$2" = -6 ] && six=1
for a in \${STUB_ADDRS:-}; do
  case "$a" in
    *:*) echo "2: eth0    inet6 $a/64 scope global" ;;
    *) [ -n "$six" ] || echo "2: eth0    inet $a/24 brd 0.0.0.0 scope global" ;;
  esac
done
`,
  nft: "exit 0",
  // firewalld, running only with STUB_FIREWALLD set.
  "firewall-cmd": `[ -n "\${STUB_FIREWALLD:-}" ]`,
};

interface Host {
  home: string;
  run(args: string[], env?: Record<string, string>): { code: number; out: string; err: string };
}

/** A fresh fake host (Debian 13, Podman 5, user systemd, linger, subuids, port sysctl 80). */
function host(): Host {
  const dir = mkdtempSync(join(tmpdir(), "commonair-turn-host-"));
  const home = join(dir, "home");
  const sys = join(dir, "sys");
  const stub = join(dir, "stub");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
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
    if (path) symlinkSync(path, join(bin, tool));
  }
  const stubs: Record<string, string> = { ...STUBS };
  const realSha = Bun.which("sha256sum");
  stubs.sha256sum = realSha
    ? `exec ${realSha} "$@"`
    : `[ "$1" = -c ] && exec ${Bun.which("shasum")} -a 256 -c -s "$3"; exec ${Bun.which("shasum")} -a 256 "$@"`;
  for (const [name, body] of Object.entries(stubs)) {
    linkExecutables(stub, { [name]: `#!/bin/sh\n${body.replaceAll("\\${", "${")}\n` });
  }
  const env: Record<string, string> = {
    PATH: `${stub}:${bin}`,
    HOME: home,
    TMPDIR: join(dir, "tmp"),
    COMMONAIR_SYSROOT: sys,
    COMMONAIR_HEALTH_TIMEOUT: "2",
    COMMONAIR_POLL_INTERVAL: "0",
    STUB_STATE: state,
    STUB_RELEASES: releaseDir,
  };
  return {
    home,
    run(args, extra = {}) {
      const r = Bun.spawnSync([join(bin, "sh"), SCRIPT, ...args], {
        env: { ...env, ...extra },
        cwd: home,
        stdin: "ignore",
      });
      return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
    },
  };
}

const DOMAIN = "stream.example.org";
const INSTALL = ["install", "--version", "v0.1.0", "--domain", DOMAIN, "--email", "ops@example.org"];
const UPGRADE = ["upgrade", "--version", "v0.2.0"];
const STUN = `stun:${DOMAIN}:3478`;
const TURN = `turn:${DOMAIN}:3478?transport=udp`;

const envFile = (h: Host) => join(h.home, ".config/commonair/commonair.env");
const envOf = (h: Host) =>
  Object.fromEntries(
    readFileSync(envFile(h), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const editEnv = (h: Host, fn: (text: string) => string) =>
  writeFileSync(envFile(h), fn(readFileSync(envFile(h), "utf8")));
const expectOk = (r: { code: number; out: string; err: string }) => expect(r.code, `${r.out}\n${r.err}`).toBe(0);

describe("default install: STUN on, the relay off", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host();
    r = h.run(INSTALL, { STUB_ADDRS: "2001:db8::7 203.0.113.7" });
  }, TIMEOUT);

  test("installs coturn's unit and the files it mounts", () => {
    expectOk(r);
    expect(readdirSync(join(h.home, ".config/containers/systemd"))).toContain("commonair-coturn.container");
    for (const f of ["turnserver.conf", "start.sh"])
      expect(existsSync(join(h.home, "commonair/infra/coturn", f)), f).toBe(true);
    expect(existsSync(join(h.home, "commonair/infra/selfhost/env/commonair-coturn.keys"))).toBe(true);
  });

  test("configure_env writes this instance's STUN URL and the first IPv4 address for coturn", () => {
    expect(envOf(h)).toMatchObject({
      P2P_STUN_URLS: STUN,
      P2P_TURN_URLS: "",
      MTX_WEBRTCADDITIONALHOSTS: "2001:db8::7,203.0.113.7",
      TURN_EXTERNAL_IP: "203.0.113.7",
    });
    // init-env generated the relay's secret, in case it is switched on later.
    expect(envOf(h).TURN_SHARED_SECRET?.length).toBeGreaterThanOrEqual(32);
  });

  test("the default firewall hints add only 3478/udp, no relay range and no warning", () => {
    expect(r.err).toContain("udp dports {443,8189,3478}");
    expect(r.err).not.toMatch(/49160|TURN relay/);
  });

  test("status says coturn runs and the relay is off, and never shows the secret", () => {
    const s = h.run(["status"]);
    expectOk(s);
    expect(s.out).toContain("p2p:       coturn active (STUN 3478/udp), TURN relay off");
    expect(s.out).toMatch(/commonair-coturn\s+active/);
    expect(s.out).not.toContain(envOf(h).TURN_SHARED_SECRET);
  });

  test(
    "a reinstall keeps an operator's TURN_EXTERNAL_IP; a new --public-ip replaces it",
    () => {
      editEnv(h, (t) => t.replace(/^TURN_EXTERNAL_IP=.*$/m, "TURN_EXTERNAL_IP=198.51.100.1"));
      expectOk(h.run(["install", "--reinstall"], { STUB_ADDRS: "203.0.113.7" }));
      expect(envOf(h).TURN_EXTERNAL_IP).toBe("198.51.100.1");
      expectOk(h.run(["install", "--reinstall", "--public-ip", "2001:db8::8,192.0.2.10"]));
      expect(envOf(h).TURN_EXTERNAL_IP).toBe("192.0.2.10");
      expect(envOf(h).P2P_TURN_URLS).toBe("");
    },
    TIMEOUT,
  );
});

describe("the address coturn advertises", () => {
  test(
    "an IPv6-only host advertises its IPv6 address; a host without any leaves it empty",
    () => {
      const v6 = host();
      expectOk(v6.run([...INSTALL, "--public-ip", "2001:db8::7"]));
      expect(envOf(v6).TURN_EXTERNAL_IP).toBe("2001:db8::7");
      const none = host();
      expectOk(none.run(INSTALL));
      expect(envOf(none).TURN_EXTERNAL_IP).toBe("");
      expect(envOf(none).P2P_STUN_URLS).toBe(STUN);
    },
    TIMEOUT,
  );
});

describe("--turn-relay", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host();
    r = h.run([...INSTALL, "--turn-relay", "--public-ip", "203.0.113.7"]);
  }, TIMEOUT);

  test("writes P2P_TURN_URLS for this host; the secret is there", () => {
    expectOk(r);
    expect(envOf(h)).toMatchObject({ P2P_TURN_URLS: TURN, P2P_STUN_URLS: STUN, TURN_EXTERNAL_IP: "203.0.113.7" });
    expect(envOf(h).TURN_SHARED_SECRET?.length).toBeGreaterThanOrEqual(32);
  });

  test("adds the relay range to the hints, with the cloud firewall warning", () => {
    expect(r.err).toContain("udp dports {443,8189,3478}");
    expect(r.err).toContain("and, for the TURN relay, udp dport 49160-49199");
    expect(r.err).toMatch(/WARNING: the TURN relay is on: open UDP 49160-49199 .*DigitalOcean/);
  });

  test("status shows the relay on, with its range", () => {
    expect(h.run(["status"]).out).toContain("TURN relay on (UDP 49160-49199)");
  });

  test(
    "persists across an upgrade without the flag; --no-turn-relay turns it off",
    () => {
      expectOk(h.run(UPGRADE));
      expect(envOf(h).P2P_TURN_URLS).toBe(TURN);
      expectOk(h.run(["install", "--reinstall"]));
      expect(envOf(h).P2P_TURN_URLS).toBe(TURN);
      expectOk(h.run(["install", "--reinstall", "--no-turn-relay"]));
      expect(envOf(h).P2P_TURN_URLS).toBe("");
      expect(h.run(["status"]).out).toContain("TURN relay off");
    },
    TIMEOUT,
  );

  test(
    "follows a new hostname, and refuses to turn on without a secret",
    () => {
      const g = host();
      expectOk(g.run([...INSTALL, "--turn-relay"]));
      expectOk(g.run(["install", "--reinstall", "--domain", "tv.example.org"]));
      expect(envOf(g)).toMatchObject({
        P2P_TURN_URLS: "turn:tv.example.org:3478?transport=udp",
        P2P_STUN_URLS: "stun:tv.example.org:3478",
      });
      // An operator's own relay URL stays as written.
      editEnv(g, (t) => t.replace(/^P2P_TURN_URLS=.*$/m, "P2P_TURN_URLS=turn:relay.example.net:3478"));
      expectOk(g.run(["install", "--reinstall"]));
      expect(envOf(g).P2P_TURN_URLS).toBe("turn:relay.example.net:3478");
      // An emptied secret: the relay would hand out credentials coturn cannot check.
      editEnv(g, (t) => t.replace(/^TURN_SHARED_SECRET=.*$/m, "TURN_SHARED_SECRET="));
      const refused = g.run(["install", "--reinstall", "--turn-relay"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("the TURN relay is on but");
      expect(refused.err).toContain("no TURN_SHARED_SECRET");
    },
    TIMEOUT,
  );

  test("with firewalld, the hint is the firewall-cmd rule for the range", () => {
    const f = host();
    const out = f.run([...INSTALL, "--turn-relay"], { STUB_FIREWALLD: "1" });
    expectOk(out);
    expect(out.err).toContain("--add-port={443,8189,3478}/udp");
    expect(out.err).toContain("sudo firewall-cmd --permanent --add-port=49160-49199/udp");
  });
});

describe("upgrade from a release without coturn", () => {
  test(
    "backfill_env fills the STUN URL and coturn's address, leaves the relay off and keeps set values",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      // What an older env file looks like after write_env's merge added .env.example's new keys.
      editEnv(h, (t) =>
        t
          .replace(/^P2P_STUN_URLS=.*$/m, "P2P_STUN_URLS=stun:localhost:3478")
          .replace(/^TURN_EXTERNAL_IP=.*$/m, "TURN_EXTERNAL_IP=")
          .replace(/^MTX_WEBRTCADDITIONALHOSTS=.*$/m, "")
          .concat("MTX_WEBRTCADDITIONALHOSTS=2001:db8::9,203.0.113.9\n"),
      );
      const u = h.run(UPGRADE);
      expectOk(u);
      expect(u.err).toContain(`setting P2P_STUN_URLS=${STUN}`);
      // The TURN helpers run inside cmd_upgrade: they must not clobber its variables (its _cur
      // becomes the previous release, the rollback target).
      expect(readlinkSync(join(h.home, ".local/share/commonair/previous"))).toBe(
        join(h.home, ".local/share/commonair/releases/0.1.0"),
      );
      expect(envOf(h)).toMatchObject({ P2P_STUN_URLS: STUN, TURN_EXTERNAL_IP: "203.0.113.9", P2P_TURN_URLS: "" });
    },
    TIMEOUT,
  );

  test(
    "an operator's STUN URL and address survive the upgrade; --turn-relay on upgrade turns it on",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      editEnv(h, (t) =>
        t
          .replace(/^P2P_STUN_URLS=.*$/m, "P2P_STUN_URLS=stun:stun.example.net:3478")
          .replace(/^TURN_EXTERNAL_IP=.*$/m, "TURN_EXTERNAL_IP=198.51.100.1"),
      );
      expectOk(h.run([...UPGRADE, "--turn-relay"]));
      expect(envOf(h)).toMatchObject({
        P2P_STUN_URLS: "stun:stun.example.net:3478",
        TURN_EXTERNAL_IP: "198.51.100.1",
        P2P_TURN_URLS: TURN,
      });
    },
    TIMEOUT,
  );
});

describe("the port check", () => {
  test("3478/udp in use is refused with the fix, before anything is downloaded", () => {
    const h = host();
    const r = h.run(INSTALL, { STUB_UDP_PORTS: "3478" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("ports already in use: 3478/udp");
    expect(r.err).toContain("fix:");
    expect(existsSync(join(h.home, "commonair"))).toBe(false);
  });

  test("the relay range itself is not checked (coturn takes free ports from it)", () => {
    const h = host();
    expectOk(h.run([...INSTALL, "--turn-relay"], { STUB_UDP_PORTS: "49160" }));
  });
});
