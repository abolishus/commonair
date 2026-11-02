// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's run: the plan driven through the API as the right role, the worker and the test
 * hooks. Every protected row (cases, flags, labels, evidence, holds, NCMEC drafts, statements,
 * DMCA items, NCII requests, account actions, attestations) comes from the real code path; the
 * only direct insert is `hash_match_results` (`write.ts`). Steps run in an order that keeps each
 * planned state: e.g. the DMCA restore tick runs before viewer2 counters, and the NCII clock tick
 * before the requests that must stay pending are filed.
 */
import { DMCA_RULES } from "@commonair/contracts/enums";
import type { DbHandle } from "@commonair/db";
import { OpsHooks } from "../../e6/ops.ts";
import { FIXTURES, findInPages, fixturePath, isUploadRejected, errorOf, nciiClipUrl } from "../../safety.ts";
import { ModerationHooks, putPresigned, readFixture } from "../../safety-io.ts";
import { sleep, waitFor } from "../../wait.ts";
import type { SeedContext, SeededUser } from "../types.ts";
import { AnalyticsHooks, SafetySessions, step } from "./api.ts";
import { type LiveChannel, type LiveResult, runLive } from "./live.ts";
import {
  CELLS,
  CELL_SUSPENSION_SECONDS,
  K,
  REASON_CLAUSES,
  type AppealSpec,
  type ClipRef,
  type DmcaSpec,
  type JuryCaseCandidate,
  type JuryReportCandidate,
  type ReportSpec,
  type SafetyPlan,
  STAFF,
  type SafetyStoreExtra,
  TEXT,
  juryInputs,
  safetyStoreExtra,
  signInOrder,
} from "./plan.ts";
import { type HashMatchSpec, writeHashMatches, writePendingRelayFlags } from "./write.ts";

const SETTLE_MS = 60_000;
const STATEMENT_TIMEOUT_MS = 180_000;
const EXPORT_TIMEOUT_MS = 180_000;

export interface SafetyRunResult {
  notes: string[];
  extra: SafetyStoreExtra;
}

interface Run {
  ctx: SeedContext;
  plan: SafetyPlan;
  sessions: SafetySessions;
  hooks: ModerationHooks;
  analytics: AnalyticsHooks;
  live: LiveResult;
  notes: string[];
  /** Report key → created report id. */
  reportIds: Map<string, string>;
  /** DMCA spec key → notice id. */
  noticeIds: Map<string, string>;
}

const userOf = (ctx: SeedContext, handle: string): SeededUser => {
  const u = ctx.store.users.find((x) => x.handle === handle);
  if (!u) throw new Error(`seed-safety: no seeded user "${handle}"`);
  return u;
};

function clipOf(run: Run, ref: ClipRef): { ch: LiveChannel; id: string } {
  const ch = run.live.channels.get(ref.role);
  const clip = ch?.clips[ref.index];
  if (!ch || !clip) throw new Error(`seed-safety: no clip ${ref.role}#${ref.index} was cut`);
  return { ch, id: clip.id };
}

export async function runSafety(ctx: SeedContext, plan: SafetyPlan, secret: string): Promise<SafetyRunResult> {
  const sessions = new SafetySessions(ctx.env, ctx.password, ctx.store.users, ctx.signal);
  const hooks = new ModerationHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  const analytics = new AnalyticsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  const progress = (line: string) => ctx.log.info(`seed-safety: ${line}`);

  // Flags first (common.md rule 11): a tick as of now is what the worker's own schedule does.
  await step(ctx.signal, "the test hooks", "check MODERATION_TEST_HOOKS (ncii tick as of now)", () =>
    hooks.nciiTick(new Date().toISOString()),
  );
  const s1 = ctx.store.channels.find((c) => c.ownerHandle === "streamer1");
  if (!s1) throw new Error("seed-safety: streamer1 has no channel in the store");
  await step(ctx.signal, "the test hooks", "check OPS_TEST_HOOKS (display bypass off)", () =>
    analytics.bypass(s1.id, false),
  );
  for (const name of [FIXTURES.t0Csam, FIXTURES.t0Ncii]) readFixture(fixturePath(name));

  // Sign in first: suspended accounts keep the session they had (appeals work while suspended).
  for (const h of signInOrder(plan)) await sessions.as(h);
  progress(`${sessions.signedIn} accounts signed in`);

  const live = await runLive({ env: ctx.env, sessions, hooks, log: ctx.log, signal: ctx.signal }, plan.live);
  progress("live phase done");
  const run: Run = {
    ctx,
    plan,
    sessions,
    hooks,
    analytics,
    live,
    notes: [...plan.notes],
    reportIds: new Map(),
    noticeIds: new Map(),
  };

  await labelAppeal(run);
  const hashMatches = await hashPath(run);
  await dmca(run);
  progress("DMCA done");
  await ncii(run);
  progress("NCII done");
  await reports(run);
  progress("reports done");
  // The cell suspensions are made in the reports step; they must lapse before the unit ends.
  const suspendedAt = Date.now();
  await appeals(run);
  await legalAndIncidents(run);
  await privacy(run);
  const attested = await attestations(run);
  const groupAppeal = await groupAppealStep(run);
  const pendingFlags = await writePendingRelayFlags(ctx.db, new Date(), ctx.signal);
  if (pendingFlags === 0)
    throw new Error(
      "seed-safety: no relay node to flag for review (seed-media registers one); /admin/integrity would open on an empty queue",
    );
  const integrityFlags = await integrityFlagsStep(run);
  await enforcementCells(run);
  const jury = await juryStep(run);
  // Last, so the audit checks every evidence object this run stored.
  const audit = await step(ctx.signal, "the test hooks", "tick the evidence audit (OPS_TEST_HOOKS)", () =>
    new OpsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal).tickRan("evidence-audit"),
  );

  // Later units (coop, platform) sign bulk viewers in, the cell targets among them: wait out the
  // brief suspensions (and a margin for clock skew) so none of them is still banned.
  const lapse = suspendedAt + (CELL_SUSPENSION_SECONDS + 2) * 1000 - Date.now();
  if (lapse > 0) {
    progress(`waiting ${Math.ceil(lapse / 1000)} s for the cell suspensions to lapse`);
    await sleep(lapse, ctx.signal);
  }

  if (sessions.waitedSeconds > 0)
    run.notes.push(
      `seed-safety: waited ${sessions.waitedSeconds} s for the auth rate limit (10 sign-ins a minute per address) across ${sessions.signedIn} sign-ins`,
    );
  run.notes.push(
    `seed-safety: ${hashMatches} hash_match_results rows mirror the run's T0 matches (no service writes that table yet)`,
    "seed-safety: every protected row has a real, today-only timestamp; /admin/* queues, /transparency and /settings/appeals show today's history only",
    "seed-safety: the enforcement report's 30d window is open-ended only under MODERATION_TEST_HOOKS; on a stack without it, today's statements show from tomorrow",
    `seed-safety: enforcement cells ${CELLS.map((c) => c.clauseId).join(" and ")} are filled by brief (${CELL_SUSPENSION_SECONDS} s) report suspensions of bulk viewers; those bans lapse and clear on the next sign-in`,
    "seed-safety: the analytics display bypass for streamer1 is a Valkey key (1 h TTL): after a Valkey reset or an hour, attestations and their share links wait out the 24 h display delay again",
    "seed-safety: T0 states cover open (first legal dismissal, dismissal_pending) and confirmed; a full dismissal needs a second legal reviewer, which the fixed logins do not have",
    `seed-safety: the evidence audit ran through the ops tick: ${audit["evidence.checked"] ?? 0} objects checked, ${audit["evidence.missing"] ?? 0} missing, ${audit["evidence.mismatched"] ?? 0} mismatched`,
    `seed-safety: integrity flags listed on /admin/integrity: ${integrityFlags}, ${pendingFlags} of them pending review (relay_issuance_unknown, inserted directly: the worker raises it only for a receipt with issuance gaps, which the seed cannot provoke)`,
    `seed-safety: attested ${attested} recorded broadcasts${groupAppeal ? `; streamer1's ${groupAppeal} exclusion group was appealed and overturned` : "; no excluded group on streamer1's recordings, so no group appeal"}`,
    `seed-safety: account deletion stays scheduled for ${plan.deletion ?? "nobody (no bulk viewer)"}; restricted accounts: ${plan.restricted.join(", ")}`,
    `seed-safety: jury inputs: ${jury.juryCaseIds.length} closed T1/T2 cases and ${jury.juryReportIds.length} resolved reports`,
  );
  return {
    notes: run.notes,
    extra: safetyStoreExtra({ ...jury, restrictedUserIds: plan.restricted.map((h) => userOf(ctx, h).id) }),
  };
}

// ---------------------------------------------------------------- T2 label appeal

async function labelAppeal(run: Run): Promise<void> {
  const spec = run.plan.appeals.find((a) => a.subject.kind === "label");
  const ch = run.live.channels.get("t2");
  if (!spec || !ch) return;
  const { signal } = run.ctx;
  const label = await waitFor(
    "the t2 channel's mature label",
    async () =>
      (await ch.user.api.client.me.labels()).find((l) => l.channelId === ch.channelId && l.removedAt === null),
    { timeoutMs: SETTLE_MS, intervalMs: 1_000, signal },
  );
  const appeal = await step(signal, ch.spec.handle, "appeal the mature label", () =>
    ch.user.api.client.appeals.create({
      kind: "moderation",
      subjectType: "content_label",
      subjectId: label.id,
      body: TEXT.appeal,
    }),
  );
  if (spec.outcome !== "open") await resolveAppeal(run, appeal.id, spec);
}

async function resolveAppeal(run: Run, id: string, spec: AppealSpec): Promise<void> {
  if (spec.outcome === "open") return;
  const status = spec.outcome;
  // Never the staff member who decided the subject: appeals.resolve refuses that.
  const resolver = await run.sessions.as(STAFF.appeals);
  await step(run.ctx.signal, STAFF.appeals, `${status === "upheld" ? "uphold" : "overturn"} appeal ${spec.key}`, () =>
    resolver.api.client.appeals.resolve({ id, status, resolution: TEXT.appealResolution }),
  );
}

// ---------------------------------------------------------------- hash path (T0)

async function legalCaseOf(run: Run, userId: string) {
  const legal = await run.sessions.as("legal");
  return waitFor(
    `T0 case for user ${userId} in the legal queue (MODERATION_HASHLIST_CSAM / _NCII fixture lists)`,
    () =>
      findInPages(
        (cursor) => legal.api.client.moderation.t0Queue({ cursor, limit: 100 }),
        (c) => c.user?.id === userId,
      ),
    { timeoutMs: SETTLE_MS, intervalMs: 1_000, signal: run.ctx.signal },
  );
}

async function hashPath(run: Run): Promise<number> {
  const { ctx } = run;
  const legal = await run.sessions.as("legal");
  const specs: HashMatchSpec[] = [];
  for (const t of run.plan.t0) {
    const u = await run.sessions.as(t.handle);
    const slug = u.me.channelSlug ?? u.username;
    const bytes = readFixture(fixturePath(t.fixture === "csam" ? FIXTURES.t0Csam : FIXTURES.t0Ncii));
    const up = await step(ctx.signal, t.handle, "ask for an avatar upload URL", () =>
      u.api.client.channels.uploadUrl({
        channel: slug,
        purpose: "avatar",
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
      }),
    );
    await putPresigned(up.uploadUrl, up.headers, bytes, ctx.signal);
    const err = await errorOf(() => u.api.client.channels.commitUpload({ channel: slug, key: up.key }));
    if (!isUploadRejected(err))
      throw new Error(
        `seed-safety: ${t.handle}'s synthetic ${t.fixture} fixture upload was not rejected: mount the fixture hash lists (harness/compose.trust-safety.yaml)`,
      );
    const c = await legalCaseOf(run, u.id);
    const flag = c.flags.find((f) => f.origin === "hash_list") ?? c.flags[0];
    specs.push({
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      provider: flag?.provider ?? "hash_list",
      matched: true,
      caseId: c.id,
      listCategory: c.list === "human" ? null : c.list,
      distance: flag?.distance ?? null,
      checkedAt: new Date(),
    });
    if (t.decision === "confirm")
      await step(ctx.signal, "legal", `confirm the ${t.fixture} T0 case`, () =>
        legal.api.client.moderation.t0Confirm({ id: c.id, note: TEXT.t0Confirm }),
      );
    else
      await step(ctx.signal, "legal", `first dismissal of the ${t.fixture} T0 case`, () =>
        legal.api.client.moderation.t0Dismiss({ id: c.id, note: TEXT.t0Dismiss }),
      );
    if (t.fixture === "csam" && !c.ncmecReportId)
      run.notes.push("seed-safety: the CSAM-list T0 case has no NCMEC draft yet (the worker writes it with the case)");
  }
  return writeHashMatches(ctx.db, specs, ctx.signal);
}

// ---------------------------------------------------------------- DMCA

function noticeUrl(run: Run, d: DmcaSpec): string {
  const web = run.ctx.env.HARNESS_WEB_URL;
  if (d.target.kind === "vod") return new URL(`/vods/${encodeURIComponent(d.target.vodId)}`, web).toString();
  const { ch, id } = clipOf(run, d.target.clip);
  return nciiClipUrl(web, ch.slug, id);
}

async function submitNotice(run: Run, d: DmcaSpec): Promise<string> {
  const anon = run.sessions.anon().client;
  const altcha = await run.sessions.altcha();
  const r = await step(run.ctx.signal, "an anonymous claimant", `file DMCA notice ${d.key}`, () =>
    anon.safety.dmca.submit({
      claimantName: d.claimant.name,
      claimantEmail: d.claimant.email,
      claimantAddress: d.claimant.address,
      claimantPhone: d.claimant.phone,
      copyrightedWork: TEXT.copyrightedWork,
      infringingUrls: [noticeUrl(run, d)],
      goodFaithStatement: true,
      accuracyStatement: true,
      signature: d.claimant.signature,
      altcha,
    }),
  );
  run.noticeIds.set(d.key, r.id);
  return r.id;
}

async function decideNotice(run: Run, d: DmcaSpec, decision: "actioned" | "rejected"): Promise<void> {
  const id = run.noticeIds.get(d.key);
  if (!id) throw new Error(`seed-safety: DMCA notice ${d.key} was not filed`);
  const mod = await run.sessions.as(STAFF.dmca);
  await step(run.ctx.signal, STAFF.dmca, `${decision} DMCA notice ${d.key}`, () =>
    mod.api.client.safety.dmca.action({ id, decision, note: TEXT.dmcaNote }),
  );
}

async function counterNotice(run: Run, d: DmcaSpec): Promise<string> {
  const id = run.noticeIds.get(d.key);
  if (!id || !d.counter) throw new Error(`seed-safety: DMCA notice ${d.key} has no counter to file`);
  const { handle, party } = d.counter;
  const owner = await run.sessions.as(handle);
  const mine = await owner.api.client.safety.dmca.mine();
  const itemIds = (mine.find((n) => n.id === id)?.items ?? [])
    .filter((i) => i.removedAt !== null && i.restoredAt === null)
    .map((i) => i.id);
  if (itemIds.length === 0) throw new Error(`seed-safety: ${handle} has no removed item on DMCA notice ${d.key}`);
  const r = await step(run.ctx.signal, handle, `counter DMCA notice ${d.key}`, () =>
    owner.api.client.safety.dmca.counter({
      id,
      fullName: party.name,
      address: party.address,
      phone: party.phone,
      itemIds,
      statement: TEXT.counterStatement,
      goodFaithStatement: true,
      consentToJurisdiction: true,
      signature: party.signature,
    }),
  );
  return r.restoreAfter;
}

async function dmca(run: Run): Promise<void> {
  const by = (state: DmcaSpec["state"]) => run.plan.dmca.filter((d) => d.state === state);
  // Restored first: its tick restores every countered notice due by then, so viewer2 counters after.
  for (const d of by("restored")) {
    await submitNotice(run, d);
    await decideNotice(run, d, "actioned");
    const restoreAfter = await counterNotice(run, d);
    const asOf = new Date(Date.parse(restoreAfter) + 60_000).toISOString();
    const r = await step(run.ctx.signal, "the test hooks", "run dmca-restore past restore-after", () =>
      run.hooks.dmcaTick(asOf),
    );
    if (r.restored < 1) throw new Error(`seed-safety: the DMCA restore tick restored nothing (${JSON.stringify(r)})`);
  }
  for (const d of by("received")) await submitNotice(run, d);
  for (const d of by("rejected")) {
    await submitNotice(run, d);
    await decideNotice(run, d, "rejected");
  }
  for (const d of by("countered")) {
    await submitNotice(run, d);
    await decideNotice(run, d, "actioned");
    await counterNotice(run, d);
  }
  // banned: notices filed while its clips are public, then its suspension (a statement of reasons),
  // then the actions: the third strike records the repeat-infringer termination.
  const actioned = by("actioned");
  for (const d of actioned) await submitNotice(run, d);
  const s = run.plan.adminSuspension;
  if (s) {
    const admin = await run.sessions.as("admin");
    await step(run.ctx.signal, "admin", `suspend ${s.handle}`, () =>
      admin.api.client.safety.suspend({
        username: userOf(run.ctx, s.handle).username,
        target: "user",
        suspended: true,
        reason: TEXT.suspension,
        clauseId: s.clauseId,
      }),
    );
  }
  for (const d of actioned) await decideNotice(run, d, "actioned");
  if (actioned.length >= DMCA_RULES.repeatInfringerStrikes) {
    const banned = await run.sessions.as("banned");
    const acts = await banned.api.client.appeals.accountActions();
    if (!acts.some((a) => a.action === "dmca_termination" && a.reversedAt === null))
      throw new Error("seed-safety: banned has no dmca_termination after its third strike");
  }
}

// ---------------------------------------------------------------- NCII

async function ncii(run: Run): Promise<void> {
  const { ctx } = run;
  const mod = await run.sessions.as(STAFF.ncii);
  const submit = async (s: SafetyPlan["ncii"][number]) => {
    const { ch, id } = clipOf(run, s.clip);
    const altcha = await run.sessions.altcha();
    return step(ctx.signal, "an anonymous requester", `file the ${s.state} takedown request`, () =>
      run.sessions.anon().client.ncii.submit({
        requesterName: s.requester.name,
        requesterEmail: s.requester.email,
        relationship: "self",
        contentUrls: [nciiClipUrl(ctx.env.HARNESS_WEB_URL, ch.slug, id)],
        description: TEXT.nciiDescription,
        goodFaith: true,
        signature: s.requester.signature,
        altcha,
      }),
    );
  };
  // The clock first: a tick past this request's deadline would also catch any request filed before it.
  for (const s of run.plan.ncii.filter((x) => x.state === "auto_hidden")) {
    const r = await submit(s);
    const asOf = new Date(Date.parse(r.deadlineAt) + 60_000).toISOString();
    await step(ctx.signal, "the test hooks", "run the NCII clock past the deadline", () => run.hooks.nciiTick(asOf));
  }
  for (const s of run.plan.ncii.filter((x) => x.state !== "auto_hidden")) {
    const r = await submit(s);
    if (s.state === "removed" || s.state === "rejected") {
      const decision = s.state;
      await step(ctx.signal, STAFF.ncii, `decide the takedown request ${decision}`, () =>
        mod.api.client.ncii.decide({ id: r.id, decision, note: TEXT.nciiNote }),
      );
    }
  }
}

// ---------------------------------------------------------------- reports

interface ChatLine {
  id: string;
  userId: string;
}

/** Chat lines to report, oldest first, by nobody the plan acts on otherwise (and never staff). */
async function chatLines(h: DbHandle, exclude: ReadonlySet<string>, n: number): Promise<ChatLine[]> {
  if (n <= 0) return [];
  const rows = await h.sql<ChatLine[]>`
    select id::text as id, user_id::text as "userId" from chat_messages
     where deleted_at is null and user_id is not null
       and not (user_id::text = any(${h.sql.array([...exclude])}))
     order by created_at, id limit ${n}`;
  return rows;
}

async function chatLineBy(h: DbHandle, userId: string): Promise<ChatLine | null> {
  const [row] = await h.sql<ChatLine[]>`
    select id::text as id, user_id::text as "userId" from chat_messages
     where user_id = ${userId} and deleted_at is null order by created_at, id limit 1`;
  return row ?? null;
}

async function reports(run: Run): Promise<void> {
  const { ctx, plan } = run;
  const id = (h: string) => userOf(ctx, h).id;
  // Chat lines by fixed logins (their screens have their own purposes) and by accounts the plan
  // already acts on are never reported.
  const staffAndParties = new Set(
    ctx.store.users
      .filter((u) => u.kind === "fixed" || u.kind === "bot")
      .map((u) => u.handle)
      .concat(
        plan.restricted,
        plan.live.map((l) => l.handle),
      )
      .concat(plan.reports.flatMap((r) => (r.subject.kind === "user" ? [r.subject.handle] : [])))
      .map(id),
  );
  const chatIndexes = plan.reports.flatMap((r) => (r.subject.kind === "chat" ? [r.subject.index] : []));
  const lines = await chatLines(ctx.db, staffAndParties, Math.max(0, ...chatIndexes) + 1);
  const subjectOf = async (
    r: ReportSpec,
  ): Promise<{ subjectType: "chat_message" | "channel" | "user" | "clip"; subjectId: string } | null> => {
    switch (r.subject.kind) {
      case "chat": {
        const line = lines[r.subject.index];
        return line ? { subjectType: "chat_message", subjectId: line.id } : null;
      }
      case "chatBy": {
        const line = await chatLineBy(ctx.db, id(r.subject.authorHandle));
        return line ? { subjectType: "chat_message", subjectId: line.id } : null;
      }
      case "channel": {
        const owner = r.subject.ownerHandle;
        const c = ctx.store.channels.find((x) => x.ownerHandle === owner);
        return c ? { subjectType: "channel", subjectId: c.id } : null;
      }
      case "user":
        return { subjectType: "user", subjectId: id(r.subject.handle) };
      case "clip":
        return { subjectType: "clip", subjectId: clipOf(run, r.subject.clip).id };
    }
  };
  const mod = await run.sessions.as(STAFF.reports);
  let skipped = 0;
  for (const r of plan.reports) {
    let subject = await subjectOf(r);
    let outcome = r.outcome;
    // viewer2 wrote no chat line: its lesser action falls back to a brief suspension of the account.
    if (!subject && r.subject.kind === "chatBy") {
      subject = { subjectType: "user", subjectId: id(r.subject.authorHandle) };
      outcome = {
        status: "actioned",
        action: "suspend_user",
        clauseId: REASON_CLAUSES.harassment,
        durationSeconds: CELL_SUSPENSION_SECONDS,
      };
      run.notes.push(
        `seed-safety: ${r.subject.authorHandle} has no chat line, so its lesser action is a 60 s suspension`,
      );
    }
    if (!subject) {
      skipped++;
      continue;
    }
    const reporter = await run.sessions.as(r.reporter);
    const created = await step(ctx.signal, r.reporter, `file report ${r.key}`, () =>
      reporter.api.client.safety.report({ ...subject, reason: r.reason, details: "" }),
    );
    run.reportIds.set(r.key, created.id);
    if (outcome.status === "open") continue;
    const resolution = outcome.status === "dismissed" ? TEXT.dismissal : TEXT.resolution;
    const o = outcome;
    await step(ctx.signal, STAFF.reports, `resolve report ${r.key}`, () =>
      mod.api.client.safety.resolve(
        o.status === "dismissed"
          ? { id: created.id, status: "dismissed", resolution }
          : {
              id: created.id,
              status: "actioned",
              resolution,
              action: o.action,
              ...(o.durationSeconds ? { durationSeconds: o.durationSeconds } : {}),
              ...(o.clauseId ? { clauseId: o.clauseId } : {}),
            },
      ),
    );
  }
  if (skipped > 0) run.notes.push(`seed-safety: ${skipped} chat reports skipped (not enough chat lines to report)`);
}

// ---------------------------------------------------------------- appeals

async function modActionOf(h: DbHandle, reportId: string): Promise<string | null> {
  const [row] = await h.sql<{ id: string }[]>`
    select id::text as id from mod_actions where report_id = ${reportId} order by created_at limit 1`;
  return row?.id ?? null;
}

async function appeals(run: Run): Promise<void> {
  const { ctx } = run;
  for (const a of run.plan.appeals) {
    if (a.subject.kind === "label") continue;
    const who = await run.sessions.as(a.appellant);
    let created: { id: string };
    if (a.subject.kind === "reportAction") {
      const reportId = run.reportIds.get(a.subject.reportKey);
      const actionId = reportId ? await modActionOf(ctx.db, reportId) : null;
      if (!actionId) throw new Error(`seed-safety: report ${a.subject.reportKey} has no mod action to appeal`);
      created = await step(ctx.signal, a.appellant, `appeal ${a.key}`, () =>
        who.api.client.appeals.create({
          kind: "moderation",
          subjectType: "moderation_action",
          subjectId: actionId,
          body: TEXT.appeal,
        }),
      );
    } else {
      const acts = await who.api.client.appeals.accountActions();
      const subject = a.subject;
      const act =
        subject.kind === "termination"
          ? acts.find((x) => x.action === "dmca_termination" && x.reversedAt === null)
          : acts.find((x) => x.action === "dmca_strike" && x.sourceId === run.noticeIds.get(subject.dmcaKey));
      if (!act) throw new Error(`seed-safety: ${a.appellant} has no account action for appeal ${a.key}`);
      created = await step(ctx.signal, a.appellant, `appeal ${a.key}`, () =>
        who.api.client.appeals.create({
          kind: "account",
          subjectType: "account_action",
          subjectId: act.id,
          body: TEXT.appeal,
        }),
      );
    }
    await resolveAppeal(run, created.id, a);
  }
}

// ---------------------------------------------------------------- legal hold, incidents

async function legalAndIncidents(run: Run): Promise<void> {
  const { ctx, plan } = run;
  const hold = plan.legalHold;
  if (hold) {
    const legal = await run.sessions.as("legal");
    await step(ctx.signal, "legal", `place a legal hold on ${hold.handle}`, () =>
      legal.api.client.admin.legalHold({
        username: userOf(ctx, hold.handle).username,
        hold: true,
        reasonCode: hold.reasonCode,
        reason: TEXT.hold,
      }),
    );
  }
  const admin = await run.sessions.as("admin");
  for (const inc of plan.incidents) {
    let id: string | undefined;
    for (const status of inc.statuses) {
      const r = await step(ctx.signal, "admin", `post incident "${inc.title}" (${status})`, () =>
        admin.api.client.admin.incidents({
          ...(id ? { id } : {}),
          title: inc.title,
          status,
          components: inc.components,
          body: inc.body,
        }),
      );
      id = r.id;
    }
  }
}

// ---------------------------------------------------------------- data export, deletion

async function privacy(run: Run): Promise<void> {
  const { ctx, plan } = run;
  const u = await run.sessions.as(plan.dataExport);
  const job = await step(ctx.signal, plan.dataExport, "request an account data export", () =>
    u.api.client.me.exports.create({ kind: "account" }),
  );
  await waitFor(
    `${plan.dataExport}'s data export built by the worker`,
    async () => {
      const mine = await u.api.client.me.exports.list();
      const e = mine.find((x) => x.id === job.id);
      if (e?.status === "failed") throw new Error("the export failed");
      return e?.status === "ready" ? e : null;
    },
    { timeoutMs: EXPORT_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
  );
  const who = plan.deletion;
  if (who) {
    const d = await run.sessions.as(who);
    await step(ctx.signal, who, "schedule account deletion", () =>
      d.api.client.me.deletion.request({ confirmUsername: userOf(ctx, who).username }),
    );
  }
}

// ---------------------------------------------------------------- attestations and group appeals

async function attestations(run: Run): Promise<number> {
  const { ctx, plan } = run;
  let attested = 0;
  for (const b of plan.attestations) {
    await step(ctx.signal, "the test hooks", `roll up broadcast ${b.broadcastId}`, () =>
      run.analytics.tick("broadcast-rollup", b.broadcastId),
    );
    const r = await step(ctx.signal, "the test hooks", `attest broadcast ${b.broadcastId}`, () =>
      run.analytics.tick("integrity-attestation", b.broadcastId),
    );
    if ((r.attested ?? 0) + (r.unchanged ?? 0) + (r.superseded ?? 0) > 0) attested++;
  }
  if (plan.attestations.length > 0 && attested === 0)
    throw new Error("seed-safety: no recorded broadcast was attested: set INTEGRITY_SIGNING_KEY on the worker");
  const s1 = ctx.store.channels.find((c) => c.ownerHandle === "streamer1");
  if (!s1 || !plan.attestations.some((b) => b.channelId === s1.id)) return attested;
  await run.analytics.bypass(s1.id, true);
  const owner = await run.sessions.as("streamer1");
  const chain = await owner.api.client.integrity.attestations.list({ channel: s1.slug, limit: 100 });
  const entries = chain.items.filter((e) => !e.superseded).slice(0, 2);
  for (const [i, e] of entries.entries())
    await step(ctx.signal, "streamer1", "share an attestation", () =>
      owner.api.client.integrity.attestations.share({ channel: s1.slug, id: e.id, expiresInDays: i === 0 ? 30 : 7 }),
    );
  return attested;
}

async function groupAppealStep(run: Run): Promise<string | null> {
  const { ctx, plan } = run;
  const s1 = ctx.store.channels.find((c) => c.ownerHandle === "streamer1");
  if (!s1 || plan.groupAppealCandidates.length === 0) return null;
  const owner = await run.sessions.as("streamer1");
  for (const b of plan.groupAppealCandidates) {
    const view = await owner.api.client.analytics.broadcast({ channel: s1.slug, broadcastId: b.broadcastId });
    const group = view.exclusions.find((g) => g.sessions > 0);
    if (!group) continue;
    const appeal = await step(ctx.signal, "streamer1", `appeal the ${group.category} exclusion group`, () =>
      owner.api.client.appeals.create({
        kind: "integrity",
        subjectType: "exclusion_group",
        subjectId: b.broadcastId,
        category: group.category,
        body: TEXT.appeal,
      }),
    );
    const admin = await run.sessions.as("admin");
    await step(ctx.signal, "admin", "overturn the group appeal", () =>
      admin.api.client.appeals.resolve({ id: appeal.id, status: "overturned", resolution: TEXT.appealResolution }),
    );
    return group.category;
  }
  return null;
}

async function integrityFlagsStep(run: Run): Promise<number> {
  const admin = await run.sessions.as("admin");
  let n = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await admin.api.client.integrity.flags({ cursor, limit: 100 });
    n += r.items.length;
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return n;
}

// ---------------------------------------------------------------- transparency and jury

async function enforcementCells(run: Run): Promise<void> {
  const want = new Set<string>(CELLS.map((c) => `${c.clauseId}@1`));
  const anon = run.sessions.anon().client;
  await waitFor(
    `the statement builder states the ${CELLS.length} cell suspensions (/transparency cells reach k = ${K})`,
    async () => {
      const r = await anon.transparency.enforcement({ window: "30d" });
      const reached = r.rows.filter((x) => want.has(x.ruleRef) && !x.count.suppressed && x.count.value >= K);
      return reached.length >= CELLS.length ? reached : null;
    },
    { timeoutMs: STATEMENT_TIMEOUT_MS, intervalMs: 3_000, signal: run.ctx.signal },
  );
  // banned's suspension statement has its deliveries once the worker sends them.
  const bannedId = userOf(run.ctx, "banned").id;
  await waitFor(
    "banned's statement of reasons delivered",
    async () => {
      const [row] = await run.ctx.db.sql<{ n: number }[]>`
        select count(*)::int as n from enforcement_statement_deliveries d
          join enforcement_statements s on s.id = d.statement_id
         where s.recipient_user_id = ${bannedId}`;
      return (row?.n ?? 0) > 0;
    },
    { timeoutMs: STATEMENT_TIMEOUT_MS, intervalMs: 3_000, signal: run.ctx.signal },
  );
  // viewer2's brief suspension is stated too: /settings/appeals lists it.
  const viewer2 = await run.sessions.as("viewer2");
  await waitFor(
    "viewer2's statement of reasons on /settings/appeals",
    async () => ((await viewer2.api.client.me.enforcement.list({ limit: 1 })).items.length > 0 ? true : null),
    { timeoutMs: STATEMENT_TIMEOUT_MS, intervalMs: 3_000, signal: run.ctx.signal },
  );
}

async function juryStep(run: Run): Promise<{ juryCaseIds: string[]; juryReportIds: string[] }> {
  const mod = await run.sessions.as("mod");
  const cases: JuryCaseCandidate[] = [];
  for (const status of ["cleared", "actioned"] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await mod.api.client.moderation.queue({ cursor, limit: 100, status });
      cases.push(...r.items.map((c) => ({ id: c.id, tier: c.tier, status: c.status, listCategory: null })));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
  }
  const reportRows: JuryReportCandidate[] = [];
  for (const status of ["actioned", "dismissed"] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await mod.api.client.safety.queue({ cursor, limit: 100, status });
      reportRows.push(...r.items.map((x) => ({ id: x.id, status: x.status, reason: x.reason })));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
  }
  const out = juryInputs(cases, reportRows);
  if (out.juryCaseIds.length + out.juryReportIds.length < 10)
    throw new Error(
      `seed-safety: only ${out.juryCaseIds.length + out.juryReportIds.length} jury inputs (seed-coop needs 10)`,
    );
  return out;
}
