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
 * dropped unit goes. While staging seed mode is open it refuses (it would drop the close timer);
 * closed, it removes a seed-mode drop-in left behind (ADR 0040).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { OPTIONAL_BUNDLE_DIR, OPTIONAL_UNITS } from "../../scripts/selfhost/units.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SELFHOST = readFileSync(join(ROOT, "scripts/selfhost.sh"), "utf8");

/** One shell function's text: a one-liner, or `name() {` to the closing brace at column 0. */
function shFunction(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{(?: .*\\}|\\n[\\s\\S]*?^\\})\\n`, "m").exec(SELFHOST);
  if (!m) throw new Error(`no function ${name} in scripts/selfhost.sh`);
  return m[0];
}
const FUNCTIONS = [
  "say",
  "die",
  "info",
  "env_get",
  "captions_on",
  "seed_mode_open",
  "unit_in_mode",
  "release_unit_path",
  "install_units",
  "stop_orphan_units",
]
  .map(shFunction)
  .join("");

interface Host {
  home: string;
  quadlet: string;
  systemd: string;
  seedState: string;
  calls: () => string[];
  install: (release: string) => void;
  run: (release: string) => { code: number; err: string };
}

function host(): Host {
  const home = mkdtempSync(join(tmpdir(), "commonair-dropins-"));
  const bin = join(home, "stub-bin");
  const log = join(home, "systemctl.log");
  mkdirSync(bin);
  writeFileSync(join(home, "commonair.env"), "WHISPER_URL=http://whisper:8080\n");
  // list-units prints $HOME/list-units (what systemd still runs), when a test wrote one.
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\necho "systemctl $*" >> "${log}"\n` +
      `if [ "$2" = list-units ] && [ -f "$HOME/list-units" ]; then cat "$HOME/list-units"; fi\n`,
    { mode: 0o755 },
  );
  const quadlet = join(home, ".config/containers/systemd");
  const systemd = join(home, ".config/systemd/user");
  const script =
    "set -eu\n" +
    `QUADLET_DIR='${quadlet}'\nSYSTEMD_DIR='${systemd}'\nUNIT_ENV_DIR='${home}/.config/commonair/unit-env'\n` +
    "STORAGE_MODE=garage\nOPTIONAL_UNIT_DIR=quadlet-optional\n" +
    // Captions on (env file below), so every unit of the release but seed mode's is installed.
    `ENV_FILE='${home}/commonair.env'\nWHISPER_INTERNAL_URL=http://whisper:8080\nSEED_STATE='${home}/seed-mode'\n` +
    "SEED_DROPIN=50-seed-mode.conf\n" +
    FUNCTIONS +
    'install_units "$1"\n';
  const run = (release: string) => {
    const r = Bun.spawnSync(["sh", "-c", script, "sh", release], {
      env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  return {
    home,
    quadlet,
    systemd,
    seedState: join(home, "seed-mode"),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    run,
    install: (release) => {
      const r = run(release);
      expect(r.code, r.err).toBe(0);
    },
  };
}

/** The bundle's directory for a unit file (bundle.ts): the optional ones apart. */
const unitDir = (f: string) => ((OPTIONAL_UNITS as readonly string[]).includes(f) ? OPTIONAL_BUNDLE_DIR : "quadlet");

/** A release directory as the bundle lays it out: quadlet/, quadlet-optional/ and systemd/, without `drop`. */
function release(parent: string, name: string, drop: string[] = []): string {
  const dir = join(parent, name);
  cpSync(join(ROOT, "infra/quadlet"), join(dir, "quadlet"), { recursive: true });
  mkdirSync(join(dir, OPTIONAL_BUNDLE_DIR));
  for (const f of OPTIONAL_UNITS) renameSync(join(dir, "quadlet", f), join(dir, OPTIONAL_BUNDLE_DIR, f));
  cpSync(join(ROOT, "infra/systemd"), join(dir, "systemd"), { recursive: true });
  for (const f of drop) rmSync(join(dir, f.endsWith(".container") ? unitDir(f) : "systemd", f));
  return dir;
}

const files = (dir: string) => readdirSync(dir).sort();
/** Staging seed mode's units, installed only by seed-mode open. */
const SEED_UNITS = [
  "commonair-stripe-mock.container",
  "commonair-mailpit.container",
  "commonair-seed-harness.container",
];
/** The release's container units an install puts in place (seed mode closed). */
const installed = (rel: string) =>
  [...files(join(rel, "quadlet")), ...files(join(rel, OPTIONAL_BUNDLE_DIR))]
    .filter((f) => !SEED_UNITS.includes(f))
    .sort();
const GPU = "[Container]\nAddDevice=/dev/dri/renderD128\n";
const BACKUP = "[Service]\nEnvironment=WALG_DELTA_MAX_STEPS=3\n";

// Each test runs selfhost.sh install_units in a shell, several times; slow under the gate's load.
const TIMEOUT = 60_000;

describe("install_units keeps operator drop-ins", () => {
  test(
    "install, then an upgrade that drops a unit: the drop-ins stay, the dropped unit goes",
    () => {
      const h = host();
      const v1 = release(h.home, "v1");
      h.install(v1);
      expect(files(h.quadlet)).toEqual(installed(v1));
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
      expect(files(h.quadlet)).toEqual([...installed(v2), "commonair-media.container.d"].sort());
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
    },
    TIMEOUT,
  );

  test(
    "a drop-in directory that is a symlink (kept elsewhere, e.g. by config management) stays",
    () => {
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
    },
    TIMEOUT,
  );

  test(
    "a dangling drop-in symlink (its target was removed) is cleaned up",
    () => {
      const h = host();
      const v1 = release(h.home, "v1");
      h.install(v1);
      const gone = join(h.home, "gone");
      symlinkSync(gone, join(h.quadlet, "commonair-media.container.d"));
      symlinkSync(gone, join(h.systemd, "commonair-backup.service.d"));
      h.install(v1);
      expect(files(h.quadlet)).toEqual(installed(v1));
      expect(files(h.systemd)).toEqual(files(join(v1, "systemd")));
    },
    TIMEOUT,
  );

  test(
    "a symlinked unit file (not a drop-in) is still replaced by the release's copy",
    () => {
      const h = host();
      const elsewhere = join(h.home, "hand-made.container");
      writeFileSync(elsewhere, "[Container]\nImage=example.org/x:1\n");
      mkdirSync(h.quadlet, { recursive: true });
      symlinkSync(elsewhere, join(h.quadlet, "commonair-media.container"));
      symlinkSync(elsewhere, join(h.quadlet, "commonair-old.container"));
      const v1 = release(h.home, "v1");
      h.install(v1);
      expect(files(h.quadlet)).toEqual(installed(v1));
      expect(readFileSync(join(h.quadlet, "commonair-media.container"), "utf8")).toBe(
        readFileSync(join(v1, "quadlet/commonair-media.container"), "utf8"),
      );
      // The hand-made file the links pointed at is left alone.
      expect(existsSync(elsewhere)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("install_units after an older selfhost.sh", () => {
  test(
    "services still running without a unit file (an rc.2 script's rollback from rc.3) are stopped",
    () => {
      const h = host();
      // systemctl list-units --all --plain --no-legend, as systemd 257 printed it on staging.
      writeFileSync(
        join(h.home, "list-units"),
        [
          "commonair-api.service                    loaded    active   running CommonAir api",
          "commonair-mailpit.service                not-found active   running commonair-mailpit.service",
          "commonair-seed-harness.service           not-found active   running commonair-seed-harness.service",
          "commonair-storage-init.service           not-found active   exited  commonair-storage-init.service",
          "● commonair-whisper.service              not-found failed   failed  commonair-whisper.service",
          "commonair-old.service                    not-found inactive dead    commonair-old.service",
        ].join("\n") + "\n",
      );
      const r = h.run(release(h.home, "v1"));
      expect(r.code, r.err).toBe(0);
      const stops = h.calls().filter((c) => c.startsWith("systemctl --user stop "));
      expect(stops).toEqual([
        "systemctl --user stop commonair-mailpit.service",
        "systemctl --user stop commonair-seed-harness.service",
        "systemctl --user stop commonair-storage-init.service",
        "systemctl --user stop commonair-whisper.service",
      ]);
      // After the reload, so systemd no longer has the files that were removed.
      const calls = h.calls();
      expect(calls.indexOf("systemctl --user daemon-reload")).toBeLessThan(
        calls.indexOf("systemctl --user stop commonair-mailpit.service"),
      );
    },
    TIMEOUT,
  );

  test(
    "the optional units come from quadlet-optional/; an older release with them in quadlet/ works too",
    () => {
      const h = host();
      const rel = release(h.home, "v1");
      h.install(rel);
      // Captions on (the host's env file): whisper is installed, seed mode's units are not.
      expect(existsSync(join(h.quadlet, "commonair-whisper.container"))).toBe(true);
      for (const f of SEED_UNITS) expect(existsSync(join(h.quadlet, f)), f).toBe(false);

      // rc.3's layout (everything in quadlet/), e.g. a rollback to it.
      const old = join(h.home, "old");
      cpSync(join(ROOT, "infra/quadlet"), join(old, "quadlet"), { recursive: true });
      cpSync(join(ROOT, "infra/systemd"), join(old, "systemd"), { recursive: true });
      h.install(old);
      expect(existsSync(join(h.quadlet, "commonair-whisper.container"))).toBe(true);
      for (const f of SEED_UNITS) expect(existsSync(join(h.quadlet, f)), f).toBe(false);
    },
    TIMEOUT,
  );
});

describe("install_units and staging seed mode", () => {
  test(
    "refuses while seed mode is open, changing nothing (its close timer would go)",
    () => {
      const h = host();
      const v1 = release(h.home, "v1");
      h.install(v1);
      const timer = join(h.systemd, "commonair-seed-mode-close.timer");
      writeFileSync(timer, "[Timer]\n");
      writeFileSync(h.seedState, "DEADLINE=0\n");
      const before = files(h.systemd);
      writeFileSync(join(h.home, "systemctl.log"), "");
      const r = h.run(v1);
      expect(r.code).toBe(1);
      expect(r.err).toContain("install_units refused: staging seed mode is open");
      expect(r.err).toContain("seed-mode close");
      expect(files(h.systemd)).toEqual(before);
      expect(existsSync(timer)).toBe(true);
      expect(h.calls().filter((c) => c !== "")).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "closed, a seed-mode drop-in left behind goes; an operator's drop-in next to it stays",
    () => {
      const h = host();
      const v1 = release(h.home, "v1");
      h.install(v1);
      const api = join(h.quadlet, "commonair-api.container.d");
      const media = join(h.quadlet, "commonair-media.container.d");
      mkdirSync(api);
      mkdirSync(media);
      writeFileSync(join(api, "50-seed-mode.conf"), "[Container]\nEnvironment=TRUSTED_PROXY_CIDRS=10.89.42.12/32\n");
      writeFileSync(join(media, "50-seed-mode.conf"), "[Container]\n");
      writeFileSync(join(media, "gpu.conf"), GPU);
      h.install(v1);
      expect(existsSync(api)).toBe(false);
      expect(files(media)).toEqual(["gpu.conf"]);
      expect(files(h.quadlet)).toEqual([...installed(v1), "commonair-media.container.d"].sort());
    },
    TIMEOUT,
  );
});
