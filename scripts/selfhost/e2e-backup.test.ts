// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure parts of scripts/selfhost/e2e-backup.ts: how it prepares the offsite store and the
 * env file, and that no key is ever in a script's text. The checks themselves run in the
 * self-host e2e.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  OFFSITE,
  OFFSITE_KEY,
  checkObjectBackup,
  deleteScript,
  objectBackupSetup,
  objectKey,
  offsiteSetupScript,
  putScript,
  remoteEnvScript,
  remotesPrelude,
  shaScript,
} from "./e2e-backup.ts";
import { E2E_STORE } from "./e2e-s3.ts";

const scripts = () => [
  offsiteSetupScript(),
  remoteEnvScript(),
  remotesPrelude("media"),
  remotesPrelude("evidence"),
  putScript("media", "r1", 10),
  shaScript("evidence", "r1"),
  deleteScript("media", "r1"),
];

describe("the offsite store", () => {
  test("its own bucket on the second store, a fresh Garage-format key, read and write on that bucket only", () => {
    expect(OFFSITE.endpoint).toBe(E2E_STORE.publicEndpoint);
    expect(Object.values(E2E_STORE.buckets)).not.toContain(OFFSITE.bucket);
    expect(OFFSITE_KEY.id).toMatch(/^GK[0-9a-f]{24}$/);
    expect(OFFSITE_KEY.secret).toMatch(/^[0-9a-f]{64}$/);
    const s = offsiteSetupScript();
    expect(s).toContain(`bucket allow --read --write ${OFFSITE.bucket} --key "$OFFSITE_KEY_ID"`);
    expect(s).not.toContain("--owner");
    expect(s).toContain("apt-get install -y -q rclone");
    expect(s).toContain("dnf install -y -q rclone");
  });

  test("no key is in any script's text: they come from the environment or the env file", () => {
    for (const s of scripts()) {
      expect(s).not.toContain(OFFSITE_KEY.id);
      expect(s).not.toContain(OFFSITE_KEY.secret);
    }
  });

  test("setup starts the second store only when it is not running, and passes the key in the env", () => {
    for (const running of [true, false]) {
      const calls: { script: string; env?: Record<string, string>; user?: boolean }[] = [];
      objectBackupSetup(
        (script, opts) => {
          calls.push({ script, env: opts?.env, user: opts?.user });
          if (script.startsWith("podman container exists")) return running ? "yes\n" : "no\n";
          if (script.includes("store-ready")) return "store-ready\n";
          if (script.includes("unsigned") || script.includes("%{http_code}")) return "403";
          if (script.includes("offsite-ready")) return "rclone v1.69.1\noffsite-ready\n";
          if (script.includes("remote-configured")) return "remote-configured\n";
          return "";
        },
        (ok, what) => expect(ok, what).toBe(true),
      );
      expect(calls.some((c) => c.script.includes("store-ready"))).toBe(!running);
      const offsite = calls.find((c) => c.script.includes("offsite-ready"))!;
      const env = calls.find((c) => c.script.includes("remote-configured"))!;
      expect(offsite.user).toBeFalsy();
      expect(env.user).toBe(true);
      for (const c of [offsite, env])
        expect(c.env).toEqual({ OFFSITE_KEY_ID: OFFSITE_KEY.id, OFFSITE_SECRET: OFFSITE_KEY.secret });
    }
  });
});

describe("the env file it writes", () => {
  const run = (initial: string) => {
    const dir = mkdtempSync(join(tmpdir(), "commonair-e2e-backup-"));
    const f = join(dir, "commonair.env");
    writeFileSync(f, initial, { mode: 0o600 });
    const r = Bun.spawnSync(["sh", "-c", remoteEnvScript(f)], {
      env: { PATH: process.env.PATH ?? "", OFFSITE_KEY_ID: OFFSITE_KEY.id, OFFSITE_SECRET: OFFSITE_KEY.secret },
    });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return { text: readFileSync(f, "utf8"), mode: statSync(f).mode & 0o777, out: r.stdout.toString() };
  };

  test("Garage: the remote settings and keys, replacing earlier ones, mode 0600", () => {
    const { text, mode, out } = run("S3_BUCKET_MEDIA=commonair-media\nBACKUP_OBJECTS_REMOTE_BUCKET=old\n");
    expect(out.trim()).toBe("remote-configured");
    expect(mode).toBe(0o600);
    expect(text).toContain("S3_BUCKET_MEDIA=commonair-media\n");
    expect(text).not.toContain("BACKUP_OBJECTS_REMOTE_BUCKET=old");
    expect(text).toContain(`BACKUP_OBJECTS_REMOTE_ENDPOINT=${OFFSITE.endpoint}\n`);
    expect(text).toContain(`BACKUP_OBJECTS_REMOTE_BUCKET=${OFFSITE.bucket}\n`);
    expect(text).toContain(`BACKUP_OBJECTS_REMOTE_PREFIX=${OFFSITE.prefix}\n`);
    expect(text).toContain("BACKUP_OBJECTS_REMOTE_ALLOW_HTTP=true\n");
    expect(text).toContain(`BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID=${OFFSITE_KEY.id}\n`);
    expect(text).toContain(`BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY=${OFFSITE_KEY.secret}\n`);
    expect(text).not.toContain("BACKUP_OBJECTS_SOURCE_ENDPOINT");
  });

  test("an external store: the host reaches it at its published address", () => {
    const { text } = run("S3_MODE=external\nS3_ENDPOINT=http://host.containers.internal:3910\n");
    expect(text).toContain(`BACKUP_OBJECTS_SOURCE_ENDPOINT=${E2E_STORE.publicEndpoint}\n`);
    expect(run(text).text.match(/BACKUP_OBJECTS_SOURCE_ENDPOINT=/g)?.length).toBe(1);
  });
});

describe("the helper scripts", () => {
  test("each bucket with the instance key that may write it, the offsite copy under <bucket>/<prefix>/<role>", () => {
    const media = remotesPrelude("media");
    expect(media).toContain("s/^S3_ACCESS_KEY_ID=//p");
    expect(media).toContain("s/^S3_BUCKET_MEDIA=//p");
    expect(media).toContain(`off_dir=${OFFSITE.bucket}/${OFFSITE.prefix}/media`);
    const evidence = remotesPrelude("evidence");
    expect(evidence).toContain("s/^S3_EVIDENCE_ACCESS_KEY_ID=//p");
    expect(evidence).toContain(`off_dir=${OFFSITE.bucket}/${OFFSITE.prefix}/evidence`);
    expect(evidence).not.toContain("s/^S3_ACCESS_KEY_ID=//p");
    for (const p of [media, evidence]) {
      expect(p).toContain("RCLONE_CONFIG_INST_NO_CHECK_BUCKET=true");
      expect(p).toContain("RCLONE_CONFIG_OFF_NO_CHECK_BUCKET=true");
      expect(p).toContain("ep=http://127.0.0.1:3900");
    }
  });

  test("the object keys and paths line up between upload, comparison and delete", () => {
    const key = objectKey("r1");
    expect(putScript("media", "r1", 10)).toContain(`"inst:$bucket/${key}"`);
    expect(shaScript("media", "r1")).toContain(`inst:$bucket/${key}`);
    expect(shaScript("media", "r1")).toContain(`off:$off_dir/${key}`);
    expect(deleteScript("media", "r1")).toContain(`"inst:$bucket/${key}"`);
  });

  test("checkObjectBackup fails loudly when the backup fails", () => {
    const seen: [boolean, string][] = [];
    expect(() =>
      checkObjectBackup(
        (script) => {
          if (script.includes('sha256sum "$tmp"')) return `${"a".repeat(64)}\n`;
          if (script.includes("backup --objects")) return "selfhost: error: no offsite store\nexit=1 seconds=0\n";
          return "";
        },
        (ok, what) => {
          seen.push([ok, what]);
          if (!ok) throw new Error(what);
        },
      ),
    ).toThrow("selfhost.sh backup --objects succeeds (exit 1)");
    expect(seen[0]).toEqual([true, "test objects are in media and evidence"]);
  });
});
