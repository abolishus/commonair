// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 8: DMCA takedown and counter-notice (docs/testing/e7-selectors.md,
 * "Scenarios"; 17 U.S.C. § 512, not reviewed by a lawyer). Streamer G clips a run-unique pattern;
 * an anonymous claimant files a notice for the clip on `/dmca` (`--set via=api`:
 * `safety.dmca.submit`); a platform moderator actions it on `/admin/dmca`; the clip is gone for
 * owner and public and its media URL answers 404 once `dmca-disable` ran; G has a strike and the
 * `dmcaNoticeReceived` mail; G files a counter-notice on `/settings/copyright`
 * (`data-restore-after` = 12 weekdays after filing) and the claimant gets the forwarded copy;
 * `dmca-tick` just before restore-after restores nothing, just after restores the clip, its media
 * URL and reverses the strike; G gets `contentRestored`; the audit log shows the four steps in
 * order. API only: a second notice, countered, then `suitFiled`: a tick past restore-after
 * leaves it down.
 *
 * The claimant's details are synthetic, added to the log needles, and never put in the report.
 */
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import { DMCA_RULES } from "@commonair/contracts/enums";
import type { Locator, Page } from "playwright";
import { solveAltcha } from "../altcha.ts";
import { absoluteUrl, apiError, errorOf, isNotFound, nciiClipUrl, textNeedles } from "../safety.ts";
import { clipState } from "../safety-db.ts";
import { mediaBucketConfig, mediaKeyExists } from "../safety-io.ts";
import {
  API_SETTLE_MS,
  NOTE,
  UI_TIMEOUT_MS,
  benign,
  newStreamer,
  publisher,
  title,
  waitClip,
  waitLive,
  type Run,
  type Streamer,
} from "../safety-run.ts";
import { sleep, waitFor } from "../wait.ts";
import type { WebSession } from "../web/session.ts";
import { E7_ROUTES, E7_TEST_IDS as T, byE7Id } from "./selectors.ts";

// ---------------------------------------------------------------- pure helpers

const DAY_MS = 86_400_000;

/** `start` plus `n` weekdays in UTC (the API's rule; holidays are not modelled). */
export function addWeekdaysUtc(startMs: number, n: number): number {
  let t = startMs;
  let added = 0;
  while (added < n) {
    t += DAY_MS;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) added++;
  }
  return t;
}

/**
 * Whether `restoreAfter` is `DMCA_RULES.restoreWeekdays` weekdays after a filing that happened
 * between `beforeMs` and `afterMs` (the receipt's round trip), with `slackMs` for clock skew.
 */
export function restoreAfterOk(beforeMs: number, afterMs: number, restoreAfter: string, slackMs = 5_000): boolean {
  const at = Date.parse(restoreAfter);
  if (Number.isNaN(at)) return false;
  const lo = addWeekdaysUtc(beforeMs - slackMs, DMCA_RULES.restoreWeekdays);
  const hi = addWeekdaysUtc(afterMs + slackMs, DMCA_RULES.restoreWeekdays);
  return at >= lo && at <= hi;
}

/** The two `dmca-tick` instants: one minute before and one minute after restore-after. */
export function dmcaTickTimes(restoreAfter: string): { before: string; after: string } {
  const at = Date.parse(restoreAfter);
  return { before: new Date(at - 60_000).toISOString(), after: new Date(at + 60_000).toISOString() };
}

/** Private prefix the `dmca-disable` job moves objects to (services/worker/src/dmca/objects.ts). */
export const DMCA_HIDDEN_PREFIX = "moderation/dmca/";

/** A media URL's object key (`<MEDIA_PUBLIC_URL>/clips/<file>` → `clips/<file>`). */
export function mediaKeyOf(url: string): string | null {
  const m = /\/((?:clips|vods|thumbnails|channels)\/.+)$/.exec(new URL(url).pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** Whether `expected` occurs in `actions` in this order (other actions may come in between). */
export function inOrder(actions: readonly string[], expected: readonly string[]): boolean {
  let i = 0;
  for (const a of actions) if (a === expected[i]) i++;
  return i === expected.length;
}

export const DMCA_AUDIT_ORDER = [
  "dmca.notice.submit",
  "dmca.notice.action",
  "dmca.counter.receive",
  "dmca.content.restore",
] as const;

export interface ClaimantInput {
  name: string;
  email: string;
  address: string;
  phone: string;
  work: string;
  signature: string;
  urls: string[];
}

export interface CounterFields {
  name: string;
  address: string;
  phone: string;
  statement: string;
  signature: string;
}

/** Synthetic, run-unique claimant details (never in the report; log needles). */
export function claimantFor(runId: string, n: number, emailDomain: string, urls: string[]): ClaimantInput {
  return {
    name: `Harness Claimant ${runId} ${n}`,
    email: `dmca_${runId}_${n}@${emailDomain}`.toLowerCase(),
    address: `${n} Harness Rights Road ${runId}`,
    phone: `+1 555 01${String(n).padStart(2, "0")}`,
    work: `Synthetic harness work ${runId} ${n}`,
    signature: `Harness Claimant ${runId} ${n}`,
    urls,
  };
}

export function counterFieldsFor(runId: string, n: number): CounterFields {
  return {
    name: `Harness Uploader ${runId} ${n}`,
    address: `${n} Harness Uploader Lane ${runId}`,
    phone: `+1 555 02${String(n).padStart(2, "0")}`,
    statement: `Synthetic harness counter-notice ${runId} ${n}: removed by mistake`,
    signature: `Harness Uploader ${runId} ${n}`,
  };
}

// ---------------------------------------------------------------- web flows

interface Budget {
  timeoutMs: number;
  signal: AbortSignal;
}

async function visible(locator: Locator, timeoutMs = 3_000): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Reload `path` until `probe` passes (each page shows server state as of its load). */
async function untilOnPage<R>(
  session: WebSession,
  path: string,
  what: string,
  probe: (page: Page) => Promise<R | null>,
  b: Budget,
): Promise<R> {
  return waitFor(
    what,
    async () => {
      const page = await session.goto(path);
      try {
        await page.waitForLoadState("networkidle", { timeout: 5_000 });
      } catch {
        // The probe decides.
      }
      return probe(page);
    },
    { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
  );
}

async function confirmIfAsked(page: Page, b: Budget) {
  const confirm = page.locator('[data-testid="confirm-dialog-confirm"]').first();
  if (await visible(confirm, 5_000)) await confirm.click({ timeout: b.timeoutMs });
}

/** Fill `/dmca` and submit; returns the receipt's notice id. Retries until ALTCHA is solved and accepted. */
export async function submitDmcaWeb(session: WebSession, c: ClaimantInput, b: Budget): Promise<string> {
  const ui = { timeout: b.timeoutMs };
  const page = await session.goto(E7_ROUTES.dmca);
  await byE7Id(page, T.dmcaForm).first().waitFor(ui);
  const text = [
    [T.dmcaName, c.name],
    [T.dmcaEmail, c.email],
    [T.dmcaAddress, c.address],
    [T.dmcaPhone, c.phone],
    [T.dmcaWork, c.work],
    [T.dmcaUrls, c.urls.join("\n")],
    [T.dmcaSignature, c.signature],
  ] as const;
  for (const [id, value] of text) await byE7Id(page, id).first().fill(value, ui);
  await byE7Id(page, T.dmcaGoodFaith).first().check(ui);
  await byE7Id(page, T.dmcaAccuracy).first().check(ui);
  const receipt = byE7Id(page, T.dmcaReceipt).first();
  await waitFor(
    "dmca-receipt (ALTCHA solved and the notice accepted)",
    async () => {
      if (await receipt.isVisible()) return true;
      // A fill that lands before hydration is reset by React; put it back before submitting.
      for (const [id, value] of text) {
        const field = byE7Id(page, id).first();
        if ((await field.inputValue({ timeout: 2_000 }).catch(() => value)) !== value)
          await field.fill(value, { timeout: 2_000 }).catch(() => undefined);
      }
      for (const id of [T.dmcaGoodFaith, T.dmcaAccuracy])
        await byE7Id(page, id)
          .first()
          .check({ timeout: 2_000 })
          .catch(() => undefined);
      if (!(await visible(byE7Id(page, T.dmcaAltcha, { state: "verified" }), 1_000))) return null;
      const submit = byE7Id(page, T.dmcaSubmit).first();
      if ((await submit.isVisible()) && (await submit.isEnabled()))
        await submit.click({ timeout: 2_000 }).catch(() => undefined);
      return (await visible(receipt, 2_000)) ? true : null;
    },
    { timeoutMs: Math.max(b.timeoutMs, 60_000), intervalMs: 1_000, signal: b.signal },
  );
  return (await receipt.getAttribute("data-notice-id", ui)) ?? "";
}

/** A platform moderator actions the notice on `/admin/dmca` (decision → note → confirm). */
export async function actionDmcaWeb(session: WebSession, noticeId: string, note: string, b: Budget): Promise<void> {
  const ui = { timeout: b.timeoutMs };
  const page = await untilOnPage(
    session,
    E7_ROUTES.adminDmca,
    `dmcaq-item ${noticeId}`,
    async (p) => ((await visible(byE7Id(p, T.dmcaqItem, { "notice-id": noticeId }))) ? p : null),
    b,
  );
  await byE7Id(page, T.dmcaqItem, { "notice-id": noticeId }).first().click(ui);
  const detail = byE7Id(page, T.dmcaqDetail, { "notice-id": noticeId }).first();
  await detail.waitFor(ui);
  await byE7Id(detail, T.dmcaqDecisionActioned).first().click(ui);
  await byE7Id(detail, T.dmcaqNote).first().fill(note, ui);
  await byE7Id(detail, T.dmcaqSubmit).first().click(ui);
  await confirmIfAsked(page, b);
  await byE7Id(page, T.dmcaqDetail, { "notice-id": noticeId, status: "actioned" }).first().waitFor(ui);
}

/** G files the counter-notice on `/settings/copyright`; returns the receipt's attributes. */
export async function counterDmcaWeb(
  session: WebSession,
  noticeId: string,
  f: CounterFields,
  b: Budget,
): Promise<{ counterId: string; restoreAfter: string }> {
  const ui = { timeout: b.timeoutMs };
  const page = await untilOnPage(
    session,
    E7_ROUTES.copyright,
    `copyright-notice ${noticeId} with counter-open`,
    async (p) => {
      const notice = byE7Id(p, T.copyrightNotice, { "notice-id": noticeId }).first();
      return (await visible(byE7Id(notice, T.counterOpen))) ? p : null;
    },
    b,
  );
  const notice = byE7Id(page, T.copyrightNotice, { "notice-id": noticeId }).first();
  await byE7Id(notice, T.counterOpen).first().click(ui);
  const form = byE7Id(page, T.counterForm).first();
  await form.waitFor(ui);
  for (const [id, value] of [
    [T.counterName, f.name],
    [T.counterAddress, f.address],
    [T.counterPhone, f.phone],
    [T.counterStatement, f.statement],
    [T.counterSignature, f.signature],
  ] as const)
    await byE7Id(form, id).first().fill(value, ui);
  await byE7Id(form, T.counterGoodFaith).first().check(ui);
  await byE7Id(form, T.counterJurisdiction).first().check(ui);
  await byE7Id(form, T.counterSubmit).first().click(ui);
  await confirmIfAsked(page, b);
  const receipt = byE7Id(notice, T.counterReceipt).first();
  await receipt.waitFor(ui);
  return {
    counterId: (await receipt.getAttribute("data-counter-id", ui)) ?? "",
    restoreAfter: (await receipt.getAttribute("data-restore-after", ui)) ?? "",
  };
}

// ---------------------------------------------------------------- API flows

async function altchaPayload(run: Run): Promise<string> {
  const api = run.ctx.platform.api();
  const res = await api.fetch(new Request(`${api.baseUrl}${AUTH_ROUTES.altchaChallenge}`));
  if (!res.ok) throw new Error(`ALTCHA challenge answered HTTP ${res.status}`);
  return solveAltcha(await res.json());
}

async function submitDmcaApi(run: Run, c: ClaimantInput): Promise<string> {
  const r = await run.anon().safety.dmca.submit({
    claimantName: c.name,
    claimantEmail: c.email,
    claimantAddress: c.address,
    claimantPhone: c.phone,
    copyrightedWork: c.work,
    infringingUrls: c.urls,
    goodFaithStatement: true,
    accuracyStatement: true,
    signature: c.signature,
    altcha: await altchaPayload(run),
  });
  return r.id;
}

async function counterDmcaApi(g: Streamer, noticeId: string, f: CounterFields) {
  const mine = await g.user.api.client.safety.dmca.mine();
  const n = mine.find((x) => x.id === noticeId);
  const itemIds = (n?.items ?? []).filter((i) => i.removedAt !== null && i.restoredAt === null).map((i) => i.id);
  const r = await g.user.api.client.safety.dmca.counter({
    id: noticeId,
    fullName: f.name,
    address: f.address,
    phone: f.phone,
    itemIds,
    statement: f.statement,
    goodFaithStatement: true,
    consentToJurisdiction: true,
    signature: f.signature,
  });
  const after = await g.user.api.client.safety.dmca.mine();
  return { counterId: after.find((x) => x.id === noticeId)?.counter?.id ?? "", restoreAfter: r.restoreAfter };
}

/** G's DMCA strike for this notice: from `appeals.accountActions` (E7-appeals), else the database. */
async function strikeOf(run: Run, g: Streamer, noticeId: string) {
  const err = await errorOf(() => g.user.api.client.appeals.accountActions());
  if (err === null) {
    const actions = await g.user.api.client.appeals.accountActions();
    const s = actions.find((a) => a.action === "dmca_strike" && a.sourceId === noticeId);
    return s ? { reversedAt: s.reversedAt, reversedReason: s.reversedReason, via: "api" as const } : null;
  }
  // Until E7-appeals lands, `appeals.accountActions` answers NOT_IMPLEMENTED: read the row directly.
  const { createDb } = await import("@commonair/db");
  const handle = createDb({ url: run.databaseUrl, max: 1, applicationName: "commonair-harness" });
  try {
    const [row] = await handle.sql<{ reversed_at: Date | null; reversed_reason: string | null }[]>`
      select reversed_at, reversed_reason::text as reversed_reason from account_actions
       where user_id = ${g.user.id} and action = 'dmca_strike' and source_type = 'dmca_notice' and source_id = ${noticeId}`;
    return row
      ? { reversedAt: row.reversed_at?.toISOString() ?? null, reversedReason: row.reversed_reason, via: "db" as const }
      : null;
  } finally {
    await handle.close();
  }
}

async function mediaStatus(url: string, signal: AbortSignal): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  await res.body?.cancel();
  return res.status;
}

// ---------------------------------------------------------------- the step

export async function stepDmca(run: Run): Promise<void> {
  const { ctx, staff, hooks, databaseUrl } = run;
  const t = (w: string) => title(8, w);
  const b = { timeoutMs: UI_TIMEOUT_MS, signal: ctx.signal };
  const g = await ctx.step(t("sign up streamer G"), () => newStreamer(run, "ts_g"));
  const { pub } = await publisher(run, g, benign(run, 8));
  await ctx.step(t("G goes live with a run-unique benign pattern"), () => pub.start());
  await waitLive(run, g.channel);
  await sleep(10_000, ctx.signal);
  const clip1 = await ctx.step(t("G clips the stream (clip 1)"), () =>
    g.user.api.client.clips.create({ channel: g.channel, title: "harness dmca clip 1", durationSeconds: 5 }),
  );
  await sleep(6_000, ctx.signal);
  const clip2 = await ctx.step(t("G clips the stream (clip 2, for the suit check)"), () =>
    g.user.api.client.clips.create({ channel: g.channel, title: "harness dmca clip 2", durationSeconds: 5 }),
  );
  const [ready1] = await ctx.step(t("both clips are ready"), () =>
    Promise.all([waitClip(run, g, clip1.id), waitClip(run, g, clip2.id)]),
  );
  await pub.stop(1_000);
  const media1 = absoluteUrl(ready1.url as string, ctx.env.HARNESS_API_URL);
  const bucket = mediaBucketConfig(ctx.env);

  const claimant = claimantFor(ctx.runId, 1, ctx.env.HARNESS_EMAIL_DOMAIN, [
    nciiClipUrl(ctx.env.HARNESS_WEB_URL, g.channel, clip1.id),
  ]);
  const counterFields = counterFieldsFor(ctx.runId, 1);
  run.emails.push(claimant.email);
  run.needles.push(
    ...textNeedles("dmca-claimant", [claimant.name, claimant.address, claimant.work, claimant.signature]),
    ...textNeedles("dmca-counter", [counterFields.name, counterFields.address, counterFields.statement]),
    ...textNeedles("dmca-url", claimant.urls),
  );

  const noticeId = await ctx.step(t("the claimant files a notice for clip 1 → dmca-receipt"), async () =>
    run.via === "web"
      ? submitDmcaWeb(await run.webSession("dmca-claimant"), claimant, b)
      : submitDmcaApi(run, claimant),
  );
  ctx.assert("DMCA: the receipt carries a notice id", /^[0-9a-f-]{36}$/.test(noticeId), { noticeId });
  const queued = await staff.mod.api.client.safety.dmca.queue({ status: "received", limit: 100 });
  const mine = [...queued.items].find((n) => n.id === noticeId);
  run.check(
    "DMCA: the notice's URL resolved to clip 1",
    mine?.items.some((i) => i.subjectType === "clip" && i.subjectId === clip1.id) === true,
    { items: mine?.items.map((i) => ({ subjectType: i.subjectType, subjectId: i.subjectId })) },
  );

  if (run.via === "web") {
    const ms = await run.webSession("moderator-dmca", staff.mod);
    await ctx.step(t("web: the moderator actions the notice"), () => actionDmcaWeb(ms, noticeId, NOTE, b));
  } else {
    await ctx.step(t("the moderator actions the notice (API)"), () =>
      staff.mod.api.client.safety.dmca.action({ id: noticeId, decision: "actioned", note: NOTE }),
    );
  }

  await ctx.step(t("clip 1 is gone for owner and public"), async () => {
    for (const [who, client] of [
      ["owner", g.user.api.client],
      ["public", run.anon()],
    ] as const) {
      const err = await errorOf(() => client.clips.get({ id: clip1.id }));
      ctx.assert(`DMCA: clip 1 is not found for the ${who}`, isNotFound(err), apiError(err));
    }
    const st = await clipState(databaseUrl, clip1.id);
    ctx.assert("DMCA: clip 1 keeps its status, removed_reason = dmca", st.removedReason === "dmca", st);
  });
  await ctx.step(t("clip 1's media URL answers 404 once dmca-disable ran"), async () => {
    await waitFor("clip 1 media 404", async () => (await mediaStatus(media1, ctx.signal)) === 404, {
      timeoutMs: API_SETTLE_MS * 2,
      intervalMs: 1_000,
      signal: ctx.signal,
    });
    const key = mediaKeyOf(media1);
    if (bucket && key)
      run.check(
        "DMCA: clip 1's object is under the private DMCA prefix",
        await mediaKeyExists(bucket, `${DMCA_HIDDEN_PREFIX}${key}`),
      );
  });
  const strike = await ctx.step(t("G has an unreversed dmca_strike"), () => strikeOf(run, g, noticeId));
  ctx.assert(
    "DMCA: G has a strike for the notice, not reversed",
    strike !== null && strike.reversedAt === null,
    strike,
  );
  await ctx.step(t("G got the dmcaNoticeReceived mail"), () =>
    ctx.platform.mailpit.waitForMessage(g.user.email, (m) => m.subject.startsWith("Copyright notice about")),
  );

  const before = Date.now();
  const counter = await ctx.step(t("G files a counter-notice → counter-receipt"), async () =>
    run.via === "web"
      ? counterDmcaWeb(await run.webSession("streamer-g", g.user), noticeId, counterFields, b)
      : counterDmcaApi(g, noticeId, counterFields),
  );
  const after = Date.now();
  ctx.assert(
    `DMCA: restore-after is ${DMCA_RULES.restoreWeekdays} weekdays after filing`,
    restoreAfterOk(before, after, counter.restoreAfter),
    { restoreAfter: counter.restoreAfter, filedAt: new Date(before).toISOString() },
  );
  await ctx.step(t("the claimant got the forwarded counter-notice"), () =>
    ctx.platform.mailpit.waitForMessage(claimant.email, (m) => m.subject.startsWith("Counter-notice received")),
  );

  const ticks = dmcaTickTimes(counter.restoreAfter);
  const early = await ctx.step(t("dmca-tick at restore-after − 1 min restores nothing"), () =>
    hooks.dmcaTick(ticks.before),
  );
  ctx.assert(
    "DMCA: clip 1 is still down before the waiting period ends",
    (await clipState(databaseUrl, clip1.id)).removedReason === "dmca",
    early,
  );
  const late = await ctx.step(t("dmca-tick at restore-after + 1 min restores the clip"), () =>
    hooks.dmcaTick(ticks.after),
  );
  run.check("DMCA: the tick restored at least one item", late.restored >= 1, late);
  await ctx.step(t("clip 1 and its media URL are back"), async () => {
    await waitFor("clip 1 listed again", async () => (await clipState(databaseUrl, clip1.id)).removedReason === null, {
      timeoutMs: API_SETTLE_MS,
      intervalMs: 1_000,
      signal: ctx.signal,
    });
    const c = await run.anon().clips.get({ id: clip1.id });
    ctx.assert("DMCA: clip 1 is public again", c.id === clip1.id && c.status === "ready");
    ctx.assert("DMCA: clip 1's media URL answers 200 again", (await mediaStatus(media1, ctx.signal)) === 200);
  });
  const reversed = await strikeOf(run, g, noticeId);
  ctx.assert(
    "DMCA: the strike is reversed (counter_notice_restored)",
    reversed?.reversedReason === "counter_notice_restored",
    reversed,
  );
  await ctx.step(t("G got the contentRestored mail"), () =>
    ctx.platform.mailpit.waitForMessage(g.user.email, (m) => m.subject.startsWith("Your content is available again")),
  );
  const audit = await staff.mod.api.client.safety.auditLog({
    subjectType: "dmca_notice",
    subjectId: noticeId,
    limit: 100,
  });
  const actions = audit.items.map((a) => a.action).reverse();
  ctx.assert(
    "DMCA: the audit log shows submit, action, counter, restore in order",
    inOrder(actions, DMCA_AUDIT_ORDER),
    {
      actions,
    },
  );

  let suit: { noticeId: string; counterId: string; restoreAfter: string } | null = null;
  if (run.via === "api") {
    const second = claimantFor(ctx.runId, 2, ctx.env.HARNESS_EMAIL_DOMAIN, [
      nciiClipUrl(ctx.env.HARNESS_WEB_URL, g.channel, clip2.id),
    ]);
    const counter2 = counterFieldsFor(ctx.runId, 2);
    run.emails.push(second.email);
    run.needles.push(...textNeedles("dmca-claimant", [second.name, second.address, second.signature]));
    suit = await ctx.step(t("API: a second notice, countered, then suit filed"), async () => {
      const id = await submitDmcaApi(run, second);
      await staff.mod.api.client.safety.dmca.action({ id, decision: "actioned", note: NOTE });
      const c = await counterDmcaApi(g, id, counter2);
      await staff.mod.api.client.safety.dmca.suitFiled({ id: c.counterId, note: NOTE });
      return { noticeId: id, ...c };
    });
    await ctx.step(t("API: a tick past restore-after leaves clip 2 down"), () =>
      hooks.dmcaTick(dmcaTickTimes(suit?.restoreAfter ?? new Date().toISOString()).after),
    );
    ctx.assert(
      "DMCA: with a suit filed, clip 2 stays down",
      (await clipState(databaseUrl, clip2.id)).removedReason === "dmca",
    );
  }
  ctx.data("step8", {
    notice: { id: noticeId, counterId: counter.counterId, restoreAfter: counter.restoreAfter },
    ticks: { before: ticks.before, early, after: ticks.after, late },
    strike: { via: strike?.via ?? null, reversedReason: reversed?.reversedReason ?? null },
    auditActions: actions,
    suit,
    clips: [clip1.id, clip2.id],
  });
}
