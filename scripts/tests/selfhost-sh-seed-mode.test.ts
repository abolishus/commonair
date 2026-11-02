// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). `seed-mode`: staging seed mode
 * (ADR 0040). Every refusal changes nothing; open writes exactly its block and the saved values;
 * close restores exactly those and keeps the features that stay on; close is idempotent; the timer
 * closes it within 6 hours; upgrade and reinstall refuse while it is open; status shows it.
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { type Host, TIMEOUT, envOf, expectOk, host, INSTALL, useReleases } from "./support/selfhost-host.ts";

useReleases();

const HOSTNAME = "stream.example.org";
const BEGIN =
  "# >>> staging seed mode: selfhost.sh seed-mode close removes this block and restores the values it replaced >>>";
const END = "# <<< staging seed mode <<<";
const SEED_UNITS = [
  "commonair-stripe-mock.container",
  "commonair-mailpit.container",
  "commonair-seed-harness.container",
];
const DROPIN_UNITS = ["api", "worker", "media"];
const KEEP_ON = { GIVEAWAYS_ENABLED: "true", CHAT_WATCH_GATE: "on", CHAT_SURGE_GUARD: "on", WEB_PUSH_ENABLED: "true" };
/** The block's keys, in the order selfhost.sh writes them. */
const BLOCK_KEYS = [
  "COOP_TEST_HOOKS",
  "INTERACT_TEST_HOOKS",
  "MODERATION_TEST_HOOKS",
  "OPS_TEST_HOOKS",
  "MODERATION_CLASSIFIER",
  "MODERATION_SAMPLE_SECONDS",
  "OUTBOUND_ALLOW_PRIVATE_NETWORKS",
  "EVENTSUB_ALLOW_INSECURE_CALLBACKS",
  "WEB_PUSH_ALLOW_INSECURE_ENDPOINTS",
  "FEDERATION_ENABLED",
  "TWITCH_IMPORT_ENABLED",
  "OAUTH_TWITCH_CLIENT_ID",
  "OAUTH_TWITCH_CLIENT_SECRET",
  "TWITCH_API_BASE_URL",
  "TWITCH_AUTH_BASE_URL",
  "TWITCH_IMAGE_HOSTS",
  "PAYMENTS_PROVIDER",
  "STRIPE_SECRET_KEY",
  "STRIPE_API_BASE",
  "STRIPE_WEBHOOK_SECRET",
  "INFRA_COST_MODEL",
  "GOVERNANCE_BOOTSTRAP_JSON",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_REQUIRE_TLS",
  "SMTP_USER",
  "SMTP_PASSWORD",
];

const envPath = (h: Host) => join(h.home, ".config/commonair/commonair.env");
const statePath = (h: Host) => join(h.home, ".local/state/commonair/seed-mode");
const quadlet = (h: Host) => join(h.home, ".config/containers/systemd");
const systemdDir = (h: Host) => join(h.home, ".config/systemd/user");
const timerPath = (h: Host) => join(systemdDir(h), "commonair-seed-mode-close.timer");
const lockPath = (h: Host) => join(h.home, ".local/state/commonair/seed-mode.lock");
const harnessEnv = (h: Host) => join(h.home, ".config/commonair/unit-env/commonair-seed-harness.env");

/** Sets (string) or removes (null) lines of commonair.env. */
function editEnv(h: Host, edits: Record<string, string | null>): void {
  let text = readFileSync(envPath(h), "utf8");
  for (const [k, v] of Object.entries(edits)) {
    text = text.replace(new RegExp(`^${k}=.*\\n`, "gm"), "");
    if (v !== null) text += `${k}=${v}\n`;
  }
  writeFileSync(envPath(h), text);
}

/**
 * An installed staging instance: DEMO_SEED_FULL as given, captions on, real-looking SMTP and
 * Stripe settings (which seed mode must restore), and TWITCH_IMAGE_HOSTS absent (it must stay
 * absent after close). The call log starts empty.
 */
function staging(opts: { flag?: string | null; captions?: boolean } = {}): Host {
  const h = host();
  // Captions are on, so an upgrade on an x86_64 runner reads the CPU's flags (check_captions).
  mkdirSync(join(h.dir, "sys/proc"), { recursive: true });
  writeFileSync(join(h.dir, "sys/proc/cpuinfo"), "processor\t: 0\nflags\t\t: sse4_2 avx f16c fma avx2\n");
  expectOk(h.run(INSTALL));
  editEnv(h, {
    DEMO_SEED_FULL: opts.flag === undefined ? "true" : opts.flag,
    WHISPER_URL: opts.captions === false ? "" : "http://whisper:8080",
    SMTP_HOST: "smtp.example.org",
    SMTP_PORT: "587",
    SMTP_USER: "relay-user",
    SMTP_PASSWORD: "real-smtp-password",
    SMTP_REQUIRE_TLS: "true",
    STRIPE_WEBHOOK_SECRET: "whsec_the_real_one",
    INFRA_COST_MODEL: '{"currency":"usd","centsPerGb":{"origin":2,"relay":1,"p2p":0,"cdn":3}}',
    CHAT_SURGE_GUARD: "off",
    TWITCH_IMAGE_HOSTS: null,
  });
  writeFileSync(h.log, "");
  return h;
}

/** Calls other than check_systemd's read-only probes. */
const changes = (h: Host) =>
  h.calls().filter((c) => c !== "" && c !== "systemctl --version" && c !== "systemctl --user show-environment");

const open = (h: Host, extra: string[] = [], env: Record<string, string> = {}) =>
  h.run(["seed-mode", "open", "--confirm", HOSTNAME, ...extra], env);

/** The lines between the markers, or null without a block. */
function block(h: Host): string[] | null {
  const lines = readFileSync(envPath(h), "utf8").split("\n");
  const a = lines.indexOf(BEGIN);
  if (a === -1) return null;
  return lines.slice(a + 1, lines.indexOf(END));
}

const rmLock = (h: Host) => rmSync(lockPath(h), { force: true });

const outside = (h: Host) => {
  const lines = readFileSync(envPath(h), "utf8").split("\n");
  const a = lines.indexOf(BEGIN);
  return a === -1 ? lines : [...lines.slice(0, a), ...lines.slice(lines.indexOf(END) + 1)];
};

describe("seed-mode open refuses, touching nothing", () => {
  test.each([
    ["DEMO_SEED_FULL=false", { flag: "false" }, ["--confirm", HOSTNAME], "DEMO_SEED_FULL is false"],
    ["DEMO_SEED_FULL unset", { flag: null }, ["--confirm", HOSTNAME], "DEMO_SEED_FULL is unset"],
    ["no --confirm", {}, [], `pass --confirm ${HOSTNAME}`],
    ["a wrong --confirm", {}, ["--confirm", "prod.example.org"], `is not this instance (${HOSTNAME})`],
    ["captions off", { captions: false }, ["--confirm", HOSTNAME], "live captions are off"],
    ["--hours 7 (longer than 6)", {}, ["--confirm", HOSTNAME, "--hours", "7"], "longer than seed mode may stay open"],
    ["--hours 0", {}, ["--confirm", HOSTNAME, "--hours", "0"], "from 1 to 6"],
    ["--hours 2.5", {}, ["--confirm", HOSTNAME, "--hours", "2.5"], "from 1 to 6"],
    ["an unknown option", {}, ["--confirm", HOSTNAME, "--forever"], "unknown seed-mode option: --forever"],
  ] as const)(
    "%s",
    (_, opts, args, message) => {
      const h = staging(opts);
      const before = readFileSync(envPath(h), "utf8");
      const r = h.run(["seed-mode", "open", ...args]);
      expect(r.code, r.err).toBe(1);
      expect(r.err).toContain(message);
      expect(changes(h)).toEqual([]);
      expect(readFileSync(envPath(h), "utf8")).toBe(before);
      expect(existsSync(statePath(h))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "while seed mode is already open",
    () => {
      const h = staging();
      expectOk(open(h));
      const before = readFileSync(envPath(h), "utf8");
      const state = readFileSync(statePath(h), "utf8");
      writeFileSync(h.log, "");
      const r = open(h);
      expect(r.code).toBe(1);
      expect(r.err).toContain("seed mode is already open, until");
      expect(changes(h)).toEqual([]);
      expect(readFileSync(envPath(h), "utf8")).toBe(before);
      expect(readFileSync(statePath(h), "utf8")).toBe(state);
    },
    TIMEOUT,
  );

  test(
    "with a seed-mode block left in commonair.env but no state",
    () => {
      const h = staging();
      writeFileSync(envPath(h), `${readFileSync(envPath(h), "utf8")}${BEGIN}\nOPS_TEST_HOOKS=true\n${END}\n`);
      const r = open(h);
      expect(r.code).toBe(1);
      expect(r.err).toContain("has a seed-mode block but seed mode is not open");
      expect(changes(h)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "when the close timer does not arm: nothing would close it",
    () => {
      const h = staging();
      const before = readFileSync(envPath(h), "utf8");
      const r = open(h, [], { STUB_SEED_TIMER_FAIL: "1" });
      expect(r.code, r.err).toBe(1);
      expect(r.err).toContain("could not arm commonair-seed-mode-close.timer");
      expect(r.err).toContain("Nothing was changed.");
      expect(readFileSync(envPath(h), "utf8")).toBe(before);
      expect(existsSync(statePath(h))).toBe(false);
      for (const u of SEED_UNITS) expect(existsSync(join(quadlet(h), u)), u).toBe(false);
      for (const u of [...DROPIN_UNITS, "seed-harness"])
        expect(existsSync(join(quadlet(h), `commonair-${u}.container.d`)), u).toBe(false);
      expect(readdirSync(systemdDir(h)).filter((f) => f.startsWith("commonair-seed-mode"))).toEqual([]);
      expect(h.calls().filter((c) => /systemctl --user (start|restart) /.test(c))).toEqual([]);
      expect(existsSync(lockPath(h))).toBe(false);
      // Nothing left to close, and the next open goes ahead.
      expect(h.run(["seed-mode", "close"]).out).toContain("nothing to close");
      expectOk(open(h));
    },
    TIMEOUT,
  );

  test("before any install", () => {
    const h = host();
    const r = h.run(["seed-mode", "open", "--confirm", HOSTNAME]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no instance installed here");
    expect(h.calls()).toEqual([]);
  });

  test("seed-mode without a subcommand, or an unknown one", () => {
    const h = host();
    expect(h.run(["seed-mode"]).err).toContain("seed-mode needs a subcommand");
    expect(h.run(["seed-mode", "wipe"]).err).toContain("unknown seed-mode subcommand: wipe");
    expect(h.calls()).toEqual([]);
  });
});

describe("seed-mode open", () => {
  test(
    "saves exactly the values it replaces, writes exactly the block, keeps secrets off argv",
    () => {
      const h = staging();
      const before = envOf(h);
      const r = open(h);
      expectOk(r);

      // The saved state: the deadline, and PREV_ for each block key that was present (absent stays absent).
      const state = readFileSync(statePath(h), "utf8");
      expect(statSync(statePath(h)).mode & 0o777).toBe(0o600);
      const prev = Object.fromEntries(
        state
          .split("\n")
          .filter((l) => l.startsWith("PREV_"))
          .map((l) => [l.slice(5, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      const present = BLOCK_KEYS.filter((k) => k in before);
      expect(Object.keys(prev).sort()).toEqual(present.sort());
      for (const k of present) expect(prev[k], k).toBe(before[k]);
      expect(prev.TWITCH_IMAGE_HOSTS).toBeUndefined();
      expect(prev.SMTP_PASSWORD).toBe("real-smtp-password");
      expect(prev.STRIPE_WEBHOOK_SECRET).toBe("whsec_the_real_one");

      // The block: exactly its keys, in order, and none of them left outside it.
      const lines = block(h)!;
      expect(lines.map((l) => l.slice(0, l.indexOf("=")))).toEqual(BLOCK_KEYS);
      const blockEnv = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      expect(blockEnv).toMatchObject({
        MODERATION_TEST_HOOKS: "true",
        OPS_TEST_HOOKS: "true",
        PAYMENTS_PROVIDER: "stripe",
        STRIPE_API_BASE: "http://stripe-mock:12111",
        SMTP_HOST: "mailpit",
        SMTP_PORT: "1025",
        SMTP_PASSWORD: "",
        TWITCH_API_BASE_URL: "http://seed-harness:4791/helix",
        FEDERATION_ENABLED: "true",
      });
      // A fresh webhook secret for the run, never the instance's real one.
      expect(blockEnv.STRIPE_WEBHOOK_SECRET).toMatch(/^whsec_[0-9a-f]{64}$/);
      const out = outside(h);
      for (const k of BLOCK_KEYS)
        expect(
          out.filter((l) => l.startsWith(`${k}=`)),
          k,
        ).toEqual([]);
      // Outside the block: what was there, minus the block's keys, with the features turned on.
      const after = envOf(h);
      for (const [k, v] of Object.entries(before)) {
        if (BLOCK_KEYS.includes(k)) continue;
        expect(after[k], k).toBe(k in KEEP_ON ? KEEP_ON[k as keyof typeof KEEP_ON] : v);
      }
      for (const [k, v] of Object.entries(KEEP_ON)) expect(after[k], k).toBe(v);
      expect(statSync(envPath(h)).mode & 0o777).toBe(0o600);
      // No value of a secret on any command line the script ran.
      const argv = h.calls().join("\n");
      for (const secret of ["real-smtp-password", "whsec_the_real_one", blockEnv.STRIPE_WEBHOOK_SECRET!])
        expect(argv).not.toContain(secret);

      // Units, drop-ins and the harness's own drop-in.
      for (const u of SEED_UNITS) expect(existsSync(join(quadlet(h), u)), u).toBe(true);
      for (const u of DROPIN_UNITS) {
        const got = readFileSync(join(quadlet(h), `commonair-${u}.container.d/50-seed-mode.conf`), "utf8");
        expect(got).toBe(readFileSync(join(h.home, `commonair/infra/selfhost/seed-mode/commonair-${u}.conf`), "utf8"));
        expect(got).toContain("Environment=MODERATION_HASHLIST_CSAM=/fixtures/moderation/csam.pdq");
      }
      expect(readFileSync(join(quadlet(h), "commonair-api.container.d/50-seed-mode.conf"), "utf8")).toContain(
        "Environment=TRUSTED_PROXY_CIDRS=10.89.42.10/32,10.89.42.11/32,10.89.42.12/32\n",
      );
      // The synthetic hash lists the drop-ins mount ship with the release.
      for (const f of ["csam.pdq", "ncii.pdq"])
        expect(existsSync(join(h.home, `commonair/packages/moderation/fixtures/${f}`)), f).toBe(true);
      const harness = readFileSync(join(quadlet(h), "commonair-seed-harness.container.d/50-seed-mode.conf"), "utf8");
      expect(harness).toContain(`AddHost=${HOSTNAME}:host-gateway\n`);
      expect(harness).toContain(`Environment=HARNESS_WEB_URL=https://${HOSTNAME}\n`);
      expect(existsSync(join(h.home, ".local/share/commonair/seed-mode/reports"))).toBe(true);

      // Pulled before anything changed; the timer armed; what reads the keys restarted.
      const calls = h.calls();
      const pulls = calls.filter((c) => c.startsWith("podman pull"));
      expect(pulls.map((c) => c.split(" ").at(-1))).toEqual([
        expect.stringMatching(/^docker\.io\/stripe\/stripe-mock:v0\.206\.0@sha256:/),
        expect.stringMatching(/^ghcr\.io\/axllent\/mailpit:v1\.31\.6@sha256:/),
        expect.stringMatching(/\/commonair\/harness:0\.1\.0@sha256:[0-9a-f]{64}$/),
      ]);
      expect(calls).toContain("systemctl --user enable --now commonair-seed-mode-close.timer");
      // Armed before commonair.env changed: the first restart comes after it.
      expect(calls.indexOf("systemctl --user enable --now commonair-seed-mode-close.timer")).toBeLessThan(
        calls.findIndex((c) => c.startsWith("systemctl --user restart")),
      );
      expect(existsSync(lockPath(h))).toBe(false);
      const restart = calls.find((c) => c.startsWith("systemctl --user restart"))!;
      for (const u of ["api", "worker", "media", "chat"]) expect(restart).toContain(`commonair-${u}.service`);
      for (const u of ["postgres", "valkey", "migrate", "seed-harness"])
        expect(restart).not.toContain(`commonair-${u}.`);
      expect(calls.findIndex((c) => c.startsWith("podman pull"))).toBeLessThan(
        calls.findIndex((c) => c.startsWith("systemctl --user daemon-reload")),
      );
      expect(r.out).toContain(`Seed mode is OPEN on ${HOSTNAME} until`);
      expect(r.out).toContain(`selfhost.sh reset-staging --confirm ${HOSTNAME}`);
      expect(r.out).toContain(`selfhost.sh seed-mode run --confirm ${HOSTNAME} --scale medium`);
    },
    TIMEOUT,
  );

  /** The timer's deadline, in ms. */
  const timerDeadline = (h: Host) => {
    const at = /^OnCalendar=(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/m.exec(readFileSync(timerPath(h), "utf8"));
    expect(at).not.toBeNull();
    return Date.parse(`${at![1]}T${at![2]}Z`);
  };

  test(
    "the close timer fires at most 6 hours out, survives downtime and runs close",
    () => {
      const h = staging();
      const t0 = Date.now();
      expectOk(open(h));
      const deadline = timerDeadline(h);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 6 * 3600_000 + 1000);
      expect(deadline).toBeGreaterThanOrEqual(t0 + 6 * 3600_000 - 2000);
      const timer = readFileSync(timerPath(h), "utf8");
      expect(timer).toContain("Persistent=true\n");
      expect(timer).toContain("Unit=commonair-seed-mode-close.service\n");
      const service = readFileSync(join(systemdDir(h), "commonair-seed-mode-close.service"), "utf8");
      expect(service).toContain("ExecStart=/bin/sh %h/commonair/selfhost.sh seed-mode close\n");
      expect(service).toContain("Type=oneshot\n");
      // The state records the same deadline.
      const state = readFileSync(statePath(h), "utf8");
      expect(Number(/^DEADLINE=(\d+)$/m.exec(state)![1]) * 1000).toBe(deadline);
    },
    TIMEOUT,
  );

  test(
    "--hours shortens it",
    () => {
      const h = staging();
      expectOk(open(h, ["--hours", "2"]));
      expect(timerDeadline(h)).toBeLessThanOrEqual(Date.now() + 2 * 3600_000 + 1000);
      expect(timerDeadline(h)).toBeGreaterThan(Date.now() + 2 * 3600_000 - 60_000);
    },
    TIMEOUT,
  );
});

describe("seed-mode close", () => {
  test(
    "restores exactly the previous values, keeps the features on, removes everything else",
    () => {
      const h = staging();
      const before = envOf(h);
      expectOk(open(h));
      // As the harness's ExecStartPre= renders it: a copy of the instance's secrets.
      mkdirSync(join(harnessEnv(h), ".."), { recursive: true });
      writeFileSync(harnessEnv(h), "AUTH_SECRET=x\n");
      writeFileSync(`${harnessEnv(h)}.tmp.123`, "AUTH_SECRET=x\n");
      writeFileSync(h.log, "");
      const r = h.run(["seed-mode", "close"]);
      expectOk(r);
      // seed live is stopped (SIGTERM in the container) before the harness container stops.
      const order = h.calls();
      const termAt = order.findIndex(
        (c) => c.startsWith("podman exec commonair-seed-harness") && c.includes("kill -TERM"),
      );
      const stopAt = order.findIndex(
        (c) => c.startsWith("systemctl --user stop") && c.includes("commonair-seed-harness"),
      );
      expect(termAt).toBeGreaterThanOrEqual(0);
      expect(termAt).toBeLessThan(stopAt);
      expect(existsSync(harnessEnv(h))).toBe(false);
      expect(existsSync(`${harnessEnv(h)}.tmp.123`)).toBe(false);
      expect(existsSync(lockPath(h))).toBe(false);

      expect(block(h)).toBeNull();
      expect(readFileSync(envPath(h), "utf8")).not.toContain("seed mode");
      const after = envOf(h);
      const expected = { ...before, ...KEEP_ON };
      expect(after).toEqual(expected);
      expect("TWITCH_IMAGE_HOSTS" in after).toBe(false);
      // Each key once.
      const keys = readFileSync(envPath(h), "utf8")
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => l.slice(0, l.indexOf("=")));
      expect(keys.length).toBe(new Set(keys).size);
      expect(statSync(envPath(h)).mode & 0o777).toBe(0o600);

      expect(existsSync(statePath(h))).toBe(false);
      for (const u of SEED_UNITS) expect(existsSync(join(quadlet(h), u)), u).toBe(false);
      for (const u of [...DROPIN_UNITS, "seed-harness"])
        expect(existsSync(join(quadlet(h), `commonair-${u}.container.d`)), u).toBe(false);
      expect(readdirSync(systemdDir(h)).filter((f) => f.startsWith("commonair-seed-mode"))).toEqual([]);

      const calls = h.calls();
      expect(calls).toContain("systemctl --user disable --now commonair-seed-mode-close.timer");
      const stop = calls.find((c) => c.startsWith("systemctl --user stop"))!;
      for (const u of ["stripe-mock", "mailpit", "seed-harness"]) expect(stop).toContain(`commonair-${u}.service`);
      const restart = calls.find((c) => c.startsWith("systemctl --user restart"))!;
      for (const u of ["api", "worker", "media", "chat"]) expect(restart).toContain(`commonair-${u}.service`);
      expect(calls.filter((c) => c.includes("DROP DATABASE") || c.includes("FLUSHALL"))).toEqual([]);
      expect(r.out).toContain("Seed mode is closed");
      expect(r.out).toContain("The seeded data stays.");
    },
    TIMEOUT,
  );

  test(
    "is idempotent: a second close changes nothing",
    () => {
      const h = staging();
      expectOk(open(h));
      expectOk(h.run(["seed-mode", "close"]));
      const env = readFileSync(envPath(h), "utf8");
      writeFileSync(h.log, "");
      const r = h.run(["seed-mode", "close"]);
      expectOk(r);
      expect(r.out).toContain("seed mode is not open: nothing to close");
      expect(changes(h)).toEqual([]);
      expect(readFileSync(envPath(h), "utf8")).toBe(env);
    },
    TIMEOUT,
  );

  test(
    "finishes a close that stopped halfway (the state still there, the block already gone)",
    () => {
      const h = staging();
      const before = envOf(h);
      expectOk(open(h));
      // As if a close had stopped after removing the block, before restoring anything.
      const text = readFileSync(envPath(h), "utf8");
      writeFileSync(envPath(h), text.slice(0, text.indexOf(BEGIN)) + text.slice(text.indexOf(END) + END.length + 1));
      expectOk(h.run(["seed-mode", "close"]));
      expect(envOf(h)).toEqual({ ...before, ...KEEP_ON });
      expect(existsSync(statePath(h))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "while another close holds the lock (the timer's), changes nothing; a stale lock is taken over",
    () => {
      const h = staging();
      expectOk(open(h));
      const env = readFileSync(envPath(h), "utf8");
      const state = readFileSync(statePath(h), "utf8");
      // A live holder: this test's own process.
      symlinkSync(String(process.pid), lockPath(h));
      writeFileSync(h.log, "");
      const r = h.run(["seed-mode", "close"]);
      expectOk(r);
      expect(r.out).toContain(`another seed-mode open or close is running (pid ${process.pid}`);
      expect(changes(h)).toEqual([]);
      expect(readFileSync(envPath(h), "utf8")).toBe(env);
      expect(readFileSync(statePath(h), "utf8")).toBe(state);
      expect(readlinkSync(lockPath(h))).toBe(String(process.pid));
      // Status says a close is under way instead of inviting a second one.
      const status = h.run(["status"]).out;
      expect(status).toContain(`seed mode: being opened or closed (pid ${process.pid})`);
      expect(status).not.toContain("or selfhost.sh seed-mode close");
      // An open is refused as well.
      expect(open(h).err).toContain("another seed-mode open or close is running");

      // The holder gone (killed, a reboot): the next close takes the lock over and closes.
      const dead = Bun.spawnSync(["true"]).pid;
      rmLock(h);
      symlinkSync(String(dead), lockPath(h));
      expectOk(h.run(["seed-mode", "close"]));
      expect(block(h)).toBeNull();
      expect(existsSync(statePath(h))).toBe(false);
      expect(existsSync(lockPath(h))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "keeps an operator's own drop-in next to the seed-mode one",
    () => {
      const h = staging();
      expectOk(open(h));
      const own = join(quadlet(h), "commonair-media.container.d/gpu.conf");
      writeFileSync(own, "[Container]\nAddDevice=/dev/dri\n");
      expectOk(h.run(["seed-mode", "close"]));
      expect(readdirSync(join(quadlet(h), "commonair-media.container.d"))).toEqual(["gpu.conf"]);
    },
    TIMEOUT,
  );
});

describe("while seed mode is open", () => {
  test(
    "upgrade and install --reinstall refuse, naming seed-mode close, and change nothing",
    () => {
      const h = staging();
      expectOk(open(h));
      const env = readFileSync(envPath(h), "utf8");
      for (const args of [
        ["upgrade", "--version", "v0.2.0"],
        ["install", "--reinstall"],
        ["install", "--reinstall", "--version", "v0.2.0"],
      ]) {
        writeFileSync(h.log, "");
        const r = h.run(args);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.err).toContain("refused: staging seed mode is open");
        expect(r.err).toContain("selfhost.sh seed-mode close");
        expect(changes(h).filter((c) => !c.startsWith("loginctl") && !c.startsWith("timedatectl"))).toEqual([]);
        expect(readFileSync(envPath(h), "utf8")).toBe(env);
      }
      // Closed, the upgrade goes ahead.
      expectOk(h.run(["seed-mode", "close"]));
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
    },
    TIMEOUT * 2,
  );

  test(
    "status shows the deadline and the seed-mode units; closed, it says so",
    () => {
      const h = staging();
      expect(h.run(["status"]).out).toContain("seed mode: closed");
      expectOk(open(h, ["--hours", "3"]));
      const deadline = /^DEADLINE_UTC=(.*)$/m.exec(readFileSync(statePath(h), "utf8"))![1]!;
      expect(deadline).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      const out = h.run(["status"]).out;
      expect(out).toMatch(new RegExp(`seed mode: OPEN until ${deadline} \\((179|180) min left`));
      for (const u of ["stripe-mock", "mailpit", "seed-harness"]) expect(out).toContain(`commonair-${u} active`);
      expect(out).toMatch(/commonair-seed-harness\s+active/);
      expect(out).toContain("seed live: running");
      expect(h.run(["status"], { STUB_SEED_LIVE_DOWN: "1" }).out).toContain("seed live: not running");
    },
    TIMEOUT,
  );

  test(
    "outside seed mode, unit_in_mode keeps its units out of an install: no pull, no unit",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const pulls = h.calls().filter((c) => c.startsWith("podman pull"));
      expect(pulls.length).toBeGreaterThan(5);
      for (const image of ["stripe-mock", "mailpit", "/harness:"])
        expect(
          pulls.filter((c) => c.includes(image)),
          image,
        ).toEqual([]);
      for (const u of SEED_UNITS) expect(existsSync(join(quadlet(h), u)), u).toBe(false);
      // The release ships them all the same, rendered.
      for (const u of SEED_UNITS) expect(existsSync(join(h.home, "commonair/quadlet", u)), u).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "reset-staging prints seed-mode run as the next step",
    () => {
      const h = staging();
      expectOk(open(h));
      const r = h.run(["reset-staging", "--confirm", HOSTNAME]);
      expectOk(r);
      expect(r.out).toContain(`selfhost.sh seed-mode run --confirm ${HOSTNAME} --scale medium`);
      // The stop and start cover the seed-mode units too, so they come back with the stack.
      const start = h.calls().find((c) => c.startsWith("systemctl --user start --no-block") && c.includes("api"))!;
      expect(start).toContain("commonair-seed-harness.service");
    },
    TIMEOUT,
  );
});

describe("seed-mode run and coverage", () => {
  test(
    "run execs seed full in the harness container against the app role's database; the password passes by name",
    () => {
      const h = staging();
      expectOk(open(h));
      writeFileSync(h.log, "");
      const r = h.run(["seed-mode", "run", "--confirm", HOSTNAME, "--scale", "small", "--seed", "7"], {
        DEMO_SEED_PASSWORD: "staging-demo-pass-123",
      });
      expectOk(r);
      const exec = h.calls().filter((c) => c.startsWith("podman exec"));
      expect(exec[0]).toBe(
        "podman exec --env=DEMO_SEED_PASSWORD commonair-seed-harness bun harness/src/cli.ts seed full --confirm postgres:5432/commonair --scale small --seed 7",
      );
      // Then seed live, detached, with the same password by name, its pid and log in the reports volume.
      expect(exec[1]).toMatch(
        /^podman exec -d --env=DEMO_SEED_PASSWORD commonair-seed-harness sh -c .*exec bun harness\/src\/cli\.ts seed live --channels "\$2".* sh \/reports\/seed-live\.pid 3 seed-live\.log$/,
      );
      expect(exec[2]).toContain("kill -0");
      expect(exec).toHaveLength(3);
      expect(h.calls().join("\n")).not.toContain("staging-demo-pass-123");
      expect(r.out).toContain(join(h.home, ".local/share/commonair/seed-mode/reports/seed-store.json"));
      expect(r.err + r.out).toContain("seed live: 3 seeded channels stream with chat until seed-mode close");
      // Without a password the run makes one up (seed live signs in with it), passes it by name and
      // prints it once.
      writeFileSync(h.log, "");
      const made = h.run(["seed-mode", "run", "--confirm", HOSTNAME]);
      expectOk(made);
      const pw = /^Password for every account: ([0-9a-f]{64})$/m.exec(made.out)?.[1];
      expect(pw).toBeDefined();
      const calls = h.calls().filter((c) => c.startsWith("podman exec"));
      expect(calls[0]).toBe(
        "podman exec --env=DEMO_SEED_PASSWORD commonair-seed-harness bun harness/src/cli.ts seed full --confirm postgres:5432/commonair --scale medium --seed 1",
      );
      expect(calls[1]).toMatch(/^podman exec -d --env=DEMO_SEED_PASSWORD commonair-seed-harness sh -c /);
      expect(h.calls().join("\n")).not.toContain(pw!);
    },
    TIMEOUT,
  );

  test(
    "run warns when seed live exits at once, and does not fail the seeded run",
    () => {
      const h = staging();
      expectOk(open(h));
      const r = h.run(["seed-mode", "run", "--confirm", HOSTNAME], {
        DEMO_SEED_PASSWORD: "staging-demo-pass-123",
        STUB_SEED_LIVE_DOWN: "1",
      });
      expectOk(r);
      expect(r.err + r.out).toContain("seed live exited at once");
      expect(h.run(["status"], { STUB_SEED_LIVE_DOWN: "1" }).out).toContain("seed live: not running");
    },
    TIMEOUT,
  );

  test(
    "live restarts seed live (stop, then start), and needs DEMO_SEED_PASSWORD",
    () => {
      const h = staging();
      expectOk(open(h));
      writeFileSync(h.log, "");
      const none = h.run(["seed-mode", "live", "--confirm", HOSTNAME]);
      expect(none.code).toBe(1);
      expect(none.err).toContain("seed-mode live refused: DEMO_SEED_PASSWORD is not set");
      expect(h.calls().filter((c) => c.startsWith("podman exec"))).toEqual([]);
      const wrong = h.run(["seed-mode", "live", "--confirm", "prod.example.org"], {
        DEMO_SEED_PASSWORD: "staging-demo-pass-123",
      });
      expect(wrong.code).toBe(1);
      expect(h.calls().filter((c) => c.startsWith("podman exec"))).toEqual([]);
      expectOk(h.run(["seed-mode", "live", "--confirm", HOSTNAME], { DEMO_SEED_PASSWORD: "staging-demo-pass-123" }));
      const exec = h.calls().filter((c) => c.startsWith("podman exec"));
      expect(exec[0]).toContain("kill -TERM");
      expect(exec[1]).toMatch(/^podman exec -d --env=DEMO_SEED_PASSWORD commonair-seed-harness sh -c .*seed live/);
      expect(h.calls().join("\n")).not.toContain("staging-demo-pass-123");
    },
    TIMEOUT,
  );

  test.each([
    ["seed mode closed", false, ["--confirm", HOSTNAME], "seed-mode run refused: seed mode is not open"],
    ["a wrong --confirm", true, ["--confirm", "prod.example.org"], "is not this instance"],
    ["--scale large", true, ["--confirm", HOSTNAME, "--scale", "large"], "--scale must be small or medium"],
  ] as const)(
    "run refuses with %s",
    (_, opened, args, message) => {
      const h = staging();
      if (opened) expectOk(open(h));
      writeFileSync(h.log, "");
      const r = h.run(["seed-mode", "run", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
      expect(h.calls().filter((c) => c.startsWith("podman exec"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "run refuses after the deadline",
    () => {
      const h = staging();
      expectOk(open(h));
      const state = readFileSync(statePath(h), "utf8").replace(/^DEADLINE=\d+$/m, "DEADLINE=1000");
      writeFileSync(statePath(h), state);
      writeFileSync(h.log, "");
      const r = h.run(["seed-mode", "run", "--confirm", HOSTNAME]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("deadline");
      expect(h.calls().filter((c) => c.startsWith("podman exec"))).toEqual([]);
      expect(h.run(["status"]).out).toContain("seed mode: OPEN past its deadline");
    },
    TIMEOUT,
  );

  test(
    "coverage runs seed-coverage there, and needs DEMO_SEED_PASSWORD",
    () => {
      const h = staging();
      expectOk(open(h));
      writeFileSync(h.log, "");
      const none = h.run(["seed-mode", "coverage", "--confirm", HOSTNAME]);
      expect(none.code).toBe(1);
      expect(none.err).toContain("DEMO_SEED_PASSWORD is not set");
      expect(h.calls().filter((c) => c.startsWith("podman exec"))).toEqual([]);
      expectOk(
        h.run(["seed-mode", "coverage", "--confirm", HOSTNAME], { DEMO_SEED_PASSWORD: "staging-demo-pass-123" }),
      );
      expect(h.calls().filter((c) => c.startsWith("podman exec"))).toEqual([
        "podman exec --env=DEMO_SEED_PASSWORD commonair-seed-harness bun harness/src/cli.ts run seed-coverage",
      ]);
    },
    TIMEOUT,
  );
});

describe("seed-mode help", () => {
  test("--help lists the command and its subcommands", () => {
    const r = host().run(["--help"]);
    expect(r.code).toBe(0);
    for (const s of ["seed-mode open|run|live|coverage|close", "open --confirm <host> [--hours N]", "close  "])
      expect(r.out).toContain(s);
    expect(r.out).toContain("upgrade and install --reinstall are refused while seed mode is open");
  });
});
