// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host e2e checks for logical dumps and the restore drills (S1-h, ADR 0032 §4), as functions
 * the orchestrator wires into scripts/selfhost/e2e.ts beside the object backup (e2e-backup.ts):
 *
 *   checkDumps(inHost, expectThat)  external state, after objectBackupSetup (the dumps go to the
 *       same offsite store, under <prefix>/dumps): `selfhost.sh backup --dump`; the dump, its
 *       counts.json and its .sha256 are there and the checksum matches the bytes; the state file,
 *       `status` and the enabled nightly timer say so; `selfhost.sh backup --drill` passes and its
 *       gauges reach Prometheus with kind="dump"; with 30 older dumps seeded, the next dump
 *       deletes exactly the oldest and the newest 30 stay. Returns the times.
 *   checkWalgDrill(inHost, expectThat)  bundled state, after a base backup exists: one run of
 *       commonair-drill-walg.service (what its weekly timer starts) succeeds, its state file
 *       says so, and its gauges reach Prometheus with kind="walg".
 *   dumpTeardown(inHost)  disables the timers and removes the seeded dumps and the state files.
 *
 * The existing WAL-G checks (e2e-backup.ts, e2e.ts) are untouched.
 */
import { OFFSITE, remotesPrelude } from "./e2e-backup.ts";
import { type Expect, type InHost, promGet, queryPath, vectorValue } from "./e2e-metrics.ts";

const STATE_DIR = "$HOME/.local/state/commonair";
/** Where `backup --dump` writes, below the offsite bucket (selfhost.sh dumps_base). */
export const DUMPS_DIR = `${OFFSITE.bucket}/${OFFSITE.prefix}/dumps`;
/** ADR 0032 §4. */
export const DUMP_KEEP = 30;
/** The collector exports every 30 s and Prometheus scrapes every 15 s. */
export const GAUGE_TIMEOUT_MS = 180_000;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * `count` dump dates, one a day, ending the day before `before` (YYYY-MM-DD): older than any
 * real dump of this run, so retention must take the oldest of them first.
 */
export function seedDates(count: number, before: string): string[] {
  const end = Date.parse(`${before}T00:00:00Z`) - 86_400_000;
  return Array.from({ length: count }, (_v, i) =>
    new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkDates(dates: string[]): void {
  for (const d of dates) if (!DATE.test(d)) throw new Error(`not a dump date: ${d}`);
}

/**
 * As the instance user: complete stand-in dumps (a dump file and its sidecar) for each date,
 * through the offsite remote of e2e-backup.ts's prelude (keys from the env file, never the text).
 */
export function seedScript(dates: string[]): string {
  checkDates(dates);
  return [
    remotesPrelude("media"),
    `dumps=${DUMPS_DIR}`,
    `for d in ${dates.join(" ")}; do`,
    `  printf 'stand-in dump %s\\n' "$d" | rclone rcat "off:$dumps/$d/commonair.dump"`,
    `  printf '%s  commonair.dump\\n' "$(printf 'stand-in dump %s\\n' "$d" | sha256sum | cut -d' ' -f1)" | rclone rcat "off:$dumps/$d/commonair.dump.sha256"`,
    "done",
    'rm -f "$conf"',
    "echo seeded",
  ].join("\n");
}

/** As the instance user: the dump dates at the store, one per line. */
export function listScript(): string {
  return [
    remotesPrelude("media"),
    `rclone lsf --dirs-only "off:${DUMPS_DIR}" 2>/dev/null | sed 's|/$||' || true`,
    'rm -f "$conf"',
  ].join("\n");
}

/** As the instance user: "<sidecar sha> <sha of the bytes> <size>" of the dump of `date`. */
export function dumpShaScript(date: string): string {
  checkDates([date]);
  const dir = `off:${DUMPS_DIR}/${date}`;
  return [
    remotesPrelude("media"),
    `want=$(rclone cat "${dir}/commonair.dump.sha256" | cut -d' ' -f1)`,
    `got=$(rclone cat "${dir}/commonair.dump" | sha256sum | cut -d' ' -f1)`,
    `size=$(rclone cat "${dir}/commonair.dump" | wc -c | tr -d ' ')`,
    `counts=$(rclone cat "${dir}/counts.json" | grep -c '"rows\\.' || true)`,
    'rm -f "$conf"',
    'echo "$want $got $size $counts"',
  ].join("\n");
}

/** As the instance user: removes every dump directory and the dump and drill state. */
export function teardownScript(): string {
  return [
    `for t in commonair-dump.timer commonair-drill.timer; do systemctl --user disable --now "$t" >/dev/null 2>&1 || true; done`,
    remotesPrelude("media"),
    `rclone purge "off:${DUMPS_DIR}" >/dev/null 2>&1 || true`,
    'rm -f "$conf"',
    `rm -f ${STATE_DIR}/db-dump ${STATE_DIR}/db-backup.lock ${STATE_DIR}/restore-drill-dump ${STATE_DIR}/restore-drill-dump.passed`,
  ].join("\n");
}

/** Runs a selfhost.sh command as the instance user and prints its exit status and seconds. */
const timed = (args: string) =>
  `s=$(date +%s); rc=0; sh ~/commonair/selfhost.sh ${args} >/tmp/commonair-e2e-dump.out 2>&1 || rc=$?; ` +
  `cat /tmp/commonair-e2e-dump.out; echo "exit=$rc seconds=$(($(date +%s) - s))"`;

export function result(out: string): { code: number; seconds: number; out: string } {
  const m = /exit=(\d+) seconds=(\d+)\s*$/.exec(out);
  return { code: m ? Number(m[1]) : -1, seconds: m ? Number(m[2]) : 0, out };
}

/** PromQL: the drill's gauge of `kind`, over the last hour (the collector forgets it after 5 min). */
export const drillQuery = (name: "seconds" | "success", kind: "dump" | "walg") =>
  `max(max_over_time(commonair_restore_drill_${name}{kind="${kind}"}[1h]))`;

async function gauge(
  inHost: InHost,
  query: string,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? GAUGE_TIMEOUT_MS);
  for (;;) {
    let v = 0;
    try {
      v = vectorValue(inHost(promGet(queryPath(query)), { user: true, allowFail: true }));
    } catch {
      v = 0;
    }
    if (v > 0 || Date.now() > deadline) return v;
    await sleep(5_000);
  }
}

const parseState = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

export interface DumpTimes {
  dumpSeconds: number;
  drillSeconds: number;
}

/** External state, after objectBackupSetup. */
export async function checkDumps(
  inHost: InHost,
  expectThat: Expect,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DumpTimes> {
  const asUser = { user: true };
  inHost(teardownScript(), { ...asUser, allowFail: true });
  const date = today();

  const dump = result(inHost(timed("backup --dump"), asUser));
  expectThat(dump.code === 0, `selfhost.sh backup --dump succeeds (exit ${dump.code})`);
  const [want, got, size, counts] = inHost(dumpShaScript(date), asUser).trim().split(" ");
  expectThat(/^[0-9a-f]{64}$/.test(want ?? "") && want === got, "the dump is offsite and matches its SHA-256 sidecar");
  expectThat(Number(size) > 0, `the dump is not empty (${size} bytes)`);
  expectThat(Number(counts) > 0, `counts.json beside it lists the tables (${counts})`);
  const state = parseState(inHost(`cat ${STATE_DIR}/db-dump`, { ...asUser, allowFail: true }));
  expectThat(state.DUMP === date && state.SHA256 === want, "the state file records the dump");
  const status = inHost("sh ~/commonair/selfhost.sh status", asUser);
  expectThat(status.includes(`last dump: ${state.LAST_SUCCESS ?? "?"}`), "status shows the last dump's time and size");
  const timer = inHost("systemctl --user is-enabled commonair-dump.timer", { ...asUser, allowFail: true }).trim();
  expectThat(timer === "enabled", `the nightly dump timer is enabled (${timer})`);

  const drill = result(inHost(timed("backup --drill"), asUser));
  expectThat(drill.code === 0, `selfhost.sh backup --drill succeeds (exit ${drill.code})`);
  expectThat(/all \d+ checks match/.test(drill.out), "the drill's counts match the dump's");
  expectThat(!/commonair_drill_owner.*@|password/i.test(drill.out), "the drill prints no credentials");
  const drillState = parseState(inHost(`cat ${STATE_DIR}/restore-drill-dump`, { ...asUser, allowFail: true }));
  expectThat(drillState.RESULT === "success", "the drill's state file records the success");
  const leftover = inHost(
    "podman ps -a --format '{{.Names}}' --filter name=commonair-drill-; podman volume ls -q --filter name=commonair-drill-",
    {
      ...asUser,
      allowFail: true,
    },
  ).trim();
  expectThat(leftover === "", `the drill removed its container and volume (${leftover || "none left"})`);
  const seconds = await gauge(inHost, drillQuery("seconds", "dump"), opts);
  expectThat(seconds > 0, `Prometheus has commonair_restore_drill_seconds{kind="dump"} (${seconds})`);
  const success = await gauge(inHost, drillQuery("success", "dump"), opts);
  expectThat(success === 1, `Prometheus has commonair_restore_drill_success{kind="dump"} = 1 (${success})`);

  // Retention: 30 older stand-ins plus today's real dump is 31; the next dump replaces today's,
  // and retention deletes exactly the oldest stand-in.
  const seeded = seedDates(DUMP_KEEP, date);
  expectThat(inHost(seedScript(seeded), asUser).trim().endsWith("seeded"), `${DUMP_KEEP} older dumps are seeded`);
  const again = result(inHost(timed("backup --dump"), asUser));
  expectThat(again.code === 0, `a second backup --dump succeeds (exit ${again.code})`);
  const left = inHost(listScript(), asUser).trim().split("\n").filter(Boolean).sort();
  expectThat(left.length === DUMP_KEEP, `${DUMP_KEEP} dumps stay (${left.length})`);
  expectThat(!left.includes(seeded[0] ?? ""), `the oldest (${seeded[0]}) was deleted`);
  expectThat(left.includes(date) && left.includes(seeded[1] ?? ""), "the newest 30 stay, today's included");
  return { dumpSeconds: dump.seconds, drillSeconds: drill.seconds };
}

/** Bundled state, after a base backup exists (the install's, or `selfhost.sh backup`). */
export async function checkWalgDrill(
  inHost: InHost,
  expectThat: Expect,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const asUser = { user: true };
  const timer = inHost("systemctl --user is-enabled commonair-drill-walg.timer", { ...asUser, allowFail: true }).trim();
  expectThat(timer === "enabled", `the weekly WAL-G drill timer is enabled with the bundled Postgres (${timer})`);
  const s = Date.now();
  inHost("systemctl --user start commonair-drill-walg.service", asUser);
  const secs = Math.round((Date.now() - s) / 1000);
  const res = inHost("systemctl --user show commonair-drill-walg.service --property=Result --value", asUser).trim();
  expectThat(res === "success", `commonair-drill-walg.service succeeded (${res})`);
  const state = parseState(inHost(`cat ${STATE_DIR}/restore-drill-walg`, { ...asUser, allowFail: true }));
  expectThat(state.RESULT === "success", "the WAL-G drill's state file records the success");
  const seconds = await gauge(inHost, drillQuery("seconds", "walg"), opts);
  expectThat(seconds > 0, `Prometheus has commonair_restore_drill_seconds{kind="walg"} (${seconds})`);
  const success = await gauge(inHost, drillQuery("success", "walg"), opts);
  expectThat(success === 1, `Prometheus has commonair_restore_drill_success{kind="walg"} = 1 (${success})`);
  return secs;
}

export function dumpTeardown(inHost: InHost): void {
  inHost(teardownScript(), { user: true, allowFail: true });
}
