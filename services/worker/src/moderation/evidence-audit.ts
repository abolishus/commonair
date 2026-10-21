// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Daily evidence audit (ADR 0006 Q4, e4c spec "Evidence audit"). Bucket objects are re-read and
 * the sha256 of their sealed bytes compared with the digest in their key (the worker cannot open
 * them). Inline objects are checked in Postgres: the seal header (magic, version, key id) and the
 * length. A missing or changed object records an `evidence_audit_runs` row with the ids, an
 * `incidents` row and a `fatal` log with ids only. On Garage this detects loss, it cannot prevent it.
 */
import { schema, uuidv7 } from "@commonair/db";
import { SEAL_OVERHEAD_BYTES } from "@commonair/moderation";
import { asc, eq, gt, and } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { readObject, sealedDigestOf, sha256Hex } from "./objects.ts";
import { alert, audit } from "./records.ts";
import { moderationRuntime } from "./runtime.ts";

const { evidenceObjects: ev, evidenceAuditRuns: runs, incidents } = schema;
const MAGIC_HEX = "4341455601"; // "CAEV" + version 1

export type CheckResult = "ok" | "missing" | "mismatched";

/** Compare an object's bytes (or their absence) with the digest recorded in its key. Pure. */
export function diffBucketObject(key: string, actualSha256: string | null): CheckResult {
  if (actualSha256 === null) return "missing";
  const expected = sealedDigestOf(key);
  return expected !== null && expected === actualSha256 ? "ok" : "mismatched";
}

/** An inline row: sealed header matches its key id and the length fits the recorded size. Pure. */
export function diffInlineObject(row: { headerHex: string; length: number; sizeBytes: number; keyId: string }) {
  const headerOk = row.headerHex === `${MAGIC_HEX}${row.keyId}`;
  // `size_bytes` is the plaintext size (sealing adds exactly SEAL_OVERHEAD_BYTES); a producer that
  // recorded the sealed size is tolerated, since both are fixed at insert by the append-only row.
  const lengthOk = row.length === row.sizeBytes + SEAL_OVERHEAD_BYTES || row.length === row.sizeBytes;
  return headerOk && lengthOk ? "ok" : "mismatched";
}

export interface AuditSummary {
  runId: string;
  checked: number;
  missing: string[];
  mismatched: string[];
  incidentId: string | null;
}

export async function runEvidenceAudit(ctx: WorkerContext, batch = 500): Promise<AuditSummary> {
  const rt = moderationRuntime(ctx);
  const runId = uuidv7();
  await ctx.db.insert(runs).values({ id: runId, startedAt: ctx.now() });
  const missing: string[] = [];
  const mismatched: string[] = [];
  let checked = 0;

  // Bucket objects, paged by id.
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await ctx.db
      .select({ id: ev.id, key: ev.storageKey })
      .from(ev)
      .where(and(eq(ev.storage, "bucket"), gt(ev.id, after)))
      .orderBy(asc(ev.id))
      .limit(batch);
    if (page.length === 0) break;
    for (const o of page) {
      const bytes = o.key ? await readObject(rt.evidenceStorage, rt.evidenceBucket, o.key) : null;
      const r = diffBucketObject(o.key ?? "", bytes ? await sha256Hex(bytes) : null);
      checked++;
      moderationMetrics.audit.add(1, { result: r, storage: "bucket" });
      if (r === "missing") missing.push(o.id);
      if (r === "mismatched") mismatched.push(o.id);
    }
    after = page[page.length - 1]!.id;
  }

  // Inline objects, checked by the database itself.
  const inline = await ctx.sql<{ id: string; header_hex: string; length: number; size_bytes: number; key_id: string }[]>`
    select id, encode(substring(sealed from 1 for 21), 'hex') as header_hex,
           octet_length(sealed) as length, size_bytes, key_id
      from evidence_objects where storage = 'inline'`;
  for (const row of inline) {
    const r = diffInlineObject({
      headerHex: row.header_hex,
      length: Number(row.length),
      sizeBytes: row.size_bytes,
      keyId: row.key_id,
    });
    checked++;
    moderationMetrics.audit.add(1, { result: r, storage: "inline" });
    if (r === "mismatched") mismatched.push(row.id);
  }

  let incidentId: string | null = null;
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    if (missing.length + mismatched.length > 0) {
      incidentId = uuidv7(now.getTime());
      await tx.insert(incidents).values({
        id: incidentId,
        title: "Evidence integrity check failed",
        status: "investigating",
        components: ["evidence"],
        body: `The daily evidence audit (run ${runId}) found ${missing.length} missing and ${mismatched.length} changed objects.`,
        startedAt: now,
      });
    }
    await tx
      .update(runs)
      .set({ finishedAt: now, checked, missing, mismatched, incidentId })
      .where(eq(runs.id, runId));
    await audit(
      tx,
      {
        action: "evidence.audit",
        subjectType: "evidence_audit_run",
        subjectId: runId,
        details: { runId, checked, missing, mismatched, incidentId },
      },
      now,
    );
  });
  if (incidentId)
    alert(
      ctx,
      "evidence_audit_failed",
      "evidence objects are missing or changed",
      { runId, incidentId, missing, mismatched, checked },
      "fatal",
    );
  else ctx.logger.info("evidence audit passed", { runId, checked });
  return { runId, checked, missing, mismatched, incidentId };
}
