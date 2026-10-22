// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { validatePosting } from "@commonair/ledger";
import { describe, expect, test } from "vite-plus/test";
import {
  type Fingerprint,
  type LedgerEntryRow,
  type Marker,
  REQUIRED_FUNCTIONS,
  REQUIRED_GRANTS,
  REQUIRED_TRIGGERS,
  compareFingerprints,
  ledgerDigest,
  missingRequired,
} from "../src/drill/fingerprint.ts";
import {
  type StackPostgres,
  SECRET_ENV,
  collisionProblems,
  countReplayedSegments,
  drillNames,
  drillPrefix,
  parseInspect,
  parsePort,
  prefixStats,
  runArgs,
} from "../src/drill/podman.ts";
import {
  REFUSALS,
  type Refusal,
  type RefusalName,
  drillAmount,
  drillPosting,
  refusalProblems,
} from "../src/drill/seed.ts";

const MARKER_TX = "01900000-0000-7000-8000-00000000ffff";
const marker: Marker = { transactionId: MARKER_TX, entries: 2 };

function entry(id: string, tx: string, amount: number): LedgerEntryRow {
  return {
    id,
    transactionId: tx,
    accountId: "acc",
    amountCents: String(amount),
    currency: "usd",
    memo: null,
    createdAtUs: "1",
  };
}

const ENTRIES = [entry("e1", "t1", 100), entry("e2", "t1", -100), entry("e3", "t2", 7), entry("e4", "t2", -7)];
const MARKER_ENTRIES = [entry("e9", MARKER_TX, 4242), entry("ea", MARKER_TX, -4242)];

/** A fingerprint taken right after migration and seeding. */
function baseline(): Fingerprint {
  return {
    triggers: [
      ...REQUIRED_TRIGGERS.map(([table, name]) => ({ table, name, enabled: "O" })),
      { table: "memberships", name: "memberships_history", enabled: "O" },
    ],
    functions: [
      ...REQUIRED_FUNCTIONS.map((name) => ({ name, args: "", md5: `md5-${name}` })),
      { name: "commonair_setting", args: "p_key text", md5: "md5-setting" },
    ],
    grants: [...REQUIRED_GRANTS, { table: "users", privilege: "UPDATE" }],
    rowCounts: { users: 12, ledger_transactions: 2, ledger_entries: 4, audit_log: 3 },
    ledgerTransactionIds: ["t1", "t2"],
    ledgerDigest: ledgerDigest(ENTRIES),
    digestExcludes: [],
    ledgerEntryCount: 4,
    imbalances: [],
  };
}

/** The faithful restore of `baseline()` plus the marker. */
function restored(): Fingerprint {
  const b = baseline();
  return {
    ...b,
    rowCounts: { ...b.rowCounts, ledger_transactions: 3, ledger_entries: 6 },
    ledgerTransactionIds: [...b.ledgerTransactionIds, MARKER_TX],
    ledgerDigest: ledgerDigest([...ENTRIES, ...MARKER_ENTRIES], new Set([MARKER_TX])),
    digestExcludes: [MARKER_TX],
    ledgerEntryCount: 6,
  };
}

describe("restore drill: fingerprint comparison", () => {
  test("a faithful restore plus the marker compares equal", () => {
    expect(compareFingerprints(baseline(), restored(), marker)).toEqual([]);
  });

  test("a missing trigger fails", () => {
    const after = restored();
    after.triggers = after.triggers.filter((t) => t.name !== "memberships_history");
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "trigger memberships.memberships_history missing after restore",
    ]);
    const noLedgerGuard = restored();
    noLedgerGuard.triggers = noLedgerGuard.triggers.filter((t) => t.name !== "ledger_entries_append_only");
    expect(compareFingerprints(baseline(), noLedgerGuard, marker)).toContain(
      "after restore: trigger ledger_entries.ledger_entries_append_only is missing",
    );
  });

  test("a disabled trigger fails", () => {
    const after = restored();
    after.triggers = after.triggers.map((t) => (t.name === "memberships_history" ? { ...t, enabled: "D" } : t));
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "trigger memberships.memberships_history enabled state O → D",
    ]);
    const replicaOnly = restored();
    replicaOnly.triggers = replicaOnly.triggers.map((t) =>
      t.name === "audit_log_append_only" ? { ...t, enabled: "R" } : t,
    );
    expect(compareFingerprints(baseline(), replicaOnly, marker)).toEqual([
      "trigger audit_log.audit_log_append_only enabled state O → R",
    ]);
  });

  test("a changed function body fails", () => {
    const after = restored();
    after.functions = after.functions.map((f) =>
      f.name === "commonair_ledger_balance_check" ? { ...f, md5: "tampered" } : f,
    );
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "function commonair_ledger_balance_check() body changed",
    ]);
  });

  test("a dropped protection function fails", () => {
    const after = restored();
    after.functions = after.functions.filter((f) => f.name !== "commonair_setting");
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "function commonair_setting(p_key text) missing after restore",
    ]);
  });

  test("a dropped grant fails", () => {
    const after = restored();
    after.grants = after.grants.filter((g) => !(g.table === "users" && g.privilege === "UPDATE"));
    expect(compareFingerprints(baseline(), after, marker)).toEqual(["grant UPDATE on users missing after restore"]);
  });

  test("an extra grant (e.g. UPDATE on ledger_entries) fails", () => {
    const after = restored();
    after.grants = [...after.grants, { table: "ledger_entries", privilege: "UPDATE" }];
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "grant UPDATE on ledger_entries appeared after restore",
    ]);
  });

  test("an unbalanced transaction fails", () => {
    const after = restored();
    after.imbalances = [{ transactionId: "t2", currency: "usd", sumCents: "1" }];
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "ledger transaction t2 sums to 1 usd after restore",
    ]);
  });

  test("a changed ledger entry fails (ordered digest)", () => {
    const after = restored();
    after.ledgerDigest = ledgerDigest(
      [entry("e1", "t1", 100), entry("e2", "t1", -100), entry("e3", "t2", 8), entry("e4", "t2", -8)],
      new Set([MARKER_TX]),
    );
    expect(compareFingerprints(baseline(), after, marker)).toEqual([
      "ledger_entries differ from the backup (ordered md5, marker excluded)",
    ]);
  });

  test("a restore without WAL replay (no marker) fails", () => {
    const after = baseline();
    after.digestExcludes = [MARKER_TX];
    const problems = compareFingerprints(baseline(), after, marker);
    expect(problems).toContain(
      "the WAL-replay marker transaction is missing: WAL after the base backup was not replayed",
    );
    expect(problems).toContain("table ledger_transactions: 2 rows after restore, expected 3");
  });

  test("lost rows elsewhere fail", () => {
    const after = restored();
    after.rowCounts = { ...after.rowCounts, users: 11 };
    expect(compareFingerprints(baseline(), after, marker)).toEqual(["table users: 11 rows after restore, expected 12"]);
  });

  test("an empty fingerprint on both sides never compares equal", () => {
    const empty: Fingerprint = {
      triggers: [],
      functions: [],
      grants: [],
      rowCounts: {},
      ledgerTransactionIds: [],
      ledgerDigest: ledgerDigest([]),
      digestExcludes: [MARKER_TX],
      ledgerEntryCount: 0,
      imbalances: [],
    };
    const problems = compareFingerprints(empty, { ...empty }, marker);
    expect(problems.some((p) => p.startsWith("before backup: trigger"))).toBe(true);
    expect(problems.some((p) => p.startsWith("after restore: function"))).toBe(true);
    expect(missingRequired(empty).length).toBe(
      REQUIRED_TRIGGERS.length + REQUIRED_FUNCTIONS.length + REQUIRED_GRANTS.length,
    );
  });

  test("the ledger digest ignores arrival order and honors exclusions", () => {
    expect(ledgerDigest([...ENTRIES].reverse())).toBe(ledgerDigest(ENTRIES));
    expect(ledgerDigest([...ENTRIES, ...MARKER_ENTRIES], new Set([MARKER_TX]))).toBe(ledgerDigest(ENTRIES));
    expect(ledgerDigest([...ENTRIES, ...MARKER_ENTRIES])).not.toBe(ledgerDigest(ENTRIES));
    expect(ledgerDigest([{ ...ENTRIES[0]!, memo: "x" }, ...ENTRIES.slice(1)])).not.toBe(ledgerDigest(ENTRIES));
  });
});

describe("restore drill: refusals and postings", () => {
  test("every refusal must be attempted and refused", () => {
    const db: Record<RefusalName, { code: string; detail: string }> = {
      "UPDATE ledger_entries": { code: "42501", detail: "permission denied for table ledger_entries" },
      "DELETE ledger_entries": { code: "42501", detail: "permission denied for table ledger_entries" },
      "UPDATE audit_log": { code: "42501", detail: "table audit_log is append-only (UPDATE rejected)" },
      "DELETE audit_log": { code: "42501", detail: "permission denied for table audit_log" },
      "unbalanced posting": { code: "23514", detail: "ledger transaction x is unbalanced in usd: 1 cents" },
      "INSERT proposals with status passed": { code: "23514", detail: "proposals start as drafts" },
      "UPDATE proposals.status = passed": { code: "23514", detail: "proposal status cannot go from draft to passed" },
    };
    const all: Refusal[] = REFUSALS.map((name) => ({ name, refused: true, ...db[name] }));
    expect(refusalProblems(all)).toEqual([]);
    expect(refusalProblems(all.slice(1))).toEqual(["UPDATE ledger_entries: not attempted"]);
    const leaky = all.map((r) =>
      r.name === "unbalanced posting" ? { ...r, refused: false, code: null, detail: "the write was committed" } : r,
    );
    expect(refusalProblems(leaky)).toEqual(["unbalanced posting: the write was committed"]);
  });

  test("an error that is not the protection does not count as a refusal", () => {
    const typo: Refusal[] = REFUSALS.map((name) =>
      name === "INSERT proposals with status passed"
        ? { name, refused: true, code: "42703", detail: 'column "statu" does not exist' }
        : {
            name,
            refused: true,
            code: name.includes("proposal") || name.includes("unbalanced") ? "23514" : "42501",
            detail: name.includes("unbalanced")
              ? "unbalanced"
              : name.includes("proposal")
                ? "proposal status cannot go"
                : "permission denied",
          },
    );
    expect(refusalProblems(typo)).toEqual([
      'INSERT proposals with status passed: refused for another reason (42703: column "statu" does not exist)',
    ]);
    const noCode = REFUSALS.map((name) => ({ name, refused: true, code: null, detail: "connection terminated" }));
    expect(refusalProblems(noCode)).toHaveLength(REFUSALS.length);
    // Another check failing with the right code but the wrong message is not the protection either.
    const wrongCheck = REFUSALS.map((name) => ({
      name,
      refused: true,
      code: "23514",
      detail: 'new row violates check constraint "ledger_entries_nonzero"',
    }));
    expect(refusalProblems(wrongCheck)).toContain(
      'unbalanced posting: refused for another reason (23514: new row violates check constraint "ledger_entries_nonzero")',
    );
  });

  test("drill postings balance and use distinct keys", () => {
    const at = new Date("2026-10-22T00:00:00Z");
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = drillPosting("run1", `seed-${i}`, drillAmount(i), at);
      expect(() => validatePosting(p)).not.toThrow();
      expect(p.entries.reduce((s, e) => s + e.amountCents, 0)).toBe(0);
      keys.add(p.idempotencyKey);
    }
    expect(keys.size).toBe(20);
    expect(() => drillPosting("run1", "x", 0, at)).toThrow(RangeError);
  });
});

const STACK: StackPostgres = {
  id: "abc123",
  name: "commonair_postgres_1",
  image: "localhost/commonair/postgres:dev",
  networks: ["commonair_default"],
  volumes: ["commonair_postgres-data"],
  walgPrefix: "s3://commonair-backups/wal",
};

describe("restore drill: containers", () => {
  test("names are the drill's own and never the stack's", () => {
    const names = drillNames("mz1abc9f0e1d");
    expect(names).toEqual({
      container: "commonair-drill-mz1abc9f0e1d",
      volume: "commonair-drill-mz1abc9f0e1d-pgdata",
    });
    expect(() => drillNames("../etc")).toThrow(RangeError);
    const prefix = drillPrefix("commonair-backups", "mz1abc9f0e1d");
    expect(prefix).toEqual({ url: "s3://commonair-backups/drill/mz1abc9f0e1d", key: "drill/mz1abc9f0e1d/" });
    expect(collisionProblems(names, prefix.url, STACK, { container: false, volume: false })).toEqual([]);
  });

  test("any collision with the stack or an existing name refuses the drill", () => {
    const names = drillNames("mz1abc9f0e1d");
    const ok = drillPrefix("commonair-backups", "mz1abc9f0e1d").url;
    expect(
      collisionProblems({ ...names, container: STACK.name }, ok, STACK, { container: false, volume: false }),
    ).toEqual(["drill container commonair_postgres_1 is the stack's Postgres container"]);
    expect(
      collisionProblems({ ...names, volume: "commonair_postgres-data" }, ok, STACK, {
        container: false,
        volume: false,
      }),
    ).toEqual(["drill volume commonair_postgres-data is mounted by the stack"]);
    expect(collisionProblems(names, ok, STACK, { container: true, volume: true })).toEqual([
      "container commonair-drill-mz1abc9f0e1d already exists",
      "volume commonair-drill-mz1abc9f0e1d-pgdata already exists",
    ]);
    expect(collisionProblems(names, "s3://commonair-backups/wal/", STACK, { container: false, volume: false })).toEqual(
      [
        "drill WAL-G prefix s3://commonair-backups/wal/ is the stack's",
        "drill WAL-G prefix s3://commonair-backups/wal/ is not under drill/",
      ],
    );
  });

  test("podman inspect parsing", () => {
    const json = JSON.stringify([
      {
        Id: "abc123",
        Name: "commonair_postgres_1",
        ImageName: "localhost/commonair/postgres:dev",
        Config: {
          Image: "ignored",
          Env: ["PGDATA=/var/lib/postgresql/data", "WALG_S3_PREFIX=s3://commonair-backups/wal"],
        },
        NetworkSettings: { Networks: { commonair_default: {} } },
        Mounts: [
          { Type: "volume", Name: "commonair_postgres-data", Destination: "/var/lib/postgresql/data" },
          { Type: "bind", Source: "/x", Destination: "/y" },
        ],
      },
    ]);
    expect(parseInspect(json)).toEqual(STACK);
    expect(() => parseInspect("[]")).toThrow(/nothing/);
  });

  test("run arguments carry no secret values and keep the server on loopback", () => {
    const names = drillNames("mz1abc9f0e1d");
    const args = runArgs({
      names,
      network: "commonair_default",
      image: STACK.image,
      prefixUrl: "s3://commonair-backups/drill/mz1abc9f0e1d",
      runId: "mz1abc9f0e1d",
      server: true,
    });
    for (const k of SECRET_ENV) {
      expect(args).toContain(k);
      expect(args.some((a) => a.startsWith(`${k}=`))).toBe(false);
    }
    expect(args).toContain("127.0.0.1::5432");
    expect(args).toContain(`${names.volume}:/var/lib/postgresql/data`);
    expect(args).toContain("WALG_S3_PREFIX=s3://commonair-backups/drill/mz1abc9f0e1d");
    const once = runArgs({
      names,
      network: "commonair_default",
      image: STACK.image,
      prefixUrl: "s3://commonair-backups/drill/mz1abc9f0e1d",
      runId: "mz1abc9f0e1d",
      server: false,
      command: ["commonair-restore"],
    });
    expect(once[0]).toBe("--rm");
    expect(once.at(-1)).toBe("commonair-restore");
    expect(once).not.toContain("--name");
  });

  test("ports, replayed segments and prefix sizes", () => {
    expect(parsePort("127.0.0.1:43211\n")).toBe(43211);
    expect(parsePort("0.0.0.0:5433\n[::]:5433\n")).toBe(5433);
    expect(() => parsePort("")).toThrow(/no published port/);
    const logs = [
      'LOG:  restored log file "000000010000000000000003" from archive',
      'LOG:  restored log file "000000010000000000000004" from archive',
      'LOG:  restored log file "000000010000000000000004" from archive',
      "LOG:  database system is ready to accept connections",
    ].join("\n");
    expect(countReplayedSegments(logs)).toBe(2);
    expect(countReplayedSegments("")).toBe(0);
    expect(
      prefixStats(
        [
          { key: "drill/r1/basebackups_005/base_000/tar_partitions/part_1.tar.zst", size: 1000 },
          { key: "drill/r1/basebackups_005/base_000_backup_stop_sentinel.json", size: 24 },
          { key: "drill/r1/wal_005/000000010000000000000003.zst", size: 50 },
          { key: "drill/r2/basebackups_005/other.tar", size: 999 },
        ],
        "drill/r1/",
      ),
    ).toEqual({ backupBytes: 1024, walObjects: 1 });
  });
});
