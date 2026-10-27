// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host e2e checks for the object backup (R0-c), as functions R0-e wires into
 * scripts/selfhost/e2e.ts with its helpers:
 *
 *   objectBackupSetup(inHost, expectThat)  the offsite store: a bucket and a key of its own on the
 *       second Garage of e2e-s3.ts (started here if it is not running yet), rclone from the
 *       distribution's packages, and the BACKUP_OBJECTS_REMOTE_* settings in the instance's env
 *       file, as backups.md tells an operator to write them.
 *   checkObjectBackup(inHost, expectThat)  an object in the media bucket and one in the evidence
 *       bucket; `selfhost.sh backup --objects`; both are offsite, byte for byte; the state file,
 *       `status` and the enabled timer say so; the media object is deleted from the instance and
 *       `selfhost.sh backup --restore-objects` (the documented restore) brings it back, byte for
 *       byte; a deletion reaches the copy at the next backup (rclone sync). Returns the times.
 *   objectBackupTeardown(inHost)  disables the timer and removes the settings again.
 *
 * Works on a Garage instance and on an external one (e2e-s3.ts): the e2e's helper scripts read
 * the instance's store and keys from its env file, as selfhost.sh does. The second store's S3 port
 * is published on the host, where rclone runs, at 127.0.0.1. Plain http, hence
 * BACKUP_OBJECTS_REMOTE_ALLOW_HTTP=true.
 */
import { randomBytes } from "node:crypto";
import { E2E_STORE, type Expect, type InHost, externalStoreSetup } from "./e2e-s3.ts";

const hex = (n: number) => randomBytes(n).toString("hex");

/** The offsite store: the second Garage, its own bucket, a prefix below it. */
export const OFFSITE = {
  endpoint: E2E_STORE.publicEndpoint,
  region: E2E_STORE.region,
  bucket: "e2e-offsite",
  prefix: "e2e/objects",
  keyName: "e2e-offsite",
} as const;

/** The offsite store's key, fresh for each run: read and write on its bucket only. */
export const OFFSITE_KEY = { id: `GK${hex(12)}`, secret: hex(32) };

/** The env handed to the scripts that need the offsite key (never in a script's text). */
const offsiteEnv = (): Record<string, string> => ({
  OFFSITE_KEY_ID: OFFSITE_KEY.id,
  OFFSITE_SECRET: OFFSITE_KEY.secret,
});

const ENV_FILE = "$HOME/.config/commonair/commonair.env";
const STATE_FILE = "$HOME/.local/state/commonair/object-backup";

/** As root on the e2e host: the offsite bucket and its key on the second Garage, and rclone. */
export function offsiteSetupScript(): string {
  const g = `podman exec ${E2E_STORE.container} /garage`;
  return [
    "set -eu",
    `${g} bucket info ${OFFSITE.bucket} >/dev/null 2>&1 || ${g} bucket create ${OFFSITE.bucket} >/dev/null`,
    `${g} key import --yes -n ${OFFSITE.keyName} "$OFFSITE_KEY_ID" "$OFFSITE_SECRET" >/dev/null`,
    `${g} bucket allow --read --write ${OFFSITE.bucket} --key "$OFFSITE_KEY_ID" >/dev/null`,
    // What backups.md tells the operator to install.
    "if ! command -v rclone >/dev/null; then",
    "  if command -v apt-get >/dev/null; then",
    "    DEBIAN_FRONTEND=noninteractive apt-get install -y -q rclone >/dev/null 2>&1 ||",
    "      { apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q rclone >/dev/null; }",
    "  else dnf install -y -q rclone >/dev/null; fi",
    "fi",
    "rclone version | head -n 1",
    "echo offsite-ready",
  ].join("\n");
}

/**
 * As the instance user: the BACKUP_OBJECTS_REMOTE_* lines in the env file (earlier ones
 * replaced), the keys from the environment. With an external store, rclone on the host reaches
 * it at the published address, not the containers' host.containers.internal.
 */
export function remoteEnvScript(envFile = ENV_FILE): string {
  const lines = [
    ["BACKUP_OBJECTS_REMOTE_ENDPOINT", OFFSITE.endpoint],
    ["BACKUP_OBJECTS_REMOTE_REGION", OFFSITE.region],
    ["BACKUP_OBJECTS_REMOTE_BUCKET", OFFSITE.bucket],
    ["BACKUP_OBJECTS_REMOTE_PREFIX", OFFSITE.prefix],
    ["BACKUP_OBJECTS_REMOTE_PATH_STYLE", "true"],
    ["BACKUP_OBJECTS_REMOTE_ALLOW_HTTP", "true"],
  ];
  return [
    "set -eu",
    `f="${envFile}"`,
    "umask 077",
    `grep -v '^BACKUP_OBJECTS_REMOTE_' "$f" | grep -v '^BACKUP_OBJECTS_SOURCE_ENDPOINT=' > "$f.tmp" || true`,
    "{",
    ...lines.map(([k, v]) => `  printf '%s\\n' '${k}=${v}'`),
    `  printf 'BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID=%s\\n' "$OFFSITE_KEY_ID"`,
    `  printf 'BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY=%s\\n' "$OFFSITE_SECRET"`,
    `  if grep -q '^S3_MODE=external$' "$f"; then printf '%s\\n' 'BACKUP_OBJECTS_SOURCE_ENDPOINT=${E2E_STORE.publicEndpoint}'; fi`,
    `} >> "$f.tmp"`,
    `chmod 600 "$f.tmp"`,
    `mv "$f.tmp" "$f"`,
    "echo remote-configured",
  ].join("\n");
}

/** Starts the second store if need be, then prepares the offsite store and the env file. */
export function objectBackupSetup(inHost: InHost, expectThat: Expect): void {
  const running = inHost(`podman container exists ${E2E_STORE.container} && echo yes || echo no`).trim();
  if (running !== "yes") externalStoreSetup(inHost, expectThat);
  const out = inHost(offsiteSetupScript(), { env: offsiteEnv() });
  expectThat(out.trim().endsWith("offsite-ready"), "the offsite bucket, its key and rclone are in place");
  const env = inHost(remoteEnvScript(), { user: true, env: offsiteEnv() });
  expectThat(env.trim().endsWith("remote-configured"), "BACKUP_OBJECTS_REMOTE_* are in the env file");
}

/**
 * A shell prelude for the instance user: rclone remotes `inst` (the instance's store, with its
 * main key for media and evidence key for evidence, read from the env file) and `off` (the
 * offsite store), in the environment only, as selfhost.sh configures its own.
 */
export function remotesPrelude(bucketRole: "media" | "evidence", envFile = ENV_FILE): string {
  const [keyVar, secretVar, bucketVar, fallback] =
    bucketRole === "media"
      ? ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_MEDIA", "commonair-media"]
      : ["S3_EVIDENCE_ACCESS_KEY_ID", "S3_EVIDENCE_SECRET_ACCESS_KEY", "S3_BUCKET_EVIDENCE", "commonair-evidence"];
  const get = (k: string) => `$(sed -n 's/^${k}=//p' "$f" | head -n 1)`;
  return [
    "set -eu",
    `f="${envFile}"`,
    `bucket=${get(bucketVar)}; bucket=\${bucket:-${fallback}}`,
    `if grep -q '^S3_MODE=external$' "$f"; then ep=${get("BACKUP_OBJECTS_SOURCE_ENDPOINT")}; region=${get("S3_REGION")}; else ep=http://127.0.0.1:3900; region=garage; fi`,
    'conf=$(mktemp); : > "$conf"; export RCLONE_CONFIG="$conf"',
    "export RCLONE_CONFIG_INST_TYPE=s3 RCLONE_CONFIG_INST_PROVIDER=Other RCLONE_CONFIG_INST_FORCE_PATH_STYLE=true",
    'export RCLONE_CONFIG_INST_ENDPOINT="$ep" RCLONE_CONFIG_INST_REGION="$region" RCLONE_CONFIG_INST_NO_CHECK_BUCKET=true',
    `export RCLONE_CONFIG_INST_ACCESS_KEY_ID=${get(keyVar)}`,
    `export RCLONE_CONFIG_INST_SECRET_ACCESS_KEY=${get(secretVar)}`,
    "export RCLONE_CONFIG_OFF_TYPE=s3 RCLONE_CONFIG_OFF_PROVIDER=Other RCLONE_CONFIG_OFF_FORCE_PATH_STYLE=true",
    `export RCLONE_CONFIG_OFF_ENDPOINT=${OFFSITE.endpoint} RCLONE_CONFIG_OFF_REGION=${OFFSITE.region} RCLONE_CONFIG_OFF_NO_CHECK_BUCKET=true`,
    `export RCLONE_CONFIG_OFF_ACCESS_KEY_ID=${get("BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID")}`,
    `export RCLONE_CONFIG_OFF_SECRET_ACCESS_KEY=${get("BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY")}`,
    `off_dir=${OFFSITE.bucket}/${OFFSITE.prefix}/${bucketRole}`,
  ].join("\n");
}

/** The object's key in its bucket, and the sha256 of the bytes on each side (or "missing"). */
export const objectKey = (run: string) => `e2e/backup-${run}.bin`;
const sha = (remote: string) =>
  `{ rclone cat "${remote}" 2>/dev/null | sha256sum | cut -d' ' -f1; } | grep -v '^e3b0c442' || echo missing`;

/** Uploads random bytes into the instance's bucket and prints their sha256. */
export function putScript(role: "media" | "evidence", run: string, bytes: number): string {
  return [
    remotesPrelude(role),
    `tmp=$(mktemp); head -c ${bytes} /dev/urandom > "$tmp"`,
    `rclone copyto "$tmp" "inst:$bucket/${objectKey(run)}"`,
    `sha256sum "$tmp" | cut -d' ' -f1; rm -f "$tmp" "$conf"`,
  ].join("\n");
}

/** Prints "<instance sha> <offsite sha>" for the object ("missing" where it is not). */
export function shaScript(role: "media" | "evidence", run: string): string {
  return [
    remotesPrelude(role),
    `a=$(${sha(`inst:$bucket/${objectKey(run)}`)})`,
    `b=$(${sha(`off:$off_dir/${objectKey(run)}`)})`,
    'rm -f "$conf"; echo "$a $b"',
  ].join("\n");
}

export function deleteScript(role: "media" | "evidence", run: string): string {
  return [remotesPrelude(role), `rclone deletefile "inst:$bucket/${objectKey(run)}"`, 'rm -f "$conf"'].join("\n");
}

/** Bigger than one S3 part would be for a small client, smaller than rclone's multipart cutoff. */
export const OBJECT_BYTES = 512 * 1024;

/** Runs a selfhost.sh command as the instance user and prints its exit status and seconds. */
const timed = (args: string) =>
  `s=$(date +%s); rc=0; sh ~/commonair/selfhost.sh ${args} >/tmp/commonair-e2e-backup.out 2>&1 || rc=$?; ` +
  `cat /tmp/commonair-e2e-backup.out; echo "exit=$rc seconds=$(($(date +%s) - s))"`;

function result(out: string): { code: number; seconds: number; out: string } {
  const m = /exit=(\d+) seconds=(\d+)\s*$/.exec(out);
  return { code: m ? Number(m[1]) : -1, seconds: m ? Number(m[2]) : 0, out };
}

export interface ObjectBackupTimes {
  backupSeconds: number;
  restoreSeconds: number;
}

/** After objectBackupSetup: backup, the copy offsite, delete, restore, compare bytes. */
export function checkObjectBackup(inHost: InHost, expectThat: Expect): ObjectBackupTimes {
  const run = `${Date.now()}`;
  const asUser = { user: true };
  const media = inHost(putScript("media", run, OBJECT_BYTES), asUser).trim();
  const evidence = inHost(putScript("evidence", run, 4096), asUser).trim();
  expectThat(/^[0-9a-f]{64}$/.test(media) && /^[0-9a-f]{64}$/.test(evidence), "test objects are in media and evidence");

  const backup = result(inHost(timed("backup --objects"), asUser));
  expectThat(backup.code === 0, `selfhost.sh backup --objects succeeds (exit ${backup.code})`);
  expectThat(!backup.out.includes(OFFSITE_KEY.secret), "backup --objects prints no key");
  expectThat(
    inHost(shaScript("media", run), asUser).trim() === `${media} ${media}`,
    "the media object is offsite, byte for byte",
  );
  expectThat(
    inHost(shaScript("evidence", run), asUser).trim() === `${evidence} ${evidence}`,
    "the evidence object is offsite, byte for byte",
  );
  const state = inHost(`cat ${STATE_FILE}`, { ...asUser, allowFail: true });
  expectThat(/^LAST_SUCCESS=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m.test(state), "the state file records the success");
  const status = inHost("sh ~/commonair/selfhost.sh status", asUser);
  expectThat(
    status.includes(`last object backup: `) &&
      status.includes(`(to ${OFFSITE.endpoint}/${OFFSITE.bucket}/${OFFSITE.prefix})`),
    "status shows the last object backup",
  );
  const timer = inHost("systemctl --user is-enabled commonair-object-backup.timer", {
    ...asUser,
    allowFail: true,
  }).trim();
  expectThat(timer === "enabled", `the first success enabled the daily timer (${timer})`);

  // Lose the object on the instance, then restore it the documented way.
  inHost(deleteScript("media", run), asUser);
  expectThat(
    inHost(shaScript("media", run), asUser).trim() === `missing ${media}`,
    "the media object is gone from the instance, still offsite",
  );
  const restore = result(inHost(timed("backup --restore-objects"), asUser));
  expectThat(restore.code === 0, `selfhost.sh backup --restore-objects succeeds (exit ${restore.code})`);
  expectThat(
    inHost(shaScript("media", run), asUser).trim() === `${media} ${media}`,
    "the restored media object matches, byte for byte",
  );

  // rclone sync: a deletion on the instance reaches the copy at the next backup.
  inHost(deleteScript("media", run), asUser);
  inHost(deleteScript("evidence", run), asUser);
  const again = result(inHost(timed("backup --objects"), asUser));
  expectThat(again.code === 0, `a second backup --objects succeeds (exit ${again.code})`);
  expectThat(
    inHost(shaScript("media", run), asUser).trim() === "missing missing",
    "a media object deleted on the instance leaves the copy at the next backup",
  );
  return { backupSeconds: backup.seconds, restoreSeconds: restore.seconds };
}

/** Disables the timer and drops the settings (the store itself goes with externalStoreTeardown). */
export function objectBackupTeardown(inHost: InHost): void {
  inHost(
    "systemctl --user disable --now commonair-object-backup.timer >/dev/null 2>&1; " +
      `f="${ENV_FILE}"; grep -v '^BACKUP_OBJECTS_' "$f" > "$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"; ` +
      `rm -f ${STATE_FILE}`,
    { user: true, allowFail: true },
  );
}
