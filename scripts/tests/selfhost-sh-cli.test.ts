// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Arguments, running as root, a fresh install, unit housekeeping, the env file and shellcheck. */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { bundleAssetName } from "../release/manifest.ts";
import { linkExecutables } from "./support/exec-cache.ts";
import { shellcheck, shellcheckAvailable } from "./support/shellcheck.ts";
import {
  type Host,
  ROOT,
  SCRIPT,
  TIMEOUT,
  releaseDir,
  host,
  INSTALL,
  envOf,
  current,
  expectOk,
  mode,
  useReleases,
} from "./support/selfhost-host.ts";

useReleases();

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
      "--reinstall",
      "--unsupported-distro",
      "--turn-relay",
      "--no-turn-relay",
      "--web-push",
      "--no-web-push",
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

describe("as root", () => {
  /** Runs install as a stubbed root, with the old staging path planted as symlinks to a victim. */
  const asRoot = (
    bundleDir: (h: Host, victim: string) => string,
    extra: string[],
    prepare: (h: Host, stubs: Record<string, string>) => void = () => {},
  ) => {
    const h = host();
    const sys = h.env.COMMONAIR_SYSROOT!;
    mkdirSync(join(sys, "var/tmp"), { recursive: true });
    // The service user's home, with the old staging path pre-planted as symlinks to a file
    // root owns: a root cp or chown through them would overwrite or hand it over.
    const userHome = join(h.dir, "commonair-home");
    const victim = join(h.dir, "victim");
    writeFileSync(victim, "root-owned\n");
    mkdirSync(join(userHome, ".cache/commonair-install"), { recursive: true });
    for (const f of ["selfhost.sh", "SHA256SUMS", bundleAssetName("0.1.0"), "model.onnx"])
      symlinkSync(victim, join(userHome, ".cache/commonair-install", f));
    // A short path for the user manager's bus socket (unix socket paths are length-limited).
    const rt = mkdtempSync("/tmp/ca-rt-");
    const bus = Bun.listen({ unix: join(rt, "bus"), socket: { data() {} } });
    mkdirSync(join(sys, "run/user"), { recursive: true });
    symlinkSync(rt, join(sys, "run/user/1234"));
    const stubs: Record<string, string> = {
      id: `case "$*" in "-u") echo 0 ;; "-un") echo root ;; "-u commonair") echo 1234 ;; *) exit 1 ;; esac`,
      getent: `echo "commonair:x:1234:1234:CommonAir:${userHome}:/bin/sh"`,
      // Records what the service user would be handed, then succeeds.
      runuser: String.raw`
printf '%s\n' "runuser $*" >> "$STUB_LOG"
for a in "$@"; do case "$a" in */selfhost.sh) stage=\${a%/selfhost.sh} ;; esac; done
ls -ld "$stage" > "$STUB_STATE/stage.ls"
ls -l "$stage" >> "$STUB_STATE/stage.ls"
printf '%s' "$stage" > "$STUB_STATE/stage.path"
exit 0`,
      useradd: "exit 1",
      sysctl: "exit 0",
    };
    prepare(h, stubs);
    for (const [name, body] of Object.entries(stubs))
      linkExecutables(join(h.dir, "stub"), { [name]: `#!/bin/sh\n${body.replaceAll("\\${", "${")}\n` });
    try {
      const r = h.run([
        "install",
        "--bundle",
        join(bundleDir(h, victim), bundleAssetName("0.1.0")),
        "--domain",
        "stream.example.org",
        "--email",
        "ops@example.org",
        "--yes",
        ...extra,
      ]);
      return { h, r, sys, userHome, victim };
    } finally {
      bus.stop(true);
      Bun.spawnSync(["rm", "-rf", rt]);
    }
  };

  test.each([
    ["--yes", [] as string[]],
    ["--yes --reinstall", ["--reinstall"]],
  ])(
    "%s: stages its inputs in a new root-owned directory, never writes into the service user's home, and forwards only --reinstall",
    (_, extra) => {
      const { h, r, sys, userHome, victim } = asRoot(() => releaseDir, extra);
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(victim, "utf8")).toBe("root-owned\n");
      const stage = readFileSync(join(h.dir, "state/stage.path"), "utf8");
      expect(stage.startsWith(join(sys, "var/tmp/commonair-install."))).toBe(true);
      const listing = readFileSync(join(h.dir, "state/stage.ls"), "utf8").trim().split("\n");
      // The directory is readable but not writable by anyone else; so are the files.
      expect(listing[0]).toMatch(/^drwxr-xr-x/);
      const files = listing.filter((l) => l.startsWith("-"));
      expect(files.map((l) => l.split(/\s+/).at(-1) ?? "").toSorted()).toEqual(
        ["SHA256SUMS", bundleAssetName("0.1.0"), "selfhost.sh"].sort(),
      );
      for (const l of files) expect(l).toMatch(/^-rw-r--r--/);
      // Removed once the service user's run is over.
      expect(existsSync(stage)).toBe(false);
      const call = h.calls().find((c) => c.startsWith("runuser"))!;
      expect(call).toContain(`-u commonair -- env HOME=${userHome}`);
      expect(call).toContain(`${stage}/selfhost.sh install --bundle ${stage}/${bundleAssetName("0.1.0")}`);
      // --yes allowed the host preparation; it must not become consent to reinstall.
      expect(call).not.toContain("--yes");
      expect(call.includes("--reinstall")).toBe(extra.includes("--reinstall"));
      expect(h.calls().some((c) => c.startsWith("chown"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a Podman installed without recommends gets its network helpers",
    () => {
      const { h, r } = asRoot(
        () => releaseDir,
        [],
        (h, stubs) => {
          Bun.spawnSync(["rm", join(h.env.COMMONAIR_SYSROOT!, "usr/sbin/nft")]);
          stubs["apt-get"] = String.raw`printf '%s
' "apt-get $*" >> "$STUB_LOG"`;
        },
      );
      expect(r.code, r.err).toBe(0);
      const install = h.calls().find((c) => c.startsWith("apt-get install"));
      expect(install).toBeDefined();
      for (const pkg of ["podman", "catatonit", "aardvark-dns", "nftables", "passt", "uidmap", "rclone"])
        expect(install!.split(" ")).toContain(pkg);
    },
    TIMEOUT,
  );

  test(
    "refuses to stage a symlinked input, which could point root at any file",
    () => {
      // A bundle path the service user could point anywhere, e.g. at a root-only file.
      const { h, r, sys, victim } = asRoot((h, victim) => {
        const linked = join(h.dir, "linked");
        mkdirSync(linked);
        symlinkSync(victim, join(linked, bundleAssetName("0.1.0")));
        copyFileSync(join(releaseDir, "SHA256SUMS"), join(linked, "SHA256SUMS"));
        return linked;
      }, []);
      expect(r.code).toBe(1);
      expect(r.err).toContain("refusing to stage a symlink as root");
      expect(readFileSync(victim, "utf8")).toBe("root-owned\n");
      expect(h.calls().some((c) => c.startsWith("runuser"))).toBe(false);
      expect(readdirSync(join(sys, "var/tmp"))).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("install", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host({ recordArgv: true });
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
      // Presigned uploads and export downloads through Caddy (ADR 0024).
      S3_PUBLIC_ENDPOINT: "https://stream.example.org",
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
    // Valkey's password, and the in-network URL that carries it.
    expect(env.VALKEY_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(env.VALKEY_URL).toBe(`redis://:${env.VALKEY_PASSWORD}@valkey:6379`);
  });

  test("never prints a secret", () => {
    const env = envOf(h);
    for (const key of [
      "POSTGRES_PASSWORD",
      "POSTGRES_APP_PASSWORD",
      "GRAFANA_ADMIN_PASSWORD",
      "AUTH_SECRET",
      "VALKEY_PASSWORD",
    ]) {
      expect(env[key], key).toBeTruthy();
      expect(r.out + r.err, key).not.toContain(env[key]!);
    }
    // And never passes one on a command line.
    expect(h.calls().join("\n")).not.toContain(env.POSTGRES_PASSWORD!);
  });

  test("never passes a password in any command's argv (stubs and real tools alike)", () => {
    const env = envOf(h);
    const argv = `${h.calls().join("\n")}\n${h.argv()}`;
    // The wrappers did record the real tools (awk writes the env file).
    expect(argv).toMatch(/^awk /m);
    for (const key of [
      "POSTGRES_PASSWORD",
      "POSTGRES_APP_PASSWORD",
      "GRAFANA_ADMIN_PASSWORD",
      "AUTH_SECRET",
      "VALKEY_PASSWORD",
    ])
      expect(argv, key).not.toContain(env[key]!);
  });

  test("podman secrets hold the role URLs, the Grafana password and the Valkey URL", () => {
    const env = envOf(h);
    const secret = (n: string) => readFileSync(join(h.dir, "state/secrets", n), "utf8");
    expect(secret("commonair-database-url")).toBe(
      `postgres://commonair_app:${env.POSTGRES_APP_PASSWORD}@postgres:5432/commonair`,
    );
    expect(secret("commonair-owner-database-url")).toBe(
      `postgres://commonair:${env.POSTGRES_PASSWORD}@postgres:5432/commonair`,
    );
    expect(secret("commonair-grafana-admin-password")).toBe(env.GRAFANA_ADMIN_PASSWORD);
    expect(secret("commonair-valkey-url")).toBe(`redis://:${env.VALKEY_PASSWORD}@valkey:6379`);
    expect(h.calls().filter((c) => c.startsWith("podman secret create"))).toEqual([
      "podman secret create --replace commonair-database-url -",
      "podman secret create --replace commonair-owner-database-url -",
      "podman secret create --replace commonair-grafana-admin-password -",
      "podman secret create --replace commonair-valkey-url -",
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
    expect(calls).toContain(
      "systemctl --user enable --now commonair-caddy.socket commonair-irc.socket commonair-ircs.socket commonair-backup.timer commonair-irc-cert.timer",
    );
    expect(calls).toContain("systemctl --user start commonair-irc-cert.service");
  });

  test("Caddy's sockets stop with the stack and start with it; the network is re-created in between", () => {
    const calls = h.calls();
    const at = (s: string) => calls.findIndex((c) => c.startsWith(s));
    const stop = calls.find((c) => c.startsWith("systemctl --user stop commonair-caddy.socket "))!;
    expect(stop).toContain("commonair-caddy.service");
    expect(stop).toContain("commonair-api.service");
    // Quadlet never re-creates an existing network, so its settings (IPRange) would not apply.
    expect(at("systemctl --user stop commonair-network.service")).toBeGreaterThan(at(stop));
    expect(at("podman network rm commonair")).toBeGreaterThan(at("systemctl --user stop commonair-network.service"));
    expect(at("systemctl --user start commonair-migrate.service")).toBeGreaterThan(at("podman network rm commonair"));
    const start = calls.find((c) => c.startsWith("systemctl --user start --no-block"))!;
    expect(start).toContain("commonair-caddy.socket commonair-");
    expect(start).toContain("commonair-caddy.service");
  });

  test("status lists the socket unit too", () => {
    expect(h.run(["status"]).out).toContain("commonair-caddy.socket");
  });

  test("status reports the version, TLS and every unit", () => {
    const s = h.run(["status"]);
    expect(s.code, s.err).toBe(0);
    expect(s.out).toContain("version:   0.1.0");
    expect(s.out).toContain("tls: internal");
    expect(s.out).toContain("commonair-api");
    expect(s.out).toContain("commonair-irc-cert");
  });

  // A real Debian 13 host (rc.1): `su - commonair` has no user manager, and status printed `?`
  // for every unit instead of saying so.
  test.each(["status", "backup", "upgrade"])("%s without a user manager is refused with the fix", (cmd) => {
    const r = h.run(cmd === "upgrade" ? ["upgrade", "--version", "v0.2.0"] : [cmd], { STUB_NO_USER_SYSTEMD: "1" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("units:");
    expect(r.err).toContain("no systemd user manager");
    expect(r.err).toContain("fix:");
  });

  test("backup runs the backup unit and lists the backups", () => {
    const b = h.run(["backup"]);
    expect(b.code, b.err).toBe(0);
    expect(h.calls()).toContain("systemctl --user start commonair-backup.service");
    expect(b.out).toContain("backup-list");
  });
});

describe("stale units", () => {
  test(
    "commonair-* units in ~/.config/systemd/user that the release does not ship are removed",
    () => {
      const h = host();
      const dir = join(h.home, ".config/systemd/user");
      mkdirSync(dir, { recursive: true });
      // From the manual install path (cp infra/systemd/*): shadows Quadlet's irc-cert unit.
      writeFileSync(join(dir, "commonair-irc-cert.service"), "[Service]\nExecStart=%h/.bun/bin/bun sync\n");
      writeFileSync(join(dir, "commonair-old.timer"), "[Timer]\nOnCalendar=daily\n");
      // A rollback to a release without a socket unit: it stops listening and goes.
      writeFileSync(join(dir, "commonair-old.socket"), "[Socket]\nListenStream=80\n");
      writeFileSync(join(dir, "someone-else.service"), "[Service]\n");
      expectOk(h.run(INSTALL));
      expect(readdirSync(dir).sort()).toEqual(
        [...readdirSync(join(ROOT, "infra/systemd")), "someone-else.service"].sort(),
      );
      expect(h.calls()).toContain("systemctl --user disable --now commonair-old.timer");
      expect(h.calls()).toContain("systemctl --user disable --now commonair-old.socket");
      const disable = h.calls().indexOf("systemctl --user disable --now commonair-old.timer");
      expect(disable).toBeLessThan(h.calls().indexOf("systemctl --user daemon-reload"));
    },
    TIMEOUT,
  );

  test(
    "per-unit env files from before are removed; the units render them again at start",
    () => {
      const h = host();
      const dir = join(h.home, ".config/commonair/unit-env");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "commonair-gone.env"), "AUTH_SECRET=old\n");
      expectOk(h.run(INSTALL));
      expect(existsSync(dir)).toBe(false);
      // The units render from the release's renderer and key lists.
      const unit = readFileSync(join(h.home, ".config/containers/systemd/commonair-caddy.container"), "utf8");
      expect(unit).toContain("EnvironmentFile=%h/.config/commonair/unit-env/commonair-caddy.env\n");
      expect(existsSync(join(h.home, "commonair/scripts/selfhost/render-env.sh"))).toBe(true);
      expect(existsSync(join(h.home, "commonair/infra/selfhost/env/commonair-caddy.keys"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("convergence", () => {
  test(
    "a unit left stopped by a failed dependency is started again while waiting for health",
    () => {
      const h = host();
      // The kick has to land within the health wait; 2 s (the fixture's) is too tight under load,
      // and the wait ends as soon as every unit is healthy.
      const r = h.run(INSTALL, { STUB_DEP_FAILED: "commonair-web.service", COMMONAIR_HEALTH_TIMEOUT: "30" });
      expect(r.code, r.err).toBe(0);
      const calls = h.calls();
      const kick = calls.indexOf("systemctl --user start --no-block commonair-web.service");
      expect(kick).toBeGreaterThan(
        calls.findIndex((c) => c.startsWith("systemctl --user start --no-block commonair-")),
      );
      expect(calls[kick - 1]).toBe("systemctl --user reset-failed commonair-web.service");
    },
    TIMEOUT,
  );
});

describe("first IRC certificate", () => {
  test(
    "before DNS points here (no certificate) it gives up after a short bounded wait and the install succeeds",
    () => {
      const h = host();
      // A clock that advances 5 s per reading, so the bound is measured in attempts, not wall time.
      writeFileSync(
        join(h.dir, "stub/date"),
        `#!/bin/sh\nif [ "$1" = +%s ]; then n=$(cat "$STUB_STATE/clock" 2>/dev/null || echo 1000000); n=$((n + 5)); echo "$n" > "$STUB_STATE/clock"; echo "$n"; else exec ${Bun.which("date")} "$@"; fi\n`,
      );
      chmodSync(join(h.dir, "stub/date"), 0o755);
      const r = h.run(INSTALL, { STUB_IRC_CERT_FAIL: "1", COMMONAIR_HEALTH_TIMEOUT: "900" });
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("commonair-irc-cert.timer retries");
      const attempts = h.calls().filter((c) => c === "systemctl --user start commonair-irc-cert.service").length;
      // About 60 s at 5 s per attempt, not the 900 s health timeout (180 attempts).
      expect(attempts).toBeGreaterThan(0);
      expect(attempts).toBeLessThanOrEqual(15);
      expect(r.out).toContain("is running");
    },
    TIMEOUT,
  );
});

describe("applying edits to commonair.env", () => {
  test(
    "the command next steps prints works: install --reinstall reuses the installed release",
    () => {
      const h = host();
      const first = h.run(INSTALL);
      expectOk(first);
      expect(first.out).not.toContain("--yes");
      const printed = /sh (\S+)\/selfhost\.sh (install --reinstall)/.exec(first.out);
      expect(printed?.[1]).toBe(join(h.home, "commonair"));
      const file = join(h.home, ".config/commonair/commonair.env");
      writeFileSync(file, `${readFileSync(file, "utf8")}SMTP_HOST=smtp.example.net\n`);
      const before = envOf(h);
      Bun.spawnSync(["sh", "-c", `: > "${h.log}"`]);

      const r = h.run(printed![2]!.split(" "));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("reusing the installed release 0.1.0");
      expect(h.calls().filter((c) => c.startsWith("curl"))).toEqual([]);
      expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
      const after = envOf(h);
      expect(after.SMTP_HOST).toBe("smtp.example.net");
      for (const key of Object.keys(before).filter((k) => /SECRET|PASSWORD|_KEY|TOKEN/.test(k)))
        expect(after[key], key).toBe(before[key]);
      // The stack was restarted with the edits: migrate, then the services.
      expect(h.calls()).toContain("systemctl --user start commonair-migrate.service");
      expect(h.calls().some((c) => c.startsWith("systemctl --user start --no-block"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a first install still has to say which release",
    () => {
      const h = host();
      const r = h.run(["install", "--reinstall", "--domain", "stream.example.org", "--email", "ops@example.org"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("say which release");
    },
    TIMEOUT,
  );
});

describe("shellcheck", () => {
  // Skips only on a developer machine with neither; in CI the test runs and fails instead.
  test.skipIf(!shellcheckAvailable && process.env.CI !== "true")(
    "selfhost.sh is clean (POSIX sh)",
    () => {
      const r = shellcheck(SCRIPT);
      expect(r.code, r.out).toBe(0);
    },
    300_000,
  );
});
