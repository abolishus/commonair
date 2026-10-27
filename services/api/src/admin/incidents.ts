// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.incidents`: open or update a status-page incident. `instance.status` reads the
 * `incidents` table directly (open ones mark their components degraded), so there is no outbox
 * event; a write drops this process's cached status so it shows at once. The audit row carries ids and enums only, never the title or body.
 */
import { eq } from "drizzle-orm";
import type { INCIDENT_STATUSES } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { invalidateStatus } from "../routes/instance.ts";

type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * The component ids `instance.status` reports: its own `postgres` and `valkey` probes plus
 * `deps.probes` (mirrors `computeStatus` in routes/instance.ts).
 */
export function statusComponentIds(probes: Record<string, unknown>): string[] {
  return [...new Set(["postgres", "valkey", ...Object.keys(probes)])];
}

/** Trimmed, de-duplicated component ids; any id the status page does not know → BAD_REQUEST. */
export function checkComponents(components: readonly string[], known: readonly string[]): string[] {
  const ids = [...new Set(components.map((c) => c.trim()).filter((c) => c !== ""))];
  const unknown = ids.filter((c) => !known.includes(c));
  if (unknown.length > 0) throw badRequest(`Unknown status components: ${unknown.join(", ")}`);
  return ids;
}

/** `resolved_at` after a write: set once on resolve (kept on later edits), cleared on reopen. */
export function nextResolvedAt(status: IncidentStatus, current: Date | null, now: Date): Date | null {
  if (status !== "resolved") return null;
  return current ?? now;
}

/** The audit action for a write (`created` = no id given). */
export function incidentAction(
  created: boolean,
  from: IncidentStatus | null,
  to: IncidentStatus,
): "incident.open" | "incident.update" | "incident.resolve" {
  if (created) return "incident.open";
  if (to === "resolved" && from !== "resolved") return "incident.resolve";
  return "incident.update";
}

export interface IncidentInput {
  id?: string | undefined;
  title: string;
  status: IncidentStatus;
  components: string[];
  body: string;
}

export async function writeIncident(deps: Deps, actorId: string, input: IncidentInput): Promise<{ id: string }> {
  const components = checkComponents(input.components, statusComponentIds(deps.probes));
  const now = deps.now();
  const written = await deps.db.transaction(async (tx) => {
    const { incidents } = schema;
    let id: string;
    let from: IncidentStatus | null = null;
    if (input.id === undefined) {
      const [row] = await tx
        .insert(incidents)
        .values({
          title: input.title,
          status: input.status,
          components,
          body: input.body,
          startedAt: now,
          resolvedAt: nextResolvedAt(input.status, null, now),
        })
        .returning({ id: incidents.id });
      if (!row) throw new Error("incident insert returned no row");
      id = row.id;
    } else {
      const [current] = await tx.select().from(incidents).where(eq(incidents.id, input.id)).for("update");
      if (!current) throw notFound("Incident not found");
      from = current.status;
      id = current.id;
      await tx
        .update(incidents)
        .set({
          title: input.title,
          status: input.status,
          components,
          body: input.body,
          resolvedAt: nextResolvedAt(input.status, current.resolvedAt, now),
        })
        .where(eq(incidents.id, id));
    }
    await audit(tx, {
      actorType: "admin",
      actorId,
      action: incidentAction(input.id === undefined, from, input.status),
      subjectType: "incident",
      subjectId: id,
      details: { id, status: input.status, components },
    });
    return { id };
  });
  // After commit: the next status read sees the write instead of a cached page.
  invalidateStatus(deps);
  return written;
}
