// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The backup/restore drill (docs/testing/e6-selectors.md, ADR 0021 §3): a throwaway Postgres
 * from the stack's image on the compose network, with its own volume and its own WAL-G prefix,
 * is migrated, seeded, fingerprinted, backed up, given one more transaction (the WAL-replay
 * marker), wiped, restored and checked. The stack's own container, volume and prefix are never
 * touched; cleanup removes only what the drill created.
 */
import { createDb, runMigrations } from "@commonair/db";
import { createS3Storage } from "@commonair/storage";
import type { ScenarioContext } from "../scenario.ts";
import { waitFor } from "../wait.ts";
import {
  type Fingerprint,
  type Marker,
  collectFingerprint,
  compareFingerprints,
  missingRequired,
} from "./fingerprint.ts";
import {
  APP_ROLE,
  DRILL_DB,
  DRILL_OWNER,
  FALLBACK_IMAGE,
  type DrillNames,
  collisionProblems,
  countReplayedSegments,
  drillNames,
  drillPrefix,
  exists,
  findStackPostgres,
  parsePort,
  podman,
  podmanOk,
  prefixStats,
  runArgs,
} from "./podman.ts";
import {
  DRILL_POSTINGS,
  REPO_ROOT,
  postDrillLedger,
  postMarker,
  refusalChecks,
  refusalProblems,
  seedDemoAsAppRole,
} from "./seed.ts";

const READY_TIMEOUT_MS = 180_000;
const ARCHIVE_TIMEOUT_MS = 120_000;
const PROMOTE_TIMEOUT_MS = 300_000;

const secret = () => `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

function dbUrl(user: string, password: string, port: number): string {
  const u = new URL(`postgres://127.0.0.1:${port}/${DRILL_DB}`);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Connect and run `probe` until it answers (the server accepts TCP only once init is done). */
async function waitForSql<T>(
  url: string,
  what: string,
  probe: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T | null>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return waitFor(
    what,
    async () => {
      const h = createDb({ url, max: 1, applicationName: "commonair-drill" });
      try {
        return await probe(h.sql);
      } catch {
        return null;
      } finally {
        await h.close().catch(() => undefined);
      }
    },
    { timeoutMs, intervalMs: 1_000, signal },
  );
}

async function withOwner<T>(url: string, fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>): Promise<T> {
  const h = createDb({ url, max: 1, applicationName: "commonair-drill" });
  try {
    return await fn(h.sql);
  } finally {
    await h.close();
  }
}

export interface DrillResult {
  before: Fingerprint;
  after: Fingerprint;
  marker: Marker;
  backupBytes: number;
  walObjects: number;
  restoreFetchMs: number;
  restoreToPromotedMs: number;
  walSegmentsReplayed: number;
}

export async function runDrill(ctx: ScenarioContext): Promise<DrillResult> {
  const env = ctx.env;
  const bucket = process.env.S3_BUCKET_BACKUPS?.trim() || "commonair-backups";
  const s3 = {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION ?? "garage",
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
  ctx.assert(
    "S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set (run from the repo root so Bun loads .env)",
    Boolean(s3.endpoint && s3.accessKeyId && s3.secretAccessKey),
  );
  const storage = createS3Storage({
    endpoint: s3.endpoint as string,
    region: s3.region,
    accessKeyId: s3.accessKeyId as string,
    secretAccessKey: s3.secretAccessKey as string,
    forcePathStyle: true,
  });

  const names: DrillNames = drillNames(ctx.runId);
  const prefix = drillPrefix(bucket, ctx.runId);
  const stack = await ctx.step("find the stack's Postgres (read only)", () => findStackPostgres());
  const image = stack.image || FALLBACK_IMAGE;
  const network = stack.networks[0];
  ctx.assert("the stack's Postgres is on a compose network", network !== undefined, { networks: stack.networks });
  if (network === undefined) throw new Error("unreachable");
  ctx.data("drill", { container: names.container, volume: names.volume, prefix: prefix.url, image, network });

  const collisions = await ctx.step("refuse names the stack uses or that already exist", async () =>
    collisionProblems(names, prefix.url, stack, {
      container: await exists("container", names.container),
      volume: await exists("volume", names.volume),
    }),
  );
  ctx.assert("the drill touches nothing of the running stack", collisions.length === 0, collisions);

  // Secrets reach podman through its environment only (bare `-e NAME` in the arguments).
  const ownerPassword = secret();
  const appPassword = secret();
  const podmanEnv = {
    POSTGRES_PASSWORD: ownerPassword,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
  };
  const serverArgs = runArgs({ names, network, image, prefixUrl: prefix.url, runId: ctx.runId, server: true });

  // Cleanup, registered before anything is created; it removes only the drill's own names.
  ctx.defer(async () => {
    await podman(["rm", "-f", "-t", "5", names.container]);
    await podman(["volume", "rm", "-f", names.volume]);
    const deleted = await storage.deletePrefix(bucket, prefix.key).catch((err: unknown) => {
      ctx.log.warn("drill prefix cleanup failed", { error: (err as Error).message });
      return -1;
    });
    ctx.log.info("drill cleaned up", { container: names.container, objectsDeleted: deleted });
  });

  const startServer = async (): Promise<number> => {
    await podmanOk(["run", ...serverArgs], { env: podmanEnv });
    return parsePort(await podmanOk(["port", names.container, "5432/tcp"]));
  };

  // 1. Start.
  const port1 = await ctx.step("start the drill Postgres (own volume, own WAL-G prefix)", async () => {
    await podmanOk(["volume", "create", names.volume]);
    return startServer();
  });
  const ownerUrl1 = dbUrl(DRILL_OWNER, ownerPassword, port1);
  const appUrl1 = dbUrl(APP_ROLE, appPassword, port1);
  await ctx.step("drill Postgres accepts connections", () =>
    waitForSql(
      ownerUrl1,
      "drill Postgres ready",
      async (sql) => (await sql`select 1 as ok`).length,
      READY_TIMEOUT_MS,
      ctx.signal,
    ),
  );

  // 2. Migrate and seed.
  await ctx.step("migrate as the owner", () => runMigrations(ownerUrl1, { seedLegal: true }));
  await ctx.step("configure the app role", async () => {
    const proc = Bun.spawn(["bun", "infra/postgres/apply-app-role.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: ownerUrl1, POSTGRES_APP_PASSWORD: appPassword },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`apply-app-role failed (${code}): ${err.trim().split("\n").slice(-2).join(" | ")}`);
  });
  await ctx.step("demo seed as the app role", () => seedDemoAsAppRole(appUrl1));
  const seeded = await ctx.step(`post ${DRILL_POSTINGS} balanced ledger transactions as the app role`, () =>
    postDrillLedger(appUrl1, ctx.runId),
  );
  ctx.assert(`${DRILL_POSTINGS} ledger transactions posted`, new Set(seeded).size === DRILL_POSTINGS, {
    posted: seeded.length,
  });

  // 3. Fingerprint.
  const before = await ctx.step("fingerprint before the backup", () =>
    withOwner(ownerUrl1, (sql) => collectFingerprint(sql, APP_ROLE)),
  );
  const missing = missingRequired(before);
  ctx.assert("the migrated database has every required protection", missing.length === 0, missing);
  ctx.assert("the seeded ledger balances", before.imbalances.length === 0, before.imbalances);
  ctx.metric("fingerprint.triggers", before.triggers.length);
  ctx.metric("fingerprint.functions", before.functions.length);
  ctx.metric("fingerprint.grants", before.grants.length);

  // 4. Backup, then the marker and a WAL switch.
  await ctx.step("commonair-backup", () =>
    podmanOk(["exec", names.container, "commonair-backup"], { timeoutMs: 600_000 }),
  );
  const marker = await ctx.step("post the WAL-replay marker as the app role", () => postMarker(appUrl1, ctx.runId));
  await ctx.step("switch WAL and wait until the segment is archived", () =>
    withOwner(ownerUrl1, async (sql) => {
      const [row] = await sql<{ seg: string }[]>`select pg_walfile_name(pg_switch_wal()) as seg`;
      const segment = row?.seg;
      if (!segment) throw new Error("pg_switch_wal returned nothing");
      await waitFor(
        `WAL segment ${segment} archived`,
        async () => {
          const [s] = await sql<{ last: string | null }[]>`select last_archived_wal as last from pg_stat_archiver`;
          // Same timeline: segment names order lexically.
          return s?.last && s.last >= segment ? s.last : null;
        },
        { timeoutMs: ARCHIVE_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
      );
      return segment;
    }),
  );
  const objects = await ctx.step("list the drill prefix", async () => {
    const list: { key: string; size: number }[] = [];
    for await (const o of storage.list(bucket, prefix.key)) list.push({ key: o.key, size: o.size });
    return list;
  });
  const stats = prefixStats(objects, prefix.key);
  ctx.assert("a base backup was uploaded under the drill prefix", stats.backupBytes > 0, stats);

  // 5. Stop, wipe, restore, start.
  await ctx.step("stop the drill Postgres and wipe its volume", async () => {
    await podmanOk(["stop", "-t", "30", names.container], { timeoutMs: 120_000 });
    await podmanOk(["rm", names.container]);
    await podmanOk(["volume", "rm", names.volume]);
    await podmanOk(["volume", "create", names.volume]);
  });
  const restoreStarted = performance.now();
  await ctx.step("commonair-restore into the empty volume", () =>
    podmanOk(
      [
        "run",
        ...runArgs({
          names,
          network,
          image,
          prefixUrl: prefix.url,
          runId: ctx.runId,
          server: false,
          command: ["commonair-restore"],
        }),
      ],
      { env: podmanEnv, timeoutMs: 600_000 },
    ),
  );
  const restoreFetchMs = performance.now() - restoreStarted;
  const port2 = await ctx.step("start Postgres on the restored data", () => startServer());
  const ownerUrl2 = dbUrl(DRILL_OWNER, ownerPassword, port2);
  const appUrl2 = dbUrl(APP_ROLE, appPassword, port2);
  await ctx.step("WAL replay finishes and the server is promoted", () =>
    waitForSql(
      ownerUrl2,
      "restored Postgres promoted",
      async (sql) => {
        const [r] = await sql<{ recovering: boolean }[]>`select pg_is_in_recovery() as recovering`;
        return r && !r.recovering ? true : null;
      },
      PROMOTE_TIMEOUT_MS,
      ctx.signal,
    ),
  );
  const restoreToPromotedMs = performance.now() - restoreStarted;
  const logs = await podman(["logs", names.container]);
  const walSegmentsReplayed = countReplayedSegments(`${logs.stdout}\n${logs.stderr}`);

  // 6. Check.
  const after = await ctx.step("fingerprint after the restore", () =>
    withOwner(ownerUrl2, (sql) => collectFingerprint(sql, APP_ROLE, [marker.transactionId])),
  );
  const problems = compareFingerprints(before, after, marker);
  ctx.assert(
    "the restore matches the backup plus the marker (triggers, functions, grants, rows, ledger)",
    problems.length === 0,
    problems,
  );
  ctx.assert("every ledger transaction sums to 0 after the restore", after.imbalances.length === 0, after.imbalances);
  const refusals = await ctx.step("the app role is refused every protected write", () => refusalChecks(appUrl2));
  ctx.data("refusals", refusals);
  const refused = refusalProblems(refusals);
  ctx.assert(
    "UPDATE/DELETE on ledger_entries and audit_log, an unbalanced posting and a direct passed proposal are refused",
    refused.length === 0,
    refused,
  );

  ctx.metric("backup.bytes", stats.backupBytes, "bytes");
  ctx.metric("backup.wal_objects", stats.walObjects);
  ctx.metric("restore.fetch", restoreFetchMs, "ms");
  ctx.metric("restore.to_promoted", restoreToPromotedMs, "ms");
  ctx.metric("restore.wal_segments_replayed", walSegmentsReplayed);
  ctx.check("WAL segments were replayed from the archive", walSegmentsReplayed > 0, { walSegmentsReplayed });
  return {
    before,
    after,
    marker,
    backupBytes: stats.backupBytes,
    walObjects: stats.walObjects,
    restoreFetchMs,
    restoreToPromotedMs,
    walSegmentsReplayed,
  };
}
