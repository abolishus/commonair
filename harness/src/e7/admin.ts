// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `e7-admin` scenario's helpers (docs/testing/e7-selectors.md, "Egress", "Incidents",
 * "Integrity"): pure checks the unit tests cover, the page drivers for `/admin/egress`,
 * `/admin/incidents` and `/admin/integrity` (test ids only), and the database touches with
 * `DATABASE_URL` (the stack's owner connection): seeding a `pending_review` integrity flag the
 * scorer would not write on its own, and reading back the flag and audit rows. Nothing personal is
 * read or written: ids, enums and the admin's own reason text.
 */
import { createDb, uuidv7 } from "@commonair/db";
import type { Page } from "playwright";
import { waitFor } from "../wait.ts";
import { E7_ID_PATTERNS, E7_TEST_IDS as E, byE7Id } from "./selectors.ts";

// ── Pure ────────────────────────────────────────────────────────────────────────────────────

/** A `datetime-local` value showing `d` in UTC, to the minute (the egress page reads its inputs as UTC). */
export function utcInput(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/**
 * An egress range that surely contains the scenario's own samples: from `minutesBack` before the
 * broadcast started to one minute after now (buckets are minute starts; the end is exclusive).
 */
export function egressRange(
  startedAt: Date,
  now: Date,
  minutesBack = 5,
): { from: Date; to: Date; fromInput: string; toInput: string } {
  const from = new Date(Math.floor(startedAt.getTime() / 60_000) * 60_000 - minutesBack * 60_000);
  const to = new Date(Math.ceil(now.getTime() / 60_000) * 60_000 + 60_000);
  return { from, to, fromInput: utcInput(from), toInput: utcInput(to) };
}

/** A `data-*` byte count (non-negative integer), or null when the attribute is missing or malformed. */
export function bytesAttr(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** The first id in `after` that was not in `before` (a row the scenario just created). */
export function newId(before: readonly string[], after: readonly string[]): string | null {
  return after.find((id) => !before.includes(id)) ?? null;
}

export interface StatusLike {
  components: readonly { id: string; status: string }[];
  incidents: readonly { id: string; status: string; components: readonly string[]; resolvedAt: string | null }[];
}

/** What `instance.status` says about one incident and one component. */
export function incidentOnStatus(
  status: StatusLike,
  incidentId: string,
  componentId: string,
): { listed: boolean; incidentStatus: string | null; resolved: boolean; component: string | null } {
  const i = status.incidents.find((x) => x.id === incidentId);
  const c = status.components.find((x) => x.id === componentId);
  return {
    listed: i !== undefined,
    incidentStatus: i?.status ?? null,
    resolved: typeof i?.resolvedAt === "string",
    component: c?.status ?? null,
  };
}

/** An open incident marks its components at least degraded (an outage stays an outage). */
export const notOperational = (component: string | null): boolean => component === "degraded" || component === "outage";

// ── Database (owner connection) ─────────────────────────────────────────────────────────────

async function withDb<T>(databaseUrl: string, fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

/** The signal the seeded flag carries: a network signal, so its details are numbers and a label only. */
export const SEEDED_SIGNAL = "datacenter_ip";

/** Seed a `pending_review` flag on a playback session (as an operator-list match would explain it). */
export async function seedPendingFlag(
  databaseUrl: string,
  input: { sessionId: string; channelId: string },
): Promise<string> {
  return withDb(databaseUrl, async (sql) => {
    const details = { network: "hosting:harness-e7-admin", asn: 64512 };
    const [row] = await sql<{ id: string }[]>`
      insert into integrity_flags (id, subject_type, subject_id, channel_id, signal, score, details, decision)
      values (${uuidv7()}, 'session', ${input.sessionId}, ${input.channelId}, ${SEEDED_SIGNAL}, 0.6,
              ${JSON.stringify(details)}::jsonb, 'pending_review')
      returning id`;
    if (!row) throw new Error("integrity flag insert returned no row");
    return row.id;
  });
}

export interface FlagState {
  decision: string | null;
  decidedById: string | null;
  decided: boolean;
}

export async function flagState(databaseUrl: string, flagId: string): Promise<FlagState> {
  return withDb(databaseUrl, async (sql) => {
    const [r] = await sql<{ decision: string; decided_by_id: string | null; decided_at: Date | null }[]>`
      select decision::text as decision, decided_by_id, decided_at from integrity_flags where id = ${flagId}`;
    return {
      decision: r?.decision ?? null,
      decidedById: r?.decided_by_id ?? null,
      decided: r?.decided_at !== null && r?.decided_at !== undefined,
    };
  });
}

export interface AuditRow {
  action: string;
  actorType: string;
  actorId: string | null;
  reason: string;
  details: Record<string, unknown>;
}

/** Audit rows about one subject, oldest first. */
export async function auditRows(databaseUrl: string, subjectId: string): Promise<AuditRow[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<
      {
        action: string;
        actor_type: string;
        actor_id: string | null;
        reason: string;
        details: Record<string, unknown>;
      }[]
    >`
      select action, actor_type::text as actor_type, actor_id, reason, details from audit_log
       where subject_id = ${subjectId} order by created_at, id`;
    return rows.map((r) => ({
      action: r.action,
      actorType: r.actor_type,
      actorId: r.actor_id,
      reason: r.reason,
      details: r.details,
    }));
  });
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────

export interface UiBudget {
  timeoutMs: number;
  signal: AbortSignal;
}

/** `/admin/egress`: set the range, load, and read the broadcast's row (null while it has none). */
export async function egressRowOnPage(
  page: Page,
  range: { fromInput: string; toInput: string },
  broadcastId: string,
  b: UiBudget,
): Promise<{ origin: number; relay: number; p2p: number; cdn: number } | null> {
  const ui = { timeout: b.timeoutMs };
  await byE7Id(page, E.egress).waitFor(ui);
  await byE7Id(page, E.egressFrom).fill(range.fromInput, ui);
  await byE7Id(page, E.egressTo).fill(range.toInput, ui);
  await byE7Id(page, E.egressLoad).click(ui);
  const row = byE7Id(page, E.egressRow, { "broadcast-id": broadcastId });
  const settled = await waitFor(
    "egress report",
    async () => {
      if (await row.count()) return "row";
      if (await byE7Id(page, E.egressError).count()) return "error";
      if (await byE7Id(page, E.egressEmpty).count()) return "empty";
      // Rows for other broadcasts but not this one yet.
      if (await byE7Id(page, E.egressRow).count()) return "other";
      return null;
    },
    { timeoutMs: b.timeoutMs, intervalMs: 250, signal: b.signal },
  );
  if (settled === "error") throw new Error("egress page shows egress-error");
  if (settled !== "row") return null;
  const attr = async (name: string) => bytesAttr(await row.first().getAttribute(`data-${name}`));
  const [origin, relay, p2p, cdn] = await Promise.all([attr("origin"), attr("relay"), attr("p2p"), attr("cdn")]);
  if (origin === null || relay === null || p2p === null || cdn === null) throw new Error("egress-row bytes unreadable");
  return { origin, relay, p2p, cdn };
}

const E_ID = (status: string) => E7_ID_PATTERNS.incidentStatus.id(status);

async function incidentIds(page: Page): Promise<string[]> {
  const rows = byE7Id(page, E.incidentRow);
  const ids: string[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const id = await rows.nth(i).getAttribute("data-incident-id");
    if (id) ids.push(id);
  }
  return ids;
}

async function waitIncidentsLoaded(page: Page, b: UiBudget): Promise<void> {
  await waitFor(
    "incidents list",
    async () => (await byE7Id(page, E.incidentsEmpty).count()) + (await byE7Id(page, E.incidentRow).count()) > 0,
    { timeoutMs: b.timeoutMs, intervalMs: 200, signal: b.signal },
  );
}

/** `/admin/incidents`: open a new incident with the form; resolves with its id. */
export async function openIncidentOnPage(
  page: Page,
  input: { title: string; components: readonly string[]; body: string },
  b: UiBudget,
): Promise<string> {
  const ui = { timeout: b.timeoutMs };
  await waitIncidentsLoaded(page, b);
  const before = await incidentIds(page);
  await byE7Id(page, E.incidentNew).click(ui);
  const form = byE7Id(page, E.incidentForm);
  await form.waitFor(ui);
  await byE7Id(form, E.incidentTitle).fill(input.title, ui);
  await byE7Id(form, E_ID("investigating")).click(ui);
  await byE7Id(form, E.incidentComponents).fill(input.components.join("\n"), ui);
  await byE7Id(form, E.incidentBody).fill(input.body, ui);
  await byE7Id(form, E.incidentSubmit).click(ui);
  return waitFor("the new incident row", async () => newId(before, await incidentIds(page)), {
    timeoutMs: b.timeoutMs,
    intervalMs: 250,
    signal: b.signal,
  });
}

/** `/admin/incidents`: resolve an incident through its edit form and the confirmation dialog. */
export async function resolveIncidentOnPage(page: Page, incidentId: string, b: UiBudget): Promise<void> {
  const ui = { timeout: b.timeoutMs };
  await waitIncidentsLoaded(page, b);
  const row = byE7Id(page, E.incidentRow, { "incident-id": incidentId });
  await byE7Id(row, E.incidentEdit).click(ui);
  const form = byE7Id(page, E.incidentForm);
  await form.waitFor(ui);
  await byE7Id(form, E_ID("resolved")).click(ui);
  await byE7Id(form, E.incidentSubmit).click(ui);
  // Resolving asks for confirmation (the shared ConfirmDialog test id).
  await page.locator('[data-testid="confirm-dialog-confirm"]').click(ui);
  await byE7Id(page, E.incidentRow, { "incident-id": incidentId, status: "resolved" }).waitFor(ui);
}

/**
 * `/admin/integrity`: list the channel's pending-review flags (the seeded flag's decision; also the
 * page default, and re-clicking a chosen toggle keeps it), then decide one flag with a reason. The
 * decided card stays listed with its new decision until the list loads again.
 */
export async function decideFlagOnPage(
  page: Page,
  input: { flagId: string; channel: string; decision: "allowed" | "excluded"; reason: string },
  b: UiBudget,
): Promise<void> {
  const ui = { timeout: b.timeoutMs };
  await byE7Id(page, E.integrityq).waitFor(ui);
  await byE7Id(page, E7_ID_PATTERNS.integrityqDecision.id("pending_review")).click(ui);
  await byE7Id(page, E.integrityqChannel).fill(input.channel, ui);
  const item = byE7Id(page, E.integrityqItem, { "flag-id": input.flagId });
  await item.waitFor(ui);
  const decide = byE7Id(item, E.integrityqDecide);
  await byE7Id(decide, input.decision === "allowed" ? E.integrityqDecideAllowed : E.integrityqDecideExcluded).click(ui);
  await byE7Id(decide, E.integrityqReason).fill(input.reason, ui);
  await byE7Id(decide, E.integrityqSubmit).click(ui);
  await byE7Id(page, E.integrityqItem, { "flag-id": input.flagId, decision: input.decision }).waitFor(ui);
}
