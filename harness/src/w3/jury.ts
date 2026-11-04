// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e5-coop` W3 extension `jury` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0038), through the
 * API and the batch 7 test hook:
 *
 * 1. `jury.enabled` on, through an ordinary proposal its own 12 members vote (skipped when an
 *    earlier run already turned it on; the seed has it off).
 * 2. The 12 members (appointed workers, adults) opt in.
 * 3. Closed T1/T2 cases and resolved reports are seeded, plus one T0 and one NCII case.
 * 4. The draw hook (`jury-draw`) seats the panel and samples the cases.
 * 5. Seated jurors vote: all disagree on one case they all see, the rest mostly agree.
 * 6. The close hook (`jury-close`) reveals the seed and flags.
 * 7. Checks: the results are published with suppression (k = 10); the majority-disagree case is
 *    flagged (row, audit row, staff list); no T0 or NCII case was sampled; the revealed seed
 *    matches its commitment; no outcome changed.
 *
 * Raw SQL runs on the owner connection with Bun.SQL (new rows' ids minted with `uuidv7()`, as the
 * tables have no id default; id lists bound with `sql.array`; timestamps are the database's own
 * `now()`). The step leaves its members opted out and exited.
 */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { uuidv7 } from "@commonair/db";
import { governancePeriods } from "../coop.ts";
import { grantRole } from "../money-db.ts";
import { internalSecret } from "../safety-io.ts";
import type { SignedInUser } from "../users.ts";
import type { CoopW3Extension } from "./kit.ts";

/** Members the step enrols (the brief's 12), against the default panel size of 7. */
export const JURY_MEMBERS = 12;
/** Username prefix of the step's own members, and the LIKE pattern that matches only them. */
export const JURY_PREFIX = "e5_jury";
export const JURY_USERNAME_LIKE = "e5\\_jury\\_%";
/**
 * The harness's case marker: the resolution note of every moderation case and the details of
 * every report the step seeds. No real case or report carries it.
 */
export const JURY_CASE_MARKER = "harness:e5-coop:jury";
const K = 10;
const HOOK_TIMEOUT_MS = 75_000;
const WINDOW_SLACK_MS = 90_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;

type Count = { suppressed: true } | { suppressed: false; value: number };
type Vote = "agree" | "disagree" | "unsure";
export interface Tally {
  agree: number;
  disagree: number;
  unsure: number;
}
export interface PublishedRow {
  clauseId: string;
  tier: string | null;
  agree: Count;
  disagree: Count;
  unsure: Count;
}

// ---------------------------------------------------------------- pure checks (unit-tested)

const toBytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));

/** `packages/draw` `commit`: hex SHA-256 over the seed's raw bytes. */
export async function seedMatches(seed: string, commitment: string): Promise<boolean> {
  if (!/^(?:[0-9a-f]{2}){16,64}$/.test(seed)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(seed)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") === commitment;
}

/** `<id>@<version>` → the clause id. */
export const clauseIdOf = (ruleRef: string): string => ruleRef.slice(0, ruleRef.lastIndexOf("@"));

/**
 * Whether a published row agrees with the votes behind it (ADR 0038 §7): under k in all, every
 * cell is hidden; otherwise every count from 1 to k−1 is hidden and every shown count is exact
 * (a shown count may still be hidden for complementary suppression).
 */
export function rowProblem(row: PublishedRow, tally: Tally): string | null {
  const total = tally.agree + tally.disagree + tally.unsure;
  const cells: (keyof Tally)[] = ["agree", "disagree", "unsure"];
  if (total < K) {
    const shown = cells.filter((c) => !row[c].suppressed);
    return shown.length ? `${row.clauseId}: ${String(total)} votes but ${shown.join(", ")} shown` : null;
  }
  for (const c of cells) {
    const cell = row[c];
    const n = tally[c];
    if (!cell.suppressed && cell.value !== n)
      return `${row.clauseId}: ${c} shows ${String(cell.value)}, cast ${String(n)}`;
    if (!cell.suppressed && n > 0 && n < K) return `${row.clauseId}: ${c} = ${String(n)} is under k but shown`;
  }
  return null;
}

/** The votes cast, grouped as `jury.results` groups them (clause id and tier). */
export function tallies(
  votes: readonly { ruleRef: string | null; tier: string | null; vote: Vote }[],
): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const v of votes) {
    if (!v.ruleRef) continue;
    const key = `${clauseIdOf(v.ruleRef)}|${v.tier ?? ""}`;
    const t = out.get(key) ?? { agree: 0, disagree: 0, unsure: 0 };
    t[v.vote]++;
    out.set(key, t);
  }
  return out;
}

/** A jury panel as the rerun cleanup reads it. */
export interface PanelRow {
  id: string;
  /** Usernames of its seats. */
  seats: readonly string[];
  /** Its sampled cases, and how many of them carry `JURY_CASE_MARKER`. */
  cases: number;
  markedCases: number;
}

/** Whether a username is one of the step's own members (`e5_jury_…`, as `JURY_USERNAME_LIKE`). */
export const isHarnessJuror = (username: string): boolean => username.startsWith(`${JURY_PREFIX}_`);

/**
 * The panels a same-stack rerun removes: the harness's own, by its marker. A panel is the harness's
 * when it sampled a case the harness seeded (`JURY_CASE_MARKER`) and seated one of the harness's
 * members. Only a draw during a harness run does both: the step's members opt in just before its
 * draw and opt out when it ends, and its cases exist only on a stack the harness seeded. A panel
 * with no marked case, or with no harness seat, is someone else's and stays (a panel that is not
 * there to clean then fails the draw assertion, which reports it). An empty panel (committed,
 * nothing selected yet) is reused by the next draw and needs no cleanup.
 */
export function harnessPanelIds(panels: readonly PanelRow[]): string[] {
  return panels.filter((p) => p.markedCases > 0 && p.seats.some(isHarnessJuror)).map((p) => p.id);
}

/** The case every seated juror sees (conflicts can hide one from someone), or null. */
export function sharedCase(lists: readonly (readonly string[])[]): string | null {
  const [first, ...rest] = lists;
  return first?.find((id) => rest.every((l) => l.includes(id))) ?? null;
}

// ---------------------------------------------------------------- hooks and SQL

async function b7Tick(
  ext: CoopW3Extension,
  job: "jury-draw" | "jury-close",
  data: Record<string, unknown>,
): Promise<Record<string, number>> {
  const secret = internalSecret(ext.ctx.env);
  if (!secret) throw new Error("INTERNAL_API_SECRET is not set (the batch 7 test hook)");
  const res = await fetch(new URL(INTERNAL_ROUTES.b7Tick, ext.ctx.env.HARNESS_API_URL), {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify({ job, data }),
    signal: AbortSignal.any([ext.ctx.signal, AbortSignal.timeout(HOOK_TIMEOUT_MS)]),
  });
  if (res.status === 404)
    throw new Error(`${INTERNAL_ROUTES.b7Tick} answered 404: start the stack with OPS_TEST_HOOKS=true`);
  if (!res.ok) throw new Error(`${INTERNAL_ROUTES.b7Tick} (${job}) answered HTTP ${String(res.status)}`);
  return (await res.json()) as Record<string, number>;
}

async function withSql<T>(url: string, fn: (sql: InstanceType<typeof Bun.SQL>) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL(url);
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

export interface Seeded {
  ok: string[];
  t0: string;
  ncii: string;
  reports: string[];
}

/** Who the seeded cases and reports are about, by id. */
export interface SeedParties {
  /** The two streamers and their channels. */
  s1: string;
  s2: string;
  ch1: string;
  ch2: string;
  /** The seeded reports' reporter and reported user. */
  reporter: string;
  reported: string;
  /** A user holding the `legal` role, who confirms the T0 case. */
  legal: string;
}

/**
 * Closed cases and resolved reports from the last day, on the streamers' channels and between
 * adult accounts, plus a T0 (decided by a `legal` reviewer, as the trigger requires) and an NCII
 * case that must never be sampled. Neither table has a database default for `id` (the app mints
 * UUIDv7s through Drizzle), so these raw inserts mint theirs with `uuidv7()`.
 */
export async function seedJuryCases(sql: InstanceType<typeof Bun.SQL>, p: SeedParties): Promise<Seeded> {
  const kase = async (v: {
    tier: string;
    origin: string;
    category: string | null;
    listCategory: string | null;
    ruleRef: string | null;
    status: string;
    channelId: string;
    userId: string;
    resolvedBy: string | null;
  }): Promise<string> => {
    const id = uuidv7();
    await sql`
      insert into moderation_cases (id, tier, origin, category, list_category, subject_type, subject_id, channel_id, user_id, rule_ref)
      values (${id}::uuid, ${v.tier}::moderation_tier, ${v.origin}::moderation_case_origin, ${v.category}::moderation_category,
              ${v.listCategory}::hash_list_category, 'broadcast', ${uuidv7()}::uuid, ${v.channelId}::uuid, ${v.userId}::uuid, ${v.ruleRef})`;
    // Cases start undecided (0016); deciding them is a separate update, as in production.
    // The note is the harness's case marker: it is how a rerun recognises the harness's panel.
    await sql`
      update moderation_cases set status = ${v.status}::moderation_case_status, resolved_at = now() - interval '1 day',
             resolved_by_id = ${v.resolvedBy}::uuid, resolution_note = ${JURY_CASE_MARKER}
       where id = ${id}::uuid`;
    return id;
  };
  const ok: string[] = [];
  for (let i = 0; i < 6; i++) {
    ok.push(
      await kase({
        tier: i < 4 ? "t1" : "t2",
        origin: "classifier",
        category: i < 4 ? "weapons" : "sexual",
        listCategory: null,
        ruleRef: i < 4 ? "safety.weapons@1" : "mature.unlabelled@1",
        status: i < 4 ? "actioned" : "confirmed",
        channelId: i % 2 === 0 ? p.ch1 : p.ch2,
        userId: i % 2 === 0 ? p.s1 : p.s2,
        resolvedBy: null,
      }),
    );
  }
  // A CSAM-list T0 case cites no clause (ADR 0019 decision 1); confirming it takes a `legal` reviewer.
  const t0 = await kase({
    tier: "t0",
    origin: "hash_list",
    category: null,
    listCategory: "csam",
    ruleRef: null,
    status: "confirmed",
    channelId: p.ch1,
    userId: p.s1,
    resolvedBy: p.legal,
  });
  const ncii = await kase({
    tier: "t1",
    origin: "human",
    category: null,
    listCategory: null,
    ruleRef: "decency.intimate-images@1",
    status: "actioned",
    channelId: p.ch2,
    userId: p.s2,
    resolvedBy: null,
  });
  const reports: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = uuidv7();
    await sql`
      insert into reports (id, reporter_id, subject_type, subject_id, reason, details, status, resolved_at)
      values (${id}::uuid, ${p.reporter}::uuid, 'user', ${p.reported}::uuid, ${i < 5 ? "harassment" : "spam"}::report_reason,
              ${JURY_CASE_MARKER}, ${i % 3 === 0 ? "dismissed" : "actioned"}::report_status, now() - interval '1 day')`;
    reports.push(id);
  }
  return { ok, t0, ncii, reports };
}

async function seedCases(ext: CoopW3Extension, legal: SignedInUser): Promise<Seeded> {
  const { s1, s2, v, w } = ext.people;
  return withSql(ext.databaseUrl, async (sql) => {
    const [ch1] = (await sql`select id::text as id from channels where owner_id = ${s1.id}`) as { id: string }[];
    const [ch2] = (await sql`select id::text as id from channels where owner_id = ${s2.id}`) as { id: string }[];
    if (!ch1 || !ch2) throw new Error("the streamers have no channels");
    return seedJuryCases(sql, {
      s1: s1.id,
      s2: s2.id,
      ch1: ch1.id,
      ch2: ch2.id,
      reporter: w.id,
      reported: v.id,
      legal: legal.id,
    });
  });
}

/** A period's panels with their seats' usernames and their marked cases. */
export async function readPanels(sql: InstanceType<typeof Bun.SQL>, period: string): Promise<PanelRow[]> {
  const rows = (await sql`
    select p.id::text as id,
           coalesce((select json_agg(u.username order by u.username) from jury_seats s join users u on u.id = s.user_id
                      where s.panel_id = p.id), '[]'::json) as seats,
           (select count(*)::int from jury_cases jc where jc.panel_id = p.id) as cases,
           (select count(*)::int from jury_cases jc
              left join moderation_cases mc on jc.subject_kind = 'moderation_case' and mc.id = jc.subject_id
              left join reports r on jc.subject_kind = 'report' and r.id = jc.subject_id
             where jc.panel_id = p.id
               and (mc.resolution_note = ${JURY_CASE_MARKER} or r.details = ${JURY_CASE_MARKER})) as marked
      from jury_panels p
     where p.period = ${period}
     order by p.id`) as { id: string; seats: unknown; cases: number; marked: number }[];
  return rows.map((r) => {
    const seats: unknown = typeof r.seats === "string" ? JSON.parse(r.seats) : r.seats;
    return {
      id: r.id,
      seats: Array.isArray(seats) ? seats.filter((s): s is string => typeof s === "string") : [],
      cases: Number(r.cases),
      markedCases: Number(r.marked),
    };
  });
}

/**
 * Removes the period's harness panels (`harnessPanelIds`) and returns their ids. Seats, sampled
 * cases, votes and flags go with each panel by `ON DELETE CASCADE`: `jury_votes` is append-only,
 * but its 0046 trigger lets a cascade through, so no test hook is needed. The seeded moderation
 * cases and reports stay (their tables refuse deletes); a rerun seeds new ones.
 */
export async function dropHarnessPanels(sql: InstanceType<typeof Bun.SQL>, period: string): Promise<string[]> {
  const ids = harnessPanelIds(await readPanels(sql, period));
  if (ids.length === 0) return [];
  const gone = (await sql`
    delete from jury_panels where id = any(${sql.array(ids, "uuid")}) returning id::text as id`) as { id: string }[];
  return gone.map((g) => g.id);
}

export interface Outcome {
  id: string;
  status: string;
  resolution: string | null;
}

export async function outcomes(url: string, ids: readonly string[]): Promise<Outcome[]> {
  return withSql(url, async (sql) => [
    ...((await sql`
      select id::text as id, status::text as status, resolution from moderation_cases where id = any(${sql.array([...ids], "uuid")})
      union all
      select id::text as id, status::text as status, resolution from reports where id = any(${sql.array([...ids], "uuid")})
      order by id`) as Outcome[]),
  ]);
}

// ---------------------------------------------------------------- the step

async function enableJury(ext: CoopW3Extension, members: readonly SignedInUser[]): Promise<void> {
  const { ctx, hooks } = ext;
  const anon = ctx.platform.api().client;
  const settings = await anon.coop.settings();
  const current = settings.find((s) => s.key === "jury.enabled")?.value as { enabled?: unknown } | undefined;
  if (current?.enabled === true) {
    ctx.data("jury.enabledBy", "earlier run");
    return;
  }
  const periods = governancePeriods(settings);
  const author = members[0] as SignedInUser;
  const draft = await author.api.client.coop.proposals.create({
    title: `Turn the member jury on (${ctx.runId})`,
    body: "Harness e5-coop jury: the co-op votes the advisory jury on (ADR 0038).",
    changes: [{ key: "jury.enabled", value: { enabled: true } }],
    affectsCreators: false,
  });
  const p = await author.api.client.coop.proposals.submit({ id: draft.id });
  ctx.data("jury.proposalId", p.id);
  let voted = false;
  const budget =
    (periods.discussionSeconds + periods.councilReviewSeconds + periods.votingSeconds) * 1_000 + WINDOW_SLACK_MS * 2;
  await hooks.tickUntil(
    "proposals-advance",
    "the jury proposal applied",
    async () => {
      const now = await anon.coop.proposals.get({ id: p.id });
      if (now.status === "rejected" || now.status === "withdrawn")
        throw new Error(`the jury proposal was ${now.status}`);
      if (now.status === "voting" && !voted) {
        await Promise.all(members.map((m) => m.api.client.coop.proposals.vote({ id: p.id, choice: "yes" })));
        voted = true;
      }
      return now.status === "applied" ? true : null;
    },
    { timeoutMs: budget, intervalMs: 2_000 },
  );
  const after = (await anon.coop.settings()).find((s) => s.key === "jury.enabled")?.value as
    | { enabled?: unknown }
    | undefined;
  ctx.assert("jury.enabled is on after the proposal applied", after?.enabled === true, after ?? null);
}

export async function stepJury(ext: CoopW3Extension): Promise<void> {
  const { ctx, people } = ext;
  const p = ctx.platform;
  const period = new Date().toISOString().slice(0, 7);

  // ------------------------------------------------------------ members
  const members = await ctx.step(`jury: sign up ${String(JURY_MEMBERS)} members and a legal reviewer`, () =>
    Promise.all(Array.from({ length: JURY_MEMBERS + 1 }, () => p.signUp({ prefix: JURY_PREFIX }))),
  );
  const legal = members.pop() as SignedInUser;
  await ctx.step("jury: grant the legal reviewer (operator CLI)", () =>
    grantRole(ext.databaseUrl, legal.username, "legal", ROLE_CLI_TIMEOUT_MS),
  );
  await ctx.step("jury: the board appoints them as worker members", async () => {
    for (const m of members)
      await people.admin.api.client.coop.appointWorker({ username: m.username, boardMinuteRef: `jury-${ctx.runId}` });
  });
  ctx.defer(async () => {
    // Later runs start from a clean pool and electorate.
    for (const m of members) {
      await m.api.client.jury.optOut().catch(() => undefined);
      await m.api.client.coop.exit({ class: "worker" }).catch(() => undefined);
    }
  });

  // ------------------------------------------------------------ 1. on
  await ctx.step("jury: 1. jury.enabled on through an ordinary proposal", () => enableJury(ext, members));

  // ------------------------------------------------------------ 2. opt in
  await ctx.step(`jury: 2. ${String(JURY_MEMBERS)} members opt in`, async () => {
    for (const m of members) {
      const st = await m.api.client.jury.optIn();
      ctx.assert(`${m.username} is opted in`, st.optedIn && st.eligible, {
        optedIn: st.optedIn,
        eligible: st.eligible,
      });
    }
  });

  // ------------------------------------------------------------ 3. cases
  await withSql(ext.databaseUrl, async (sql) => {
    // A rerun in the same month: drop this month's harness panel (by its marker) so the draw runs.
    // Anyone else's panel stays, and the draw assertion below then reports it.
    const gone = await dropHarnessPanels(sql, period);
    if (gone.length) ctx.log.info("jury: dropped this month's earlier harness panel", { panels: gone.length });
  });
  const seeded = await ctx.step("jury: 3. seed closed T1/T2 cases and reports, one T0 and one NCII case", () =>
    seedCases(ext, legal),
  );

  // ------------------------------------------------------------ 4. draw
  const drawn = await ctx.step("jury: 4. the draw hook seats the panel", () => b7Tick(ext, "jury-draw", {}));
  ctx.data("jury.draw", drawn);
  ctx.assert("the draw ran", drawn.drawn === 1, drawn);
  const seated: SignedInUser[] = [];
  let panelId = "";
  for (const m of members) {
    const st = await m.api.client.jury.status();
    if (st.seat) {
      seated.push(m);
      panelId = st.seat.panelId;
    }
  }
  ctx.data("jury.seated", seated.length);
  ctx.assert("seven jurors are seated (jury.panelSize), all from the opted-in members", seated.length === 7, {
    seated: seated.length,
    seats: drawn.seats ?? null,
  });
  const sampled = await withSql(ext.databaseUrl, async (sql) => [
    ...((await sql`
      select jc.subject_id::text as id, jc.subject_kind::text as kind, mc.tier::text as tier, mc.list_category::text as list,
             coalesce(jc.rule_ref, '') as rule_ref
        from jury_cases jc left join moderation_cases mc on mc.id = jc.subject_id
       where jc.panel_id = ${panelId}::uuid`) as {
      id: string;
      kind: string;
      tier: string | null;
      list: string | null;
      rule_ref: string;
    }[]),
  ]);
  ctx.data("jury.sampled", sampled.length);
  ctx.assert("cases were sampled", sampled.length > 0, { sampled: sampled.length });
  ctx.assert(
    "no T0 or NCII case was sampled",
    !sampled.some(
      (c) =>
        c.id === seeded.t0 ||
        c.id === seeded.ncii ||
        c.tier === "t0" ||
        c.list !== null ||
        ["decency.intimate-images", "illegal.ncii", "safety.minors"].includes(clauseIdOf(c.rule_ref)),
    ),
    { t0: sampled.some((c) => c.id === seeded.t0), ncii: sampled.some((c) => c.id === seeded.ncii) },
  );
  const before = await outcomes(
    ext.databaseUrl,
    sampled.map((c) => c.id),
  );

  // ------------------------------------------------------------ 5. votes
  const lists = await Promise.all(seated.map((m) => m.api.client.jury.cases()));
  const target = sharedCase(lists.map((l) => l.map((c) => c.id)));
  ctx.assert("one case is seen by every seated juror", target !== null);
  const cast: { ruleRef: string | null; tier: string | null; vote: Vote }[] = [];
  await ctx.step("jury: 5. jurors vote (all disagree on one case)", async () => {
    for (const [i, juror] of seated.entries()) {
      for (const c of lists[i] ?? []) {
        const vote: Vote = c.id === target ? "disagree" : i === 0 ? "unsure" : "agree";
        const reasonCode =
          vote === "disagree" ? "action_too_severe" : vote === "unsure" ? "evidence_unclear" : "clause_fits";
        const r = await juror.api.client.jury.vote({ id: c.id, vote, reasonCode });
        ctx.assert(`juror ${String(i)}'s vote is recorded`, r.myVote?.vote === vote, { caseId: c.id });
        cast.push({ ruleRef: c.ruleRef, tier: c.tier, vote });
      }
    }
  });

  // ------------------------------------------------------------ 6. close
  const closed = await ctx.step("jury: 6. the close hook reveals the seed and flags", () =>
    b7Tick(ext, "jury-close", { panelId }),
  );
  ctx.data("jury.close", closed);
  ctx.assert("the panel closed with at least one flag", closed.closed === 1 && (closed.flagged ?? 0) >= 1, closed);

  // ------------------------------------------------------------ 7. checks
  await ctx.step(
    "jury: 7. results published with suppression; the seed matches; flagged; no outcome changed",
    async () => {
      const results = await p.api().client.jury.results({ period });
      ctx.assert("the results carry the period, the panel size and the revealed seed", results.seed !== null, {
        period: results.period,
        panelSize: results.panelSize,
      });
      ctx.check("the panel size is published", results.panelSize === seated.length, { panelSize: results.panelSize });
      ctx.assert(
        "the revealed seed's SHA-256 is the commitment published at the draw",
        results.seed !== null &&
          results.seedCommitment !== null &&
          (await seedMatches(results.seed, results.seedCommitment)),
      );
      const expected = tallies(cast);
      const problems: string[] = [];
      for (const row of results.rows) {
        const tally = expected.get(`${row.clauseId}|${row.tier ?? ""}`);
        if (!tally) {
          problems.push(`${row.clauseId}: published with no votes cast`);
          continue;
        }
        const problem = rowProblem(row, tally);
        if (problem) problems.push(problem);
      }
      ctx.assert("every published cell follows the k = 10 rule", problems.length === 0, { problems });
      ctx.assert("every clause voted on is published", results.rows.length === expected.size, {
        rows: results.rows.length,
        expected: expected.size,
      });
      ctx.check(
        "at least one cell is suppressed",
        results.rows.some((r) => r.agree.suppressed || r.disagree.suppressed || r.unsure.suppressed),
      );

      const flags = await people.admin.api.client.jury.flags.list({ open: true, limit: 100 });
      const flag = flags.items.find((f) => f.caseId === target);
      ctx.assert("the majority-disagree case is in the staff re-review list", flag !== undefined, {
        flags: flags.items.length,
      });
      ctx.check(
        "the flag counts every juror's disagree vote",
        flag !== undefined && flag.disagree === seated.length && flag.votes === seated.length,
        flag ?? null,
      );
      const audit = await withSql(ext.databaseUrl, async (sql) => [
        ...((await sql`select action from audit_log where subject_id = ${target ?? ""} and action = 'jury.case.flag'`) as {
          action: string;
        }[]),
      ]);
      ctx.assert("the flag wrote an audit row", audit.length === 1, { rows: audit.length });

      const after = await outcomes(
        ext.databaseUrl,
        sampled.map((c) => c.id),
      );
      ctx.assert("the jury changed no outcome", JSON.stringify(after) === JSON.stringify(before), {
        cases: before.length,
      });
    },
  );

  await ctx.step("jury: members opt out and exit", async () => {
    for (const m of members) {
      const st = await m.api.client.jury.optOut();
      ctx.check(`${m.username} opted out`, !st.optedIn);
      await m.api.client.coop.exit({ class: "worker" });
    }
  });
}
