// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E6, account deletion (docs/testing/e6-selectors.md, "Scenario `account-deletion`"):
 * 1 U tips S and subscribes (both confirmed, with ledger postings), chats, follows and has a
 * ready export; 2 U requests deletion on `/settings/privacy` (the scheduled email arrives), an
 * admin expedites it and an `account-deletion` ops tick completes it; 3 U's identity is gone (no
 * sign-in, pseudonymized username, no email, sessions, linked accounts or export object, no chat
 * message on S's channel); 4 history is kept (payments, balanced ledger transactions, audit and
 * `*_history` rows still reference U's id; S's revenue still includes the tip); 5 no retained
 * table (`ledger_*`, `payments`, `tips`, `audit_log`, `*_history`, `events`,
 * `webhook_deliveries`) holds U's old email, username, display name, chat text or tip message;
 * 6 the completed email reached U's old address.
 *
 * `--set via=api` requests the deletion with `me.deletion.request`. The report carries ids,
 * counts and table names only: never U's email, name, messages or the export link.
 */
import { exportObjectKey } from "@commonair/contracts/internal";
import { auditRowsReferencing, historyRefCounts, identityState, paymentsOf, piiScan } from "../src/e6/db.ts";
import { download, exportMailLink, requestExport, waitExportReady } from "../src/e6/exports.ts";
import {
  type Kit,
  UI_TIMEOUT_MS,
  chatOnce,
  confirmedSubscription,
  confirmedTip,
  exportsBucketConfig,
  setTiers,
  setupKit,
  staffAccount,
} from "../src/e6/kit.ts";
import { E6_ROUTES, E6_TEST_IDS as E, byE6Id } from "../src/e6/selectors.ts";
import { confirmDialog, dataOf } from "../src/e6/web.ts";
import { ApiTreasurer } from "../src/money-actors.ts";
import { ledgerSums } from "../src/money-db.ts";
import { unbalancedTransactions } from "../src/money.ts";
import { deletionState } from "../src/safety-db.ts";
import { mediaKeyExists } from "../src/safety-io.ts";
import { errorOf } from "../src/safety.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { ROUTES, TEST_IDS as T } from "../src/web/selectors.ts";

const DELETION_TIMEOUT_MS = 3 * 60_000;
/** The deletion emails' subjects (instance locale `en`, as the harness signs users up). */
const SCHEDULED_SUBJECT = /will be deleted/i;
const COMPLETED_SUBJECT = /has been deleted/i;

export default defineScenario({
  name: "account-deletion",
  description:
    "U tips, subscribes, chats, follows, exports → requests deletion on /settings/privacy (scheduled email) → admin expedites, ops tick completes → identity gone, history kept and balanced, no PII in retained tables → completed email",
  needs: ["api", "web", "chat", "worker", "mail", "browser"],
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const kit = await setupKit(ctx);
    await accountDeletion(ctx, kit);
    kit.done();
  },
});

async function accountDeletion(ctx: ScenarioContext, kit: Kit): Promise<void> {
  const p = ctx.platform;
  const tag = ctx.runId;
  const [u, s] = await ctx.step("sign up U and streamer S (API)", () =>
    Promise.all([
      p.signUp({ prefix: "e6ad_u", displayName: `Udeleted ${tag}`.slice(0, 30) }),
      p.signUp({ prefix: "e6ad_s" }),
    ]),
  );
  const treasurerUser = await staffAccount(kit, "e6ad_tr", "treasurer");
  const admin = await staffAccount(kit, "e6ad_ad", "admin");
  const treasurer = new ApiTreasurer(treasurerUser.api.client);
  const sChannel = s.me.channelSlug ?? s.username;
  ctx.data("users", { u: u.username, s: s.username, treasurer: treasurerUser.username, admin: admin.username });
  const text = { chat: `e6ad chat ${tag}`, tip: `e6ad tip ${tag}` };

  // ------------------------------------------------------------ 1. activity
  await ctx.step("1 S sets subscription tiers", () => setTiers(s, sChannel));
  const tip = await ctx.step("1 U tips S (confirmed)", () =>
    confirmedTip(kit, treasurer, u, sChannel, { cents: 500, message: text.tip }),
  );
  const sub = await ctx.step("1 U subscribes to S at tier 1 (confirmed)", () =>
    confirmedSubscription(kit, treasurer, u, sChannel, 1),
  );
  await ctx.step("1 U chats in S's channel and follows S", async () => {
    await chatOnce(kit, u, sChannel, text.chat);
    await u.api.client.channels.follow({ channel: sChannel });
  });
  const session = kit.via === "web" ? await kit.webSession("U", u) : null;
  const exportId = await ctx.step("1 U requests an account export", () => requestExport(kit, session, u, "account"));
  await ctx.step("1 the export is ready", () => waitExportReady(kit, session, u, exportId));
  const exportLink = await ctx.step("1 the export email arrived", () => exportMailLink(kit, u, exportId));
  const before = await ctx.step("1 history referencing U before deletion (DB)", async () => ({
    audit: await auditRowsReferencing(kit.databaseUrl, u.id),
    history: await historyRefCounts(kit.databaseUrl, u.id),
  }));
  ctx.data("before", before);

  // ------------------------------------------------------------ 2. request, expedite, complete
  await ctx.step("2 U requests deletion", async () => {
    if (session) {
      const page = await session.goto(E6_ROUTES.privacy);
      await byE6Id(page, E.deletionRequest).click({ timeout: UI_TIMEOUT_MS });
      await byE6Id(page, E.deletionConfirmUsername).fill(u.username, { timeout: UI_TIMEOUT_MS });
      await confirmDialog(page, UI_TIMEOUT_MS);
      const d = await dataOf(byE6Id(page, E.deletionStatus, { status: "scheduled" }), UI_TIMEOUT_MS);
      ctx.assert("2 deletion-status shows a scheduled date", Boolean(d.scheduledFor && Date.parse(d.scheduledFor)));
    } else {
      await u.api.client.me.deletion.request({ confirmUsername: u.username });
    }
  });
  const scheduled = await u.api.client.me.deletion.get();
  ctx.assert("2 me.deletion.get is scheduled", scheduled?.status === "scheduled", { status: scheduled?.status });
  await ctx.step("2 Mailpit has the scheduled email", () =>
    p.mailpit.waitForMessage(u.email, (m) => SCHEDULED_SUBJECT.test(m.subject), 60_000),
  );
  await ctx.step("2 an admin expedites the deletion", () =>
    admin.api.client.admin.expediteDeletion({ username: u.username, reason: "harness account-deletion scenario" }),
  );
  await ctx.step("2 ops tick account-deletion completes it", () =>
    kit.ops.tickUntil(
      "account-deletion",
      "U's deletion completed",
      async () =>
        (await deletionState(kit.databaseUrl, u.id, u.username)).deletionStatus === "completed" ? true : null,
      { timeoutMs: DELETION_TIMEOUT_MS },
    ),
  );

  // ------------------------------------------------------------ 3. identity gone
  const signIn = await errorOf(() => p.users.signIn(u));
  ctx.assert("3 U cannot sign in", signIn !== null);
  const identity = await identityState(kit.databaseUrl, u.id, u.email);
  ctx.data("identity", identity);
  ctx.assert("3 the users row remains with a deleted_… username", identity.exists && identity.usernamePseudonymized);
  ctx.assert("3 the users row no longer holds U's email", !identity.emailKept, {
    placeholder: identity.emailDeletedPlaceholder,
  });
  ctx.assert("3 U's sessions and linked accounts are gone", identity.sessions === 0 && identity.accounts === 0, {
    sessions: identity.sessions,
    accounts: identity.accounts,
  });
  ctx.assert("3 U's export rows are gone", identity.exports === 0, { exports: identity.exports });
  const bucket = exportsBucketConfig(kit);
  if (bucket) {
    ctx.assert("3 the export object is gone", !(await mediaKeyExists(bucket, exportObjectKey(u.id, exportId))));
  } else ctx.check("3 S3_* credentials set to HEAD the exports bucket", false);
  const oldLink = await download(exportLink, ctx.signal);
  ctx.assert("3 the export link no longer downloads", oldLink.bytes === null, { status: oldLink.status });
  const history = await kit.anon().chat.history({ channel: sChannel, limit: 200 });
  ctx.assert(
    "3 S's channel chat has no message of U",
    !history.some((m) => m.user.id === u.id || m.body.includes(text.chat)),
  );
  if (kit.via === "web") {
    const viewer = await kit.webSession("viewer");
    const page = await viewer.goto(ROUTES.channel(sChannel));
    await page.locator(`[data-testid="${T.chat}"]`).first().waitFor({ timeout: UI_TIMEOUT_MS });
    const bodies = await page.locator(`[data-testid="${T.chatMessage}"]`).allTextContents();
    ctx.assert("3 S's channel page shows no message of U", !bodies.some((b) => b.includes(text.chat)));
  }

  // ------------------------------------------------------------ 4. history kept
  const payments = await paymentsOf(kit.databaseUrl, u.id);
  const ids = payments.map((x) => x.id);
  ctx.assert(
    "4 U's payments still exist and reference U's id",
    ids.includes(tip.paymentId) && ids.includes(sub.paymentId),
    { payments: payments.length },
  );
  const ledger = await ledgerSums(kit.databaseUrl, [tip.paymentId, sub.paymentId]);
  const posted = new Set(ledger.rows.map((r) => r.refId));
  ctx.assert(
    "4 the tip's and the subscription's ledger transactions exist",
    posted.has(tip.paymentId) && posted.has(sub.paymentId),
    { transactions: ledger.rows.length },
  );
  const unbalanced = unbalancedTransactions(ledger.rows);
  ctx.assert("4 each of those ledger transactions sums to 0", unbalanced.length === 0, {
    unbalanced: unbalanced.map((r) => r.transactionId),
  });
  const auditAfter = await auditRowsReferencing(kit.databaseUrl, u.id);
  ctx.assert("4 audit rows naming U as actor or subject still exist", auditAfter >= before.audit && auditAfter > 0, {
    before: before.audit,
    after: auditAfter,
  });
  const historyAfter = await historyRefCounts(kit.databaseUrl, u.id);
  const lost = Object.entries(before.history).filter(([t, n]) => (historyAfter[t] ?? 0) < n);
  ctx.data("historyRows", { before: before.history, after: historyAfter });
  ctx.assert("4 *_history rows referencing U's id are all kept", lost.length === 0, { lost: lost.map(([t]) => t) });
  const revenue = await s.api.client.money.revenue({ channel: sChannel });
  ctx.assert("4 S's revenue still includes the tip", revenue.bySource.tips > 0, { tips: revenue.bySource.tips });

  // ------------------------------------------------------------ 5. no PII in retained tables
  const scan = await ctx.step("5 scan the retained tables for U's personal data (DB)", () =>
    piiScan(kit.databaseUrl, [
      { label: "email", value: u.email },
      { label: "username", value: u.username },
      { label: "displayName", value: u.displayName },
      { label: "chat", value: text.chat },
      { label: "tipMessage", value: text.tip },
    ]),
  );
  ctx.data("piiScan", scan);
  ctx.assert("5 the scan covered the retained tables", scan.tables > 0 && scan.columns > 0, {
    tables: scan.tables,
  });
  ctx.assert(
    "5 no retained table holds U's email, username, display name, chat or tip text",
    scan.hits.length === 0,
    scan.hits,
  );

  // ------------------------------------------------------------ 6. completed email
  await ctx.step("6 the completed email reached U's old address", () =>
    p.mailpit.waitForMessage(u.email, (m) => COMPLETED_SUBJECT.test(m.subject), 60_000),
  );
}
