// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `trust-safety` scenario's web flows (default `via=web`), selecting only by the routes and
 * test ids of docs/testing/e4c-selectors.md. Each flow navigates fresh, so one page per session
 * is enough. Frames and evidence are never revealed: the checks read data attributes only.
 */
import type { Locator, Page } from "playwright";
import { waitFor } from "./wait.ts";
import { waitForOneOf } from "./web/flows.ts";
import { ROUTES, TEST_IDS as T, modqDecision, tid } from "./web/selectors.ts";
import { type WebSession, byTestId } from "./web/session.ts";

export interface WebBudget {
  timeoutMs: number;
  signal: AbortSignal;
}

/** Reload `path` until `probe` passes (the page shows server state as of its load). */
async function untilOnPage<T>(
  session: WebSession,
  path: string,
  what: string,
  probe: (page: Page) => Promise<T | null>,
  b: WebBudget,
): Promise<T> {
  return waitFor(
    what,
    async () => {
      const page = await session.goto(path);
      try {
        await page.waitForLoadState("networkidle", { timeout: 5_000 });
      } catch {
        // Long-polling pages never go idle; the probe decides.
      }
      return probe(page);
    },
    { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
  );
}

async function visible(locator: Locator, timeoutMs = 3_000): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Click and, when the action asks for confirmation, confirm. */
async function clickConfirming(page: Page, target: Locator, b: WebBudget): Promise<void> {
  await target.click({ timeout: b.timeoutMs });
  const confirm = byTestId(page, T.confirmDialogConfirm).first();
  if (await visible(confirm, 2_000)) await confirm.click({ timeout: b.timeoutMs });
}

// ---------------------------------------------------------------- viewer side

/** `/$channel` shows `mature-gate` (with the sign-in link for a signed-out viewer). */
export async function waitMatureGate(
  session: WebSession,
  channel: string,
  signedOut: boolean,
  b: WebBudget,
): Promise<void> {
  await untilOnPage(
    session,
    ROUTES.channel(channel),
    `${channel}: mature-gate`,
    async (page) => {
      if (!(await visible(byTestId(page, T.matureGate)))) return null;
      if (signedOut && !(await visible(byTestId(page, T.matureGateSignin), 1_000))) return null;
      return true;
    },
    b,
  );
}

/** `/$channel` shows the player again and no `mature-gate`. */
export async function waitNoMatureGate(session: WebSession, channel: string, b: WebBudget): Promise<void> {
  await untilOnPage(
    session,
    ROUTES.channel(channel),
    `${channel}: player without mature-gate`,
    async (page) => {
      if (!(await visible(byTestId(page, T.player)))) return null;
      return (await byTestId(page, T.matureGate).count()) === 0 ? true : null;
    },
    b,
  );
}

/** `/$channel` shows `stream-restricted` with `data-reason="under_review"`. */
export async function waitStreamRestricted(session: WebSession, channel: string, b: WebBudget): Promise<void> {
  await untilOnPage(
    session,
    ROUTES.channel(channel),
    `${channel}: stream-restricted`,
    async (page) => ((await visible(byTestId(page, T.streamRestricted, { reason: "under_review" }))) ? true : null),
    b,
  );
}

/** The owner sees `moderation-label-notice` on `/dashboard` and appeals it through the dialog. */
export async function appealLabel(session: WebSession, labelId: string, body: string, b: WebBudget): Promise<void> {
  const page = await untilOnPage(
    session,
    ROUTES.dashboard,
    `moderation-label-notice for ${labelId}`,
    async (p) =>
      (await visible(byTestId(p, T.moderationLabelNotice, { "label-id": labelId, label: "mature" }))) ? p : null,
    b,
  );
  const notice = byTestId(page, T.moderationLabelNotice, { "label-id": labelId }).first();
  await notice.locator(tid(T.labelAppealOpen)).first().click({ timeout: b.timeoutMs });
  const dialog = byTestId(page, T.labelAppealDialog).first();
  await dialog.waitFor({ timeout: b.timeoutMs });
  await dialog.locator(tid(T.labelAppealBody)).first().fill(body, { timeout: b.timeoutMs });
  await dialog.locator(tid(T.labelAppealSubmit)).first().click({ timeout: b.timeoutMs });
  await dialog.waitFor({ state: "hidden", timeout: b.timeoutMs });
}

export interface NciiFormInput {
  name: string;
  email: string;
  urls: readonly string[];
  description: string;
  signature: string;
}

/**
 * Fill `/takedown` and submit; returns the receipt's request id and deadline. The ALTCHA widget
 * has no test id of its own, so submission is retried until it is accepted.
 */
export async function submitTakedown(
  session: WebSession,
  input: NciiFormInput,
  b: WebBudget,
): Promise<{ requestId: string; deadlineAt: string; receiptAtMs: number }> {
  const ui = { timeout: b.timeoutMs };
  const page = await session.goto(ROUTES.takedown);
  const form = byTestId(page, T.nciiForm).first();
  await form.waitFor(ui);
  const text = [
    [T.nciiName, input.name],
    [T.nciiEmail, input.email],
    [T.nciiUrls, input.urls.join("\n")],
    [T.nciiDescription, input.description],
    [T.nciiSignature, input.signature],
  ] as const;
  for (const [id, value] of text) await byTestId(page, id).first().fill(value, ui);
  await byTestId(page, T.nciiRelationship).first().click(ui);
  await byTestId(page, T.nciiRelationshipSelf).first().click(ui);
  await byTestId(page, T.nciiGoodFaith).first().check(ui);
  const receipt = byTestId(page, T.nciiReceipt).first();
  await waitFor(
    "ncii-receipt (ALTCHA solved and the request accepted)",
    async () => {
      if (await receipt.isVisible()) return true;
      // A fill that lands before hydration is reset by React; put it back before submitting.
      for (const [id, value] of text) {
        const field = byTestId(page, id).first();
        if ((await field.inputValue({ timeout: 2_000 }).catch(() => value)) !== value)
          await field.fill(value, { timeout: 2_000 }).catch(() => undefined);
      }
      const submit = byTestId(page, T.nciiSubmit).first();
      if ((await submit.isVisible()) && (await submit.isEnabled()))
        await submit.click({ timeout: 2_000 }).catch(() => undefined);
      return (await visible(receipt, 2_000)) ? true : null;
    },
    { timeoutMs: Math.max(b.timeoutMs, 60_000), intervalMs: 1_000, signal: b.signal },
  );
  const receiptAtMs = Date.now();
  const requestId = (await receipt.getAttribute("data-request-id", ui)) ?? "";
  const deadlineAt = (await receipt.getAttribute("data-deadline-at", ui)) ?? "";
  return { requestId, deadlineAt, receiptAtMs };
}

// ---------------------------------------------------------------- moderators

/** `/admin/appeals`: resolve one appeal. */
export async function resolveAppeal(
  session: WebSession,
  appealId: string,
  status: "upheld" | "overturned",
  resolution: string,
  b: WebBudget,
): Promise<void> {
  const ui = { timeout: b.timeoutMs };
  const page = await untilOnPage(
    session,
    ROUTES.adminAppeals,
    `appealq-item ${appealId}`,
    async (p) => ((await visible(byTestId(p, T.appealqItem, { "appeal-id": appealId }))) ? p : null),
    b,
  );
  const row = byTestId(page, T.appealqItem, { "appeal-id": appealId }).first();
  await row.click(ui);
  await byTestId(page, status === "overturned" ? T.appealqResolveOverturned : T.appealqResolveUpheld)
    .first()
    .click(ui);
  await byTestId(page, T.appealqResolution).first().fill(resolution, ui);
  await clickConfirming(page, byTestId(page, T.appealqSubmit).first(), b);
}

export interface ModqCaseView {
  tier: string | null;
  frames: { flagId: string | null; revealed: string | null; provider: string | null }[];
  history: { action: string | null; actorType: string | null }[];
  status: string | null;
}

/** A queue row opens through its toggle button (`aria-pressed`), not by clicking the row. */
async function openModqItem(item: Locator, b: WebBudget): Promise<void> {
  await item.locator("button[aria-pressed]").first().click({ timeout: b.timeoutMs });
}

async function openModqCase(session: WebSession, caseId: string, b: WebBudget): Promise<Page> {
  return untilOnPage(
    session,
    ROUTES.adminModeration,
    `modq-item ${caseId}`,
    async (p) => {
      const tab = byTestId(p, T.modqTabCases).first();
      if (await visible(tab, 2_000)) await tab.click({ timeout: 2_000 }).catch(() => undefined);
      const item = byTestId(p, T.modqItem, { "case-id": caseId }).first();
      if (!(await visible(item))) return null;
      await openModqItem(item, b);
      return (await visible(byTestId(p, T.modqDetail, { "case-id": caseId }), 5_000)) ? p : null;
    },
    b,
  );
}

async function readCase(page: Page, caseId: string): Promise<ModqCaseView> {
  const item = byTestId(page, T.modqItem, { "case-id": caseId }).first();
  const detail = byTestId(page, T.modqDetail, { "case-id": caseId }).first();
  const frames = await detail.locator(tid(T.modqFrame)).evaluateAll((els) =>
    els.map((e) => ({
      flagId: e.getAttribute("data-flag-id"),
      revealed: e.getAttribute("data-revealed"),
      provider: e.getAttribute("data-provider"),
    })),
  );
  const history = await detail
    .locator(tid(T.modqHistoryRow))
    .evaluateAll((els) =>
      els.map((e) => ({ action: e.getAttribute("data-action"), actorType: e.getAttribute("data-actor-type") })),
    );
  return {
    tier: await item.getAttribute("data-tier", { timeout: 2_000 }).catch(() => null),
    status: await detail.getAttribute("data-status", { timeout: 2_000 }).catch(() => null),
    frames,
    history,
  };
}

/** `/admin/moderation`: the case's row, detail, blurred frames and history (nothing revealed). */
export async function viewModqCase(session: WebSession, caseId: string, b: WebBudget): Promise<ModqCaseView> {
  const page = await openModqCase(session, caseId, b);
  await byTestId(page, T.modqFrame).first().waitFor({ timeout: b.timeoutMs });
  return readCase(page, caseId);
}

/** `/admin/moderation`: decide `clear` with a note; returns the detail after the decision. */
export async function clearModqCase(
  session: WebSession,
  caseId: string,
  note: string,
  b: WebBudget,
): Promise<ModqCaseView> {
  const ui = { timeout: b.timeoutMs };
  const page = await openModqCase(session, caseId, b);
  await byTestId(page, modqDecision("clear")).first().click(ui);
  await byTestId(page, T.modqNote).first().fill(note, ui);
  await clickConfirming(page, byTestId(page, T.modqSubmit).first(), b);
  // The decided case stays open and refreshes in place (it leaves the open queue).
  await byTestId(page, T.modqDetail, { "case-id": caseId, status: "cleared" }).first().waitFor(ui);
  return readCase(page, caseId);
}

/** `/admin/moderation`: the T0 case never appears in the ordinary queue (checked after load). */
export async function modqHasCase(session: WebSession, caseId: string, b: WebBudget): Promise<boolean> {
  const page = await session.goto(ROUTES.adminModeration);
  await byTestId(page, T.modq).first().waitFor({ timeout: b.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  return (await page.locator(`[data-case-id="${caseId}"]`).count()) > 0;
}

/** `/admin/moderation` NCII tab: decide `removed` with a note. */
export async function decideNcii(session: WebSession, requestId: string, note: string, b: WebBudget): Promise<void> {
  const ui = { timeout: b.timeoutMs };
  const page = await untilOnPage(
    session,
    ROUTES.adminModeration,
    `modq-item ncii ${requestId}`,
    async (p) => {
      const tab = byTestId(p, T.modqTabNcii).first();
      if (await visible(tab, 2_000)) await tab.click({ timeout: 2_000 }).catch(() => undefined);
      return (await visible(byTestId(p, T.modqItem, { "ncii-id": requestId }))) ? p : null;
    },
    b,
  );
  await openModqItem(byTestId(page, T.modqItem, { "ncii-id": requestId }).first(), b);
  await byTestId(page, T.nciiDecisionRemoved).first().click(ui);
  await byTestId(page, T.nciiNote).first().fill(note, ui);
  await clickConfirming(page, byTestId(page, T.nciiDecideSubmit).first(), b);
}

// ---------------------------------------------------------------- legal

export interface LegalPageView {
  caseStatus: string | null;
  caseList: string | null;
  firstReviewer: string | null;
  evidence: number;
  holdReasons: string[];
  ncmecStatuses: string[];
  dismissDisabled: boolean | null;
}

/** `/admin/legal` for one case: its row, evidence rows (not opened), holds and NCMEC drafts. */
export async function viewLegalCase(
  session: WebSession,
  caseId: string,
  want: { status?: string },
  b: WebBudget,
): Promise<LegalPageView> {
  const page = await untilOnPage(
    session,
    ROUTES.adminLegal,
    `legal-case ${caseId}${want.status ? ` (${want.status})` : ""}`,
    async (p) => {
      const row = byTestId(p, T.legalCase, { "case-id": caseId, ...(want.status ? { status: want.status } : {}) });
      return (await visible(row)) ? p : null;
    },
    b,
  );
  const row = byTestId(page, T.legalCase, { "case-id": caseId }).first();
  const attr = (name: string) => row.getAttribute(name, { timeout: 2_000 }).catch(() => null);
  const dismiss = row.locator(tid(T.legalDismiss)).first();
  const dismissDisabled = (await dismiss.count()) > 0 ? await dismiss.isDisabled() : null;
  const reasons = await byTestId(page, T.legalHold).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-reason") ?? ""),
  );
  const ncmec = await byTestId(page, T.legalNcmec).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-status") ?? ""),
  );
  return {
    caseStatus: await attr("data-status"),
    caseList: await attr("data-list"),
    firstReviewer: await attr("data-first-reviewer"),
    evidence: await byTestId(page, T.legalEvidence).count(),
    holdReasons: reasons,
    ncmecStatuses: ncmec,
    dismissDisabled,
  };
}

/** A non-legal user opening `/admin/legal` sees no legal case rows (the not-found page). */
export async function legalPageHidden(session: WebSession, b: WebBudget): Promise<boolean> {
  const page = await session.goto(ROUTES.adminLegal);
  await page.waitForLoadState("networkidle", { timeout: Math.min(b.timeoutMs, 10_000) }).catch(() => undefined);
  return (await byTestId(page, T.legalCase).count()) === 0 && (await byTestId(page, T.legalEvidence).count()) === 0;
}

/** Wait until one of the viewer-side ids shows on `/$channel` (used to tell gate from player). */
export async function channelShows(
  session: WebSession,
  channel: string,
  b: WebBudget,
): Promise<"mature-gate" | "stream-restricted" | "player"> {
  const page = await session.goto(ROUTES.channel(channel));
  return waitForOneOf(page, [T.matureGate, T.streamRestricted, T.player], b.timeoutMs, b.signal);
}
