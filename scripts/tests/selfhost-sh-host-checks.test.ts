// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). The host checks before anything is installed. */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { TIMEOUT, host, INSTALL, expectOk, useReleases } from "./support/selfhost-host.ts";

useReleases();

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
    "an unsynchronized clock warns and never blocks; an unanswerable one says it could not check",
    () => {
      const doc = "docs/self-hosting/requirements.md#time-synchronization";
      const synced = host().run(INSTALL);
      expectOk(synced);
      expect(synced.err).not.toContain("NTP-synchronized");

      const off = host();
      const r = off.run(INSTALL, { STUB_NTP: "no" });
      expectOk(r);
      expect(r.err).toContain("WARNING: the host clock is not NTP-synchronized");
      expect(r.err).toContain(doc);
      expect(off.calls()).toContain("timedatectl show -p NTPSynchronized --value");

      const empty = host().run(INSTALL, { STUB_NTP: "" });
      expectOk(empty);
      expect(empty.err).toContain("WARNING: could not check that the host clock is NTP-synchronized");
      expect(empty.err).not.toContain("not NTP-synchronized");

      const missing = host();
      rmSync(join(missing.dir, "stub/timedatectl"));
      const m = missing.run(INSTALL);
      expectOk(m);
      expect(m.err).toContain("could not check that the host clock is NTP-synchronized");
      expect(m.err).toContain(doc);
    },
    TIMEOUT * 2,
  );

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

  test("podman that cannot set up its user namespace is reported as such, not as too old", () => {
    const r = host().run(INSTALL, {
      STUB_PODMAN_BROKEN:
        'Error: cannot set up namespace using "/usr/bin/newuidmap": should have setuid or have filecaps setuid: exit status 1',
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("newuidmap/newgidmap cannot set up the user namespace");
    expect(r.err).toContain("dnf reinstall shadow-utils");
    expect(r.err).not.toContain("too old");
  });

  test("any other podman failure is shown with its own message", () => {
    const r = host().run(INSTALL, { STUB_PODMAN_BROKEN: "Error: database is locked" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Error: database is locked");
    expect(r.err).not.toContain("too old");
  });

  test.each([
    ["usr/libexec/podman/aardvark-dns", "aardvark-dns is missing", "apt install aardvark-dns"],
    ["usr/sbin/nft", "nft is missing", "apt install nftables"],
  ])("%s missing", (helper, message, fix) => {
    const h = host();
    Bun.spawnSync(["rm", join(h.env.COMMONAIR_SYSROOT!, helper)]);
    const r = h.run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(r.err).toContain(fix);
  });

  test(
    "aardvark-dns where Debian puts it counts",
    () => {
      const h = host();
      const sys = h.env.COMMONAIR_SYSROOT!;
      Bun.spawnSync(["rm", join(sys, "usr/libexec/podman/aardvark-dns")]);
      mkdirSync(join(sys, "usr/lib/podman"), { recursive: true });
      writeFileSync(join(sys, "usr/lib/podman/aardvark-dns"), "");
      chmodSync(join(sys, "usr/lib/podman/aardvark-dns"), 0o755);
      expect(h.run(INSTALL).err).not.toContain("aardvark-dns is missing");
      // A whole install: past the default 5 s when the suite runs in parallel.
    },
    TIMEOUT,
  );

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

  test.each(["status", "backup", "upgrade"])("%s as root points at the service user", (cmd) => {
    const h = host();
    writeFileSync(
      join(h.dir, "stub/id"),
      '#!/bin/sh\n[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }\necho root\n',
    );
    chmodSync(join(h.dir, "stub/id"), 0o755);
    const r = h.run(cmd === "upgrade" ? ["upgrade", "--version", "v0.2.0"] : [cmd]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${cmd} runs as the user that owns the instance, not as root`);
    expect(r.err).toContain("log in as commonair over SSH");
    expect(r.err).toContain(`sh ~/commonair/selfhost.sh ${cmd}`);
    expect(h.calls()).toEqual([]);
  });
});
