// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 11: statements of reasons (ADR 0019, docs/testing/w0-selectors.md,
 * "Statements of reasons" and "Scenarios"). Runs after steps 4–7 (T2 label, T1 restriction,
 * upload rejection, NCII), whose audit actions it checks: every allowlisted action on the run's
 * users and channels has a statement for each expected recipient within 60 s, matching the
 * selectors table; `me.enforcement.list` returns it to the recipient and not to another user;
 * the statement email arrived; a channel moderator's ban and timeout produce none; the owner
 * cannot rewrite a statement. With `via=web` the recipient's `/settings/appeals` shows it.
 *
 * The recipients are the streamers steps 4–7 created; the run keeps only their addresses, so
 * this step signs them in with a magic link from Mailpit (the platform's own sign-in path).
 * Reads use `DATABASE_URL` (the owner connection, as the other trust-safety checks); nothing is
 * written there except inside a transaction that is always rolled back.
 */
import { AUTH_BASE_PATH } from "@commonair/contracts/auth";
import { ENFORCEMENT_SOURCE_ACTIONS } from "@commonair/contracts/enums";
import { createDb } from "@commonair/db";
import type { Api } from "./api/client.ts";
import { findTokenLink } from "./mailpit.ts";
import { type Run, API_SETTLE_MS, UI_TIMEOUT_MS, newStreamer, title } from "./safety-run.ts";
import { verificationHop } from "./users.ts";
import { waitFor } from "./wait.ts";

/** Art. 17 is "at the latest when the restriction applies"; the builder runs every 15 s. */
export const STATEMENT_WAIT_MS = 60_000;
/** Long enough for several builder runs: a statement that was going to appear has. */
const NO_STATEMENT_WAIT_MS = 35_000;

type SourceAction = (typeof ENFORCEMENT_SOURCE_ACTIONS)[number];

export interface AuditRow {
  id: string;
  action: string;
  details: Record<string, unknown>;
}

export interface StatementRow {
  id: string;
  sourceAuditId: string;
  sourceAction: string;
  recipientUserId: string;
  restrictionKind: string;
  restrictionDetail: string;
  clauseId: string;
  appealSubjectType: string | null;
}

export interface Expected {
  /** Allowed `restriction_kind/restriction_detail` pairs. */
  restrictions: readonly string[];
  clauseIds: readonly string[] | "any";
  appealSubjectType: string | null;
}

const CATEGORY_CLAUSES: Record<string, string> = {
  sexual: "safety.sexual-explicit",
  graphic_violence: "safety.graphic-violence",
  weapons: "safety.weapons",
  self_harm: "safety.self-harm",
};

/**
 * What the selectors table says an audit row's statements look like, or null when it produces
 * none (`ncii.decide` rejected, a CSAM-list T0 match). Pure, so the harness tests check it
 * against the table.
 */
export function expectedStatement(row: AuditRow): Expected | null {
  if (!(ENFORCEMENT_SOURCE_ACTIONS as readonly string[]).includes(row.action)) return null;
  const d = row.details;
  const category = typeof d.category === "string" ? CATEGORY_CLAUSES[d.category] : undefined;
  switch (row.action as SourceAction) {
    case "moderation.t1.restrict":
      return {
        restrictions: ["visibility/restricted"],
        clauseIds: category ? [category] : "any",
        appealSubjectType: "moderation_case",
      };
    case "moderation.t2.label":
      return {
        restrictions: ["visibility/age_gated"],
        clauseIds: ["mature.unlabelled"],
        appealSubjectType: "content_label",
      };
    case "moderation.t1.upload_reject":
      return {
        restrictions: ["visibility/removed"],
        clauseIds: category ? [category] : "any",
        appealSubjectType: "moderation_case",
      };
    case "moderation.case.warn":
      return { restrictions: ["warning/none"], clauseIds: "any", appealSubjectType: "moderation_case" };
    case "moderation.case.end_stream":
      return { restrictions: ["visibility/removed"], clauseIds: "any", appealSubjectType: "moderation_case" };
    case "moderation.case.suspend":
      return {
        restrictions: ["account/suspended", "service/suspended"],
        clauseIds: "any",
        appealSubjectType: "moderation_case",
      };
    case "ncii.decide":
      return d.decision === "removed"
        ? { restrictions: ["visibility/removed"], clauseIds: ["illegal.ncii"], appealSubjectType: "ncii_request_item" }
        : null;
    case "ncii.auto_hide":
      return {
        restrictions: ["visibility/disabled"],
        clauseIds: ["illegal.ncii"],
        appealSubjectType: "ncii_request_item",
      };
    case "moderation.t0.match":
      return d.listCategory === "ncii"
        ? { restrictions: ["account/suspended"], clauseIds: ["illegal.ncii"], appealSubjectType: null }
        : null;
  }
}

/** The ways a stored statement differs from its expectation (empty when it matches). */
export function statementProblems(s: StatementRow, e: Expected, recipients: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const r = `${s.restrictionKind}/${s.restrictionDetail}`;
  if (!e.restrictions.includes(r)) out.push(`restriction ${r}`);
  if (e.clauseIds !== "any" && !e.clauseIds.includes(s.clauseId)) out.push(`clause ${s.clauseId}`);
  if (s.appealSubjectType !== e.appealSubjectType) out.push(`appeal ${s.appealSubjectType ?? "none"}`);
  if (!recipients.has(s.recipientUserId)) out.push("recipient outside the run");
  return out;
}

/** The newest sign-in link in a list of mails sent at or after `since` (ISO), or null. */
export function freshMagicLink(
  messages: readonly { created: string; subject: string; text: string; html: string }[],
  since: number,
): string | null {
  const fresh = messages
    .filter((m) => Date.parse(m.created) >= since - 1_000 && /sign-?in/i.test(m.subject))
    .toSorted((a, b) => Date.parse(b.created) - Date.parse(a.created));
  for (const m of fresh) {
    const link = findTokenLink(m, /magic-link|token=/i);
    if (link) return link;
  }
  return null;
}

/* ------------------------------------------------------------------------- */

async function withDb<T>(databaseUrl: string, fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>): Promise<T> {
  const handle = createDb({ url: databaseUrl, max: 1, applicationName: "commonair-harness-sor" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

interface RunScope {
  users: Map<string, string>; // id → email
  since: Date;
}

async function runScope(run: Run): Promise<RunScope> {
  return withDb(run.databaseUrl, async (sql) => {
    const rows = await sql<{ id: string; email: string; created_at: Date }[]>`
      select id, email, created_at from users where email = any(${run.emails})`;
    const since = rows.reduce((m, r) => (r.created_at < m ? r.created_at : m), new Date());
    return { users: new Map(rows.map((r) => [r.id, r.email])), since };
  });
}

/** Allowlisted audit rows about the run's users or channels (NCII: items on their channels). */
async function runAuditRows(run: Run, scope: RunScope): Promise<AuditRow[]> {
  const ids = [...scope.users.keys()];
  return withDb(run.databaseUrl, async (sql) => {
    const rows = await sql<{ id: string; action: string; details: Record<string, unknown> }[]>`
      with ru as (select unnest(${ids}::uuid[]) as id),
           rc as (select id from channels where owner_id in (select id from ru))
      select a.id, a.action, a.details from audit_log a
      where a.action = any(${[...ENFORCEMENT_SOURCE_ACTIONS]})
        and a.created_at >= ${scope.since}
        and (
          a.channel_id in (select id from rc)
          or (a.details ->> 'userId') in (select id::text from ru)
          or (a.action in ('ncii.decide', 'ncii.auto_hide') and exists (
            select 1 from ncii_request_items i
            where i.request_id::text = a.details ->> 'requestId'
              and (i.removed_at is not null or i.hidden_at is not null)
              and (
                (i.subject_type = 'upload' and i.subject_id in (select id from rc))
                or (i.subject_type = 'broadcast' and exists (select 1 from broadcasts b where b.id = i.subject_id and b.channel_id in (select id from rc)))
                or (i.subject_type = 'vod' and exists (select 1 from vods v where v.id = i.subject_id and v.channel_id in (select id from rc)))
                or (i.subject_type = 'clip' and exists (select 1 from clips c where c.id = i.subject_id and c.channel_id in (select id from rc)))
              )))
        )
      order by a.created_at, a.id`;
    return rows.map((r) => ({ id: r.id, action: r.action, details: r.details ?? {} }));
  });
}

async function statementsOf(run: Run, where: { auditId?: string; recipient?: string }): Promise<StatementRow[]> {
  return withDb(run.databaseUrl, async (sql) => {
    const rows = await sql<
      {
        id: string;
        source_audit_id: string;
        source_action: string;
        recipient_user_id: string;
        restriction_kind: string;
        restriction_detail: string;
        clause_id: string;
        appeal_subject_type: string | null;
      }[]
    >`select id, source_audit_id, source_action, recipient_user_id, restriction_kind, restriction_detail,
             clause_id, appeal_subject_type
      from enforcement_statements
      where ${where.auditId ? sql`source_audit_id = ${where.auditId}` : sql`recipient_user_id = ${where.recipient ?? ""}`}`;
    return rows.map((r) => ({
      id: r.id,
      sourceAuditId: r.source_audit_id,
      sourceAction: r.source_action,
      recipientUserId: r.recipient_user_id,
      restrictionKind: r.restriction_kind,
      restrictionDetail: r.restriction_detail,
      clauseId: r.clause_id,
      appealSubjectType: r.appeal_subject_type,
    }));
  });
}

/** An owner-run UPDATE and DELETE of a statement, each refused; always rolled back. */
async function ownerRewriteRefused(run: Run, statementId: string): Promise<{ update: boolean; delete: boolean }> {
  const ROLLBACK = Symbol("rollback");
  return withDb(run.databaseUrl, async (sql) => {
    const out = { update: false, delete: false };
    try {
      await sql.begin(async (tx) => {
        for (const op of ["update", "delete"] as const) {
          await tx.unsafe("savepoint attempt");
          try {
            await (op === "update"
              ? tx`update enforcement_statements set clause_version = clause_version where id = ${statementId}`
              : tx`delete from enforcement_statements where id = ${statementId}`);
          } catch {
            out[op] = true;
          }
          await tx.unsafe("rollback to savepoint attempt");
        }
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    return out;
  });
}

/** Ask for a magic link and return it from Mailpit. */
async function magicLink(run: Run, api: Api, email: string): Promise<string> {
  const since = Date.now();
  const res = await api.fetch(
    new Request(`${api.baseUrl}${AUTH_BASE_PATH}/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, callbackURL: "/settings/appeals" }),
    }),
  );
  if (!res.ok) throw new Error(`magic link request failed: HTTP ${res.status}`);
  const mailpit = run.ctx.platform.users.mailpit;
  return waitFor(
    "magic link mail",
    async () => {
      const summaries = await mailpit.search(`to:"${email}"`);
      const messages = await Promise.all(
        summaries.filter((s) => Date.parse(s.created) >= since - 1_000).map((s) => mailpit.get(s.id)),
      );
      return freshMagicLink(messages, since);
    },
    { timeoutMs: API_SETTLE_MS, intervalMs: 500, signal: run.ctx.signal },
  );
}

/** A fresh API client signed in as `email` through a magic link. */
async function signInByMail(run: Run, email: string): Promise<Api> {
  const api = run.ctx.platform.api();
  const link = await magicLink(run, api, email);
  const origins = {
    api: new URL(run.ctx.env.HARNESS_API_URL).origin,
    web: new URL(run.ctx.env.HARNESS_WEB_URL).origin,
    client: new URL(api.baseUrl).origin,
  };
  let url = verificationHop(new URL(link), origins);
  for (let hop = 0; url && hop < 5; hop++) {
    const res = await api.fetch(new Request(url, { redirect: "manual" }));
    const location = res.headers.get("location");
    url = res.status >= 300 && res.status < 400 && location ? verificationHop(new URL(location, url), origins) : null;
  }
  await api.client.me.get();
  return api;
}

async function listAll(api: Api): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await api.client.me.enforcement.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map((s) => s.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return ids;
}

export async function runStatementsStep(run: Run): Promise<void> {
  const { ctx } = run;
  const t = (w: string) => title(11, w);

  const scope = await ctx.step(t("resolve the run's users"), () => runScope(run));
  const rows = await ctx.step(t("audit actions from steps 4–7"), () => runAuditRows(run, scope));
  const expected = rows.flatMap((r) => {
    const e = expectedStatement(r);
    return e ? [{ row: r, e }] : [];
  });
  ctx.data(
    "sorAuditActions",
    rows.map((r) => r.action),
  );
  ctx.assert("statements: steps 4–7 produced allowlisted actions", expected.length > 0, {
    actions: rows.map((r) => r.action),
  });
  const recipients = new Set(scope.users.keys());

  const byRecipient = new Map<string, StatementRow[]>();
  for (const { row, e } of expected) {
    const found = await ctx.step(t(`statement for ${row.action}`), () =>
      waitFor(
        `statement for ${row.action}`,
        async () => {
          const s = await statementsOf(run, { auditId: row.id });
          return s.length > 0 ? s : null;
        },
        { timeoutMs: STATEMENT_WAIT_MS, intervalMs: 2_000, signal: ctx.signal },
      ).catch(() => [] as StatementRow[]),
    );
    ctx.check(`statements: ${row.action} has a statement within 60 s`, found.length > 0, { auditId: row.id });
    for (const s of found) {
      const problems = statementProblems(s, e, recipients);
      ctx.check(`statements: ${row.action} matches the selectors table`, problems.length === 0, {
        auditId: row.id,
        problems,
      });
      byRecipient.set(s.recipientUserId, [...(byRecipient.get(s.recipientUserId) ?? []), s]);
    }
  }
  ctx.metric(
    "sorStatements",
    [...byRecipient.values()].reduce((n, l) => n + l.length, 0),
  );

  // Each recipient reads theirs through the API (and the web); nobody else sees them.
  const other = await run.staff.mod.api.client.me.enforcement.list({ limit: 100 });
  const otherIds = new Set(other.items.map((s) => s.id));
  for (const [userId, statements] of byRecipient) {
    const email = scope.users.get(userId);
    if (!email) continue;
    const api = await ctx.step(t("recipient signs in by magic link"), () => signInByMail(run, email));
    const listed = new Set(await ctx.step(t("recipient lists their statements"), () => listAll(api)));
    ctx.check(
      "statements: me.enforcement.list returns each statement to its recipient",
      statements.every((s) => listed.has(s.id)),
      { missing: statements.filter((s) => !listed.has(s.id)).map((s) => s.id) },
    );
    ctx.check(
      "statements: another user's list never has them",
      statements.every((s) => !otherIds.has(s.id)),
    );
    const mail = await ctx
      .step(t("the statement email arrived"), () =>
        run.ctx.platform.users.mailpit.waitForMessage(
          email,
          (m) => /statement of reasons/i.test(m.subject),
          API_SETTLE_MS,
        ),
      )
      .catch(() => null);
    ctx.check("statements: the statement email arrived", mail !== null);

    if (run.via === "web") {
      const first = statements[0];
      if (!first) continue;
      const session = await run.webSession("sor-recipient");
      await ctx.step(t("/settings/appeals lists the statement"), async () => {
        const link = await magicLink(run, run.ctx.platform.api(), email);
        await session.goto(link);
        const page = await session.goto("/settings/appeals");
        await page
          .locator(
            `[data-testid="enforcement-statement"][data-statement-id="${first.id}"][data-source-action="${first.sourceAction}"]`,
          )
          .first()
          .waitFor({ timeout: UI_TIMEOUT_MS });
      });
    }
  }

  const sample = [...byRecipient.values()][0]?.[0];
  if (sample) {
    const refused = await ctx.step(t("an owner-run UPDATE and DELETE of a statement"), () =>
      ownerRewriteRefused(run, sample.id),
    );
    ctx.check("statements: the owner cannot update a statement", refused.update);
    ctx.check("statements: the owner cannot delete a statement", refused.delete);
  }

  // Channel moderation never produces a statement.
  const o = await ctx.step(t("sign up channel owner O"), () => newStreamer(run, "ts_sor_o"));
  const banned = await ctx.step(t("sign up viewer B"), async () => {
    const u = await ctx.platform.signUp({ prefix: "ts_sor_b" });
    run.emails.push(u.email);
    return u;
  });
  const timedOut = await ctx.step(t("sign up viewer T"), async () => {
    const u = await ctx.platform.signUp({ prefix: "ts_sor_t" });
    run.emails.push(u.email);
    return u;
  });
  await ctx.step(t("O bans B and times out T in chat"), async () => {
    await o.user.api.client.chat.bans.ban({ channel: o.channel, username: banned.username });
    await o.user.api.client.chat.bans.ban({ channel: o.channel, username: timedOut.username, durationSeconds: 600 });
  });
  await ctx.step(t("wait for several builder runs"), () => new Promise((r) => setTimeout(r, NO_STATEMENT_WAIT_MS)));
  for (const [who, u] of [
    ["ban", banned],
    ["timeout", timedOut],
  ] as const) {
    const s = await statementsOf(run, { recipient: u.id });
    ctx.check(`statements: a channel ${who} produces none`, s.length === 0, { statements: s.length });
    const listed = await u.api.client.me.enforcement.list({ limit: 10 });
    ctx.check(`statements: the ${who} target's list is empty`, listed.items.length === 0);
  }
}
