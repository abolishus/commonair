// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The W2 job stubs are registered on their queues (batch 6 contract step §5). */
import { ANALYTICS_JOBS, QUEUES, REHEARSAL_JOBS, analyticsJobId } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { buildRegistry, scheduledJobs } from "../src/runtime/registry.ts";
import { rehearsalDriverJobId } from "../src/w2/outbox-jobs.ts";

describe("W2 jobs", () => {
  const reg = buildRegistry(JOBS);

  test("every analytics and rehearsal job has a handler", () => {
    expect([...(reg.get(QUEUES.analytics)?.keys() ?? [])].sort()).toEqual(Object.values(ANALYTICS_JOBS).sort());
    expect([...(reg.get(QUEUES.rehearsal)?.keys() ?? [])]).toEqual([REHEARSAL_JOBS.driver]);
  });

  test("the attestation reconciler runs daily; the per-broadcast jobs are event-driven", () => {
    const scheduled = scheduledJobs(reg).filter((j) => j.queue === QUEUES.analytics || j.queue === QUEUES.rehearsal);
    expect(scheduled.map((j) => [j.name, j.schedule])).toEqual([
      [ANALYTICS_JOBS.attestationReconcile, { pattern: "41 4 * * *" }],
    ]);
  });

  test("payloads are the contract's", () => {
    const rollup = reg.get(QUEUES.analytics)?.get(ANALYTICS_JOBS.broadcastRollup);
    expect(rollup?.data.safeParse({ broadcastId: crypto.randomUUID(), reason: "offline" }).success).toBe(true);
    expect(rollup?.data.safeParse({ broadcastId: crypto.randomUUID(), reason: "later" }).success).toBe(false);
    const driver = reg.get(QUEUES.rehearsal)?.get(REHEARSAL_JOBS.driver);
    expect(driver?.data.safeParse({ armId: crypto.randomUUID(), channelId: crypto.randomUUID() }).success).toBe(true);
  });

  test("job ids are ones BullMQ accepts (no colon, or exactly three parts)", () => {
    const id = crypto.randomUUID();
    expect(analyticsJobId(ANALYTICS_JOBS.broadcastRollup, id, "offline").split(":")).toHaveLength(3);
    expect(analyticsJobId(ANALYTICS_JOBS.integrityAttestation, id, `recheck-${id}`).split(":")).toHaveLength(3);
    expect(rehearsalDriverJobId(id)).not.toContain(":");
  });
});
