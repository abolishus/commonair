// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Operator drop-ins survive install and upgrade. The supported way to customise a unit is a
 * drop-in directory next to it: ~/.config/containers/systemd/commonair-<unit>.container.d/*.conf
 * for a container unit (Quadlet merges it, e.g. a GPU device for media), and
 * ~/.config/systemd/user/commonair-<unit>.<type>.d/*.conf for the timer, socket and backup units.
 * install_units in scripts/selfhost.sh replaces every unit file on each install and upgrade; these
 * tests run that real function (cut out of the script, with systemctl stubbed) twice, as an install
 * and an upgrade to a release that dropped a unit, and check that the drop-ins stay and only the
 * dropped unit goes.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const SELFHOST = readFileSync(join(ROOT, "scripts/selfhost.sh"), "utf8");

/** One shell function's text: a one-liner, or `name() {` to the closing brace at column 0. */
function shFunction(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{(?: .*\\}|\\n[\\s\\S]*?^\\})\\n`, "m").exec(SELFHOST);
  if (!m) throw new Error(`no function ${name} in scripts/selfhost.sh`);
  return m[0];
}
const FUNCTIONS = ["info", "unit_in_mode", "install_units"].map(shFunction).join("");

interface Host {
  home: string;
  quadlet: string;
  systemd: string;
  calls: () => string[];
  install: (release: string) => void;
}

function host(): Host {
  const home = mkdtempSync(join(tmpdir(), "commonair-dropins-"));
  const bin = join(home, "stub-bin");
  const log = join(home, "systemctl.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n`, { mode: 0o755 });
  const quadlet = join(home, ".config/containers/systemd");
  const systemd = join(home, ".config/systemd/user");
  const script =
    "set -eu\n" +
    `QUADLET_DIR='${quadlet}'\nSYSTEMD_DIR='${systemd}'\nUNIT_ENV_DIR='${home}/.config/commonair/unit-env'\n` +
    "STORAGE_MODE=garage\n" +
    FUNCTIONS +
    'install_units "$1"\n';
  return {
    home,
    quadlet,
    systemd,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    install: (release) => {
      const r = Bun.spawnSync(["sh", "-c", script, "sh", release], {
        env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode, r.stderr.toString()).toBe(0);
    },
  };
}

/** A release directory as the bundle lays it out: quadlet/ and systemd/, without `drop`. */
function release(parent: string, name: string, drop: string[] = []): string {
  const dir = join(parent, name);
  cpSync(join(ROOT, "infra/quadlet"), join(dir, "quadlet"), { recursive: true });
  cpSync(join(ROOT, "infra/systemd"), join(dir, "systemd"), { recursive: true });
  for (const f of drop) rmSync(join(dir, f.endsWith(".container") ? "quadlet" : "systemd", f));
  return dir;
}

const files = (dir: string) => readdirSync(dir).sort();
const GPU = "[Container]\nAddDevice=/dev/dri/renderD128\n";
const BACKUP = "[Service]\nEnvironment=WALG_DELTA_MAX_STEPS=3\n";

describe("install_units keeps operator drop-ins", () => {
  test("install, then an upgrade that drops a unit: the drop-ins stay, the dropped unit goes", () => {
    const h = host();
    const v1 = release(h.home, "v1");
    h.install(v1);
    expect(files(h.quadlet)).toEqual(files(join(v1, "quadlet")));
    expect(files(h.systemd)).toEqual(files(join(v1, "systemd")));

    // The operator's customisations, after the install.
    const gpu = join(h.quadlet, "commonair-media.container.d");
    const backup = join(h.systemd, "commonair-backup.service.d");
    mkdirSync(gpu);
    writeFileSync(join(gpu, "gpu.conf"), GPU);
    mkdirSync(backup);
    writeFileSync(join(backup, "override.conf"), BACKUP);

    const v2 = release(h.home, "v2", ["commonair-tracker.container", "commonair-irc-cert.timer"]);
    h.install(v2);
    expect(readFileSync(join(gpu, "gpu.conf"), "utf8")).toBe(GPU);
    expect(readFileSync(join(backup, "override.conf"), "utf8")).toBe(BACKUP);
    // Exactly the new release's units plus the drop-ins: the dropped ones are gone.
    expect(files(h.quadlet)).toEqual([...files(join(v2, "quadlet")), "commonair-media.container.d"].sort());
    expect(files(h.systemd)).toEqual([...files(join(v2, "systemd")), "commonair-backup.service.d"].sort());
    expect(existsSync(join(h.quadlet, "commonair-tracker.container"))).toBe(false);
    expect(existsSync(join(h.systemd, "commonair-irc-cert.timer"))).toBe(false);
    // The dropped units were stopped (and the timer disabled) while systemd still knew them.
    expect(h.calls()).toContain("systemctl --user stop commonair-tracker.service");
    expect(h.calls()).toContain("systemctl --user disable --now commonair-irc-cert.timer");
    expect(h.calls().filter((c) => c.includes("media") || c.includes("backup"))).toEqual([]);
    // Unit files are the release's own, never merged with a drop-in.
    expect(readFileSync(join(h.quadlet, "commonair-media.container"), "utf8")).toBe(
      readFileSync(join(v2, "quadlet/commonair-media.container"), "utf8"),
    );

    // Upgrading again (or rolling back to v1) keeps them as well.
    h.install(v1);
    expect(readFileSync(join(gpu, "gpu.conf"), "utf8")).toBe(GPU);
    expect(readFileSync(join(backup, "override.conf"), "utf8")).toBe(BACKUP);
    expect(existsSync(join(h.quadlet, "commonair-tracker.container"))).toBe(true);
  });

  test("a drop-in directory that is a symlink (kept elsewhere, e.g. by config management) stays", () => {
    const h = host();
    const v1 = release(h.home, "v1");
    h.install(v1);
    const managed = join(h.home, "managed");
    mkdirSync(join(managed, "media"), { recursive: true });
    mkdirSync(join(managed, "backup"), { recursive: true });
    writeFileSync(join(managed, "media/gpu.conf"), GPU);
    writeFileSync(join(managed, "backup/override.conf"), BACKUP);
    symlinkSync(join(managed, "media"), join(h.quadlet, "commonair-media.container.d"));
    symlinkSync(join(managed, "backup"), join(h.systemd, "commonair-backup.service.d"));

    h.install(release(h.home, "v2", ["commonair-tracker.container"]));
    expect(readFileSync(join(h.quadlet, "commonair-media.container.d/gpu.conf"), "utf8")).toBe(GPU);
    expect(readFileSync(join(h.systemd, "commonair-backup.service.d/override.conf"), "utf8")).toBe(BACKUP);
    expect(existsSync(join(h.quadlet, "commonair-tracker.container"))).toBe(false);
  });

  test("a symlinked unit file (not a drop-in) is still replaced by the release's copy", () => {
    const h = host();
    const elsewhere = join(h.home, "hand-made.container");
    writeFileSync(elsewhere, "[Container]\nImage=example.org/x:1\n");
    mkdirSync(h.quadlet, { recursive: true });
    symlinkSync(elsewhere, join(h.quadlet, "commonair-media.container"));
    symlinkSync(elsewhere, join(h.quadlet, "commonair-old.container"));
    const v1 = release(h.home, "v1");
    h.install(v1);
    expect(files(h.quadlet)).toEqual(files(join(v1, "quadlet")));
    expect(readFileSync(join(h.quadlet, "commonair-media.container"), "utf8")).toBe(
      readFileSync(join(v1, "quadlet/commonair-media.container"), "utf8"),
    );
    // The hand-made file the links pointed at is left alone.
    expect(existsSync(elsewhere)).toBe(true);
  });
});
