// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `e5-coop` scenario's co-op flows (docs/testing/e5-selectors.md), each with a web
 * implementation (Playwright, by route and test id only) and an API one (`--set via=api`), so the
 * scenario is written once and both paths assert the same state. Payment confirmation and
 * look-ups by reference reuse the E4b treasurer (`money-actors.ts`).
 */
import type { Locator, Page } from "playwright";
import type { ApiClient } from "./api/client.ts";
import {
  CONFIRM_DIALOG_CONFIRM,
  E5_ROUTES as R,
  E5_TEMPLATED_IDS as TT,
  E5_TEST_IDS as T,
  TREASURY,
  byCoopId,
} from "./coop-selectors.ts";
import { type Choice, type MemberClass, datetimeLocalUtc, utcMonthOf } from "./coop.ts";
import { E7_TEST_IDS as T7 } from "./e7/selectors.ts";
import { parseCents } from "./money.ts";
import type { WaitBudget } from "./social.ts";
import type { SignedInUser } from "./users.ts";
import { waitFor } from "./wait.ts";

export type { WaitBudget };

export interface ShareCheckout {
  paymentId: string;
  reference: string;
  cents: number;
}

export interface MembershipSnapshot {
  rows: { id: string; class: string; status: string; basis: string }[];
  eligibility: { class: string; eligible: boolean; basis: string | null; have: number | null; need: number | null }[];
  /** `none` when there is no share. */
  share: { id: string | null; status: string; cents: number | null };
}

export interface CouncilSnapshot {
  termId: string | null;
  members: { userId: string; rank: number | null }[];
}

export interface SettingSnapshot {
  key: string;
  protected: boolean;
  updatedBy: string | null;
}

export interface ProposalInput {
  title: string;
  body: string;
  changes: { key: string; value: unknown }[];
  affectsCreators: boolean;
}

export interface DraftResult {
  id: string;
  kind: string;
  status: string;
}

export interface TallyRowView {
  scope: string;
  yes: number | null;
  no: number | null;
  abstain: number | null;
  eligible: number | null;
}

/** A decided proposal's tally as shown (null while undecided). */
export interface TallyView {
  status: string;
  passed: boolean;
  reason: string;
  rows: TallyRowView[];
  checks: { rule: string; passed: boolean }[];
}

export interface PatronageRunView {
  periodId: string;
  members: number;
  cents: number;
}

export interface PeriodRowView {
  periodId: string;
  status: string;
  cents: number | null;
  computedBy: string | null;
  approvedBy: string | null;
  /** Web only: whether `patronage-approve` is disabled for the viewer (null when absent or via API). */
  approveDisabled: boolean | null;
}

export interface StatementView {
  periodId: string;
  status: string;
  cents: number;
  formulaVersion: string;
  lines: { component: string; cents: number | null; capApplied: boolean; explained: boolean }[];
}

export interface TransparencyView {
  governance: { proposalId: string; status: string; kind: string; passed: boolean | null; month: string }[];
  patronage: { month: string; cents: number }[];
}

/** One co-op flow per method; `user` is who acts. */
export interface CoopDriver {
  readonly via: "web" | "api";
  buyShare(user: SignedInUser, b: WaitBudget): Promise<ShareCheckout>;
  membership(user: SignedInUser, b: WaitBudget): Promise<MembershipSnapshot>;
  appointWorker(admin: SignedInUser, username: string, minute: string, b: WaitBudget): Promise<void>;
  /** Leave a class (`membership-exit-<class>` → confirm; `coop.exit`). */
  exit(user: SignedInUser, cls: MemberClass, b: WaitBudget): Promise<void>;
  /** Rejoin the viewer class on a subscription (`membership-rejoin-viewer` → confirm; `coop.join`). */
  rejoinViewer(user: SignedInUser, b: WaitBudget): Promise<void>;
  /** Save the draft, then submit it (`draft → discussion`). */
  draftAndSubmit(author: SignedInUser, input: ProposalInput, b: WaitBudget): Promise<DraftResult>;
  vote(user: SignedInUser, proposalId: string, choice: Choice, b: WaitBudget): Promise<{ myVote: string | null }>;
  tally(viewer: SignedInUser, proposalId: string, b: WaitBudget): Promise<TallyView | null>;
  council(viewer: SignedInUser, b: WaitBudget): Promise<CouncilSnapshot>;
  settings(viewer: SignedInUser, b: WaitBudget): Promise<SettingSnapshot[]>;
  refundShare(treasurer: SignedInUser, shareId: string, note: string, b: WaitBudget): Promise<void>;
  runPatronage(treasurer: SignedInUser, start: Date, end: Date, b: WaitBudget): Promise<PatronageRunView>;
  periods(staff: SignedInUser, b: WaitBudget): Promise<PeriodRowView[]>;
  approvePatronage(approver: SignedInUser, periodId: string, b: WaitBudget): Promise<void>;
  statement(member: SignedInUser, periodId: string, b: WaitBudget): Promise<StatementView>;
  transparency(viewer: SignedInUser, b: WaitBudget): Promise<TransparencyView>;
}

// ---------------------------------------------------------------- API

const MAX_PAGES = 10;

export class ApiCoop implements CoopDriver {
  readonly via = "api" as const;

  async buyShare(user: SignedInUser): Promise<ShareCheckout> {
    const r = await user.api.client.coop.buyShare({ returnPath: R.membership });
    if (r.kind !== "instructions")
      throw new Error("coop.buyShare answered a redirect (the manual adapter gives instructions)");
    return { paymentId: r.paymentId, reference: r.reference, cents: r.amount.cents };
  }

  async membership(user: SignedInUser): Promise<MembershipSnapshot> {
    return apiMembership(user.api.client);
  }

  async appointWorker(admin: SignedInUser, username: string, minute: string): Promise<void> {
    await admin.api.client.coop.appointWorker({ username, boardMinuteRef: minute });
  }

  async exit(user: SignedInUser, cls: MemberClass): Promise<void> {
    await user.api.client.coop.exit({ class: cls });
  }

  async rejoinViewer(user: SignedInUser): Promise<void> {
    await user.api.client.coop.join({ class: "viewer" });
  }

  async draftAndSubmit(author: SignedInUser, input: ProposalInput): Promise<DraftResult> {
    const draft = await author.api.client.coop.proposals.create(input);
    const p = await author.api.client.coop.proposals.submit({ id: draft.id });
    return { id: p.id, kind: p.kind, status: p.status };
  }

  async vote(user: SignedInUser, proposalId: string, choice: Choice): Promise<{ myVote: string | null }> {
    const p = await user.api.client.coop.proposals.vote({ id: proposalId, choice });
    return { myVote: p.myVote };
  }

  async tally(viewer: SignedInUser, proposalId: string): Promise<TallyView | null> {
    const p = await viewer.api.client.coop.proposals.get({ id: proposalId });
    if (!p.tally) return null;
    const { breakdown } = p.tally;
    const row = (scope: string, c: { yes: number; no: number; abstain: number; eligible: number } | undefined) => ({
      scope,
      yes: c?.yes ?? null,
      no: c?.no ?? null,
      abstain: c?.abstain ?? null,
      eligible: c?.eligible ?? null,
    });
    return {
      status: p.status,
      passed: p.tally.passed,
      reason: p.tally.reason,
      rows: [
        row("member_wide", breakdown.memberWide),
        row("streamer", breakdown.byClass.streamer),
        row("viewer", breakdown.byClass.viewer),
        row("worker", breakdown.byClass.worker),
      ],
      checks: breakdown.checks.map((c) => ({ rule: c.rule, passed: c.passed })),
    };
  }

  async council(viewer: SignedInUser): Promise<CouncilSnapshot> {
    const c = await viewer.api.client.coop.council();
    return { termId: c.termId, members: c.members.map((m) => ({ userId: m.user.id, rank: m.rank })) };
  }

  async settings(viewer: SignedInUser): Promise<SettingSnapshot[]> {
    return (await viewer.api.client.coop.settings()).map((s) => ({
      key: s.key,
      protected: s.protected,
      updatedBy: s.updatedByProposalId,
    }));
  }

  async refundShare(treasurer: SignedInUser, shareId: string, note: string): Promise<void> {
    await treasurer.api.client.coop.shares.refund({ shareId, sentAt: justNow(), note });
  }

  async runPatronage(treasurer: SignedInUser, start: Date, end: Date): Promise<PatronageRunView> {
    const r = await treasurer.api.client.coop.patronage.run({
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    });
    return { periodId: r.periodId, members: r.members, cents: r.total.cents };
  }

  async periods(staff: SignedInUser): Promise<PeriodRowView[]> {
    return (await staff.api.client.coop.patronage.periods()).map((p) => ({
      periodId: p.id,
      status: p.status,
      cents: p.total.cents,
      computedBy: p.computedBy?.id ?? null,
      approvedBy: p.approvedBy?.id ?? null,
      approveDisabled: null,
    }));
  }

  async approvePatronage(approver: SignedInUser, periodId: string): Promise<void> {
    await approver.api.client.coop.patronage.approve({ periodId });
  }

  async statement(member: SignedInUser, periodId: string): Promise<StatementView> {
    const s = await member.api.client.coop.patronage.statement({ periodId });
    return {
      periodId: s.periodId,
      status: s.status,
      cents: s.total.cents,
      formulaVersion: s.formulaVersion,
      lines: s.lines.map((l) => ({
        component: l.component,
        cents: l.amountCents,
        capApplied: l.capApplied,
        explained: l.explanation.trim().length > 0,
      })),
    };
  }

  async transparency(viewer: SignedInUser): Promise<TransparencyView> {
    const months = await viewer.api.client.coop.transparency({ months: 3 });
    return {
      governance: months.flatMap((m) =>
        m.governance.map((g) => ({
          proposalId: g.proposalId,
          status: g.status,
          kind: g.kind,
          passed: g.passed,
          month: m.month,
        })),
      ),
      patronage: months.map((m) => ({ month: m.month, cents: m.patronageDistributed.cents })),
    };
  }
}

/** `coop.membership` as a snapshot (the scenario polls it through the API on both paths). */
export async function apiMembership(api: ApiClient): Promise<MembershipSnapshot> {
  const m = await api.coop.membership();
  return {
    rows: m.memberships.map((x) => ({ id: x.id, class: x.class, status: x.status, basis: x.basis })),
    eligibility: m.eligibility.map((e) => ({
      class: e.class,
      eligible: e.eligible,
      basis: e.basis,
      have: e.progress?.have ?? null,
      need: e.progress?.need ?? null,
    })),
    share: m.share
      ? { id: m.share.id, status: m.share.status, cents: m.share.amount.cents }
      : { id: null, status: "none", cents: null },
  };
}

/** The active membership of a class, if any. */
export function activeIn(m: MembershipSnapshot, cls: MemberClass): MembershipSnapshot["rows"][number] | undefined {
  return m.rows.find((r) => r.class === cls && r.status === "active");
}

/** A moment safely in the past for `sentAt` / `receivedAt` (the API refuses the future). */
function justNow(): string {
  return new Date(Date.now() - 5_000).toISOString();
}

/** Every share of a status through `coop.shares.list` (treasury). */
export async function sharesByStatus(
  api: ApiClient,
  status: "pending" | "held" | "refund_pending" | "refunded" | "cancelled",
): Promise<{ id: string; userId: string; status: string; cents: number }[]> {
  const out: { id: string; userId: string; status: string; cents: number }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await api.coop.shares.list({ status, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const s of r.items) out.push({ id: s.id, userId: s.user.id, status: s.status, cents: s.amount.cents });
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

// ---------------------------------------------------------------- web helpers

type Dataset = Record<string, string | undefined>;

async function datasets(locator: Locator): Promise<Dataset[]> {
  return locator.evaluateAll((els) => els.map((e) => Object.fromEntries(Object.entries((e as HTMLElement).dataset))));
}

async function dataset(locator: Locator, timeoutMs: number): Promise<Dataset> {
  await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  return locator.first().evaluate((e) => Object.fromEntries(Object.entries((e as HTMLElement).dataset)));
}

const flag = (v: string | undefined) => v === "true";
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function visible(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Click, and confirm when the action opens the shared `ConfirmDialog`. */
/** Wait until the page's `membership-row` for `cls` shows a status `done` accepts (the refreshed view). */
async function waitForMembershipRow(
  page: Page,
  cls: MemberClass,
  done: (status: string) => boolean,
  b: WaitBudget,
): Promise<void> {
  await waitFor(
    `membership-row ${cls}`,
    async () => {
      const row = byCoopId(page, T.membershipRow, { class: cls }).first();
      const status = (await row.count()) > 0 ? await row.getAttribute("data-status") : null;
      return status !== null && done(status) ? true : null;
    },
    { timeoutMs: b.timeoutMs, intervalMs: 250, signal: b.signal },
  );
}

async function clickConfirming(page: Page, target: Locator, b: WaitBudget): Promise<void> {
  await target.click({ timeout: b.timeoutMs });
  const confirm = byCoopId(page, CONFIRM_DIALOG_CONFIRM).first();
  if (await visible(confirm, 2_000)) await confirm.click({ timeout: b.timeoutMs });
}

/** The element itself when it has `role`, else its first descendant with it (Base UI wraps controls). */
async function withRole(el: Locator, role: string, timeoutMs: number): Promise<Locator> {
  await el.first().waitFor({ timeout: timeoutMs });
  const own = await el.first().getAttribute("role");
  if (own === role) return el.first();
  const inner = el.first().locator(`[role="${role}"]`).first();
  return (await inner.count()) > 0 ? inner : el.first();
}

/** Turn a switch (or checkbox) on or off like a person: click only when needed. */
async function setSwitch(el: Locator, on: boolean, timeoutMs: number): Promise<void> {
  const control = await withRole(el, "switch", timeoutMs);
  const state = async () => {
    const aria = await control.getAttribute("aria-checked");
    if (aria !== null) return aria === "true";
    return (await control.getAttribute("data-checked")) !== null;
  };
  if ((await state()) !== on) await control.click({ timeout: timeoutMs });
}

/** Pick an item of a `SelectField`: open its trigger, click the item (rendered in a portal). */
async function selectItem(page: Page, field: Locator, itemId: string, timeoutMs: number): Promise<void> {
  const trigger = await withRole(field, "combobox", timeoutMs);
  await trigger.click({ timeout: timeoutMs });
  await byCoopId(page, itemId).first().click({ timeout: timeoutMs });
}

/** Reload `path` until `probe` passes (each page shows the server state as of its load). */
async function untilOnPage<V>(
  open: (path: string) => Promise<Page>,
  path: string,
  what: string,
  probe: (page: Page) => Promise<V | null>,
  b: WaitBudget,
): Promise<V> {
  return waitFor(
    what,
    async () => {
      const page = await open(path);
      try {
        await page.waitForLoadState("networkidle", { timeout: 5_000 });
      } catch {
        // Pages with live updates never go idle; the probe decides.
      }
      return probe(page);
    },
    { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
  );
}

// ---------------------------------------------------------------- web

/** Opens `path` in the user's signed-in browser session. */
export type OpenAs = (user: SignedInUser, path: string) => Promise<Page>;

export class WebCoop implements CoopDriver {
  readonly via = "web" as const;

  constructor(private readonly openAs: OpenAs) {}

  private open(user: SignedInUser) {
    return (path: string) => this.openAs(user, path);
  }

  async buyShare(user: SignedInUser, b: WaitBudget): Promise<ShareCheckout> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.openAs(user, R.membership);
    await byCoopId(page, T.membership).waitFor(ui);
    await clickConfirming(page, byCoopId(page, T.membershipBuyShare).first(), b);
    const panel = byCoopId(page, T.membershipShareInstructions).first();
    await panel.waitFor(ui);
    const d = await dataset(panel, b.timeoutMs);
    const cents = parseCents(d.cents);
    if (!d.paymentId || !d.reference || cents === null)
      throw new Error("membership-share-instructions lacks data-payment-id, data-reference or data-cents");
    return { paymentId: d.paymentId, reference: d.reference, cents };
  }

  async membership(user: SignedInUser, b: WaitBudget): Promise<MembershipSnapshot> {
    const page = await this.openAs(user, R.membership);
    await byCoopId(page, T.membership).waitFor({ timeout: b.timeoutMs });
    // The share card always renders (`none` without a share): it marks the page as loaded.
    const share = await dataset(byCoopId(page, T.membershipShare), b.timeoutMs);
    return {
      rows: (await datasets(byCoopId(page, T.membershipRow))).map((d) => ({
        id: d.membershipId ?? "",
        class: d.class ?? "",
        status: d.status ?? "",
        basis: d.basis ?? "",
      })),
      eligibility: (await datasets(byCoopId(page, T.membershipEligibility))).map((d) => ({
        class: d.class ?? "",
        eligible: flag(d.eligible),
        basis: d.basis || null,
        have: num(d.have),
        need: num(d.need),
      })),
      share: { id: null, status: share.status ?? "", cents: parseCents(share.cents) },
    };
  }

  async appointWorker(admin: SignedInUser, username: string, minute: string, b: WaitBudget): Promise<void> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.openAs(admin, R.adminCoop);
    await byCoopId(page, T.adminCoop).waitFor(ui);
    await byCoopId(page, T.appointWorkerUsername).fill(username, ui);
    await byCoopId(page, T.appointWorkerMinute).fill(minute, ui);
    await clickConfirming(page, byCoopId(page, T.appointWorkerSubmit), b);
  }

  async exit(user: SignedInUser, cls: MemberClass, b: WaitBudget): Promise<void> {
    const page = await this.openAs(user, R.membership);
    await byCoopId(page, T.membership).waitFor({ timeout: b.timeoutMs });
    await clickConfirming(page, byCoopId(page, TT.membershipExit(cls)).first(), b);
    await waitForMembershipRow(page, cls, (status) => status !== "active", b);
  }

  async rejoinViewer(user: SignedInUser, b: WaitBudget): Promise<void> {
    const page = await this.openAs(user, R.membership);
    await byCoopId(page, T.membership).waitFor({ timeout: b.timeoutMs });
    await clickConfirming(page, byCoopId(page, T7.membershipRejoinViewer).first(), b);
    await waitForMembershipRow(page, "viewer", (status) => status === "active", b);
  }

  async draftAndSubmit(author: SignedInUser, input: ProposalInput, b: WaitBudget): Promise<DraftResult> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.openAs(author, R.proposalNew);
    const form = byCoopId(page, T.proposalForm);
    await form.waitFor(ui);
    await byCoopId(page, T.proposalTitle).fill(input.title, ui);
    await byCoopId(page, T.proposalBody).fill(input.body, ui);
    await setSwitch(byCoopId(page, T.proposalAffectsCreators), input.affectsCreators, b.timeoutMs);
    for (const [i, change] of input.changes.entries()) {
      const rows = byCoopId(page, T.proposalChange);
      if ((await rows.count()) <= i) await byCoopId(page, T.proposalChangeAdd).click(ui);
      const row = rows.nth(i);
      await row.waitFor(ui);
      await selectItem(page, byCoopId(row, T.proposalChangeKey), TT.proposalChangeKeyItem(change.key), b.timeoutMs);
      // The row marks `data-protected` once a key is chosen (and may prefill the value).
      await waitFor(
        "proposal-change data-protected",
        async () => (await row.getAttribute("data-protected")) !== null || null,
        { timeoutMs: 5_000, intervalMs: 100, signal: b.signal },
      ).catch(() => undefined);
      await byCoopId(row, T.proposalChangeValue).fill(JSON.stringify(change.value, null, 2), ui);
    }
    const kindEl = byCoopId(page, T.proposalKind).first();
    const save = byCoopId(page, T.proposalSave);
    await waitFor("proposal-save enabled", async () => (await save.isEnabled()) || null, {
      timeoutMs: b.timeoutMs,
      intervalMs: 100,
      signal: b.signal,
    });
    const shownKind = (await kindEl.count()) > 0 ? await kindEl.getAttribute("data-kind") : null;
    await save.click(ui);
    // Saving navigates to the proposal page.
    const wrapper = byCoopId(page, T.proposal).first();
    await wrapper.waitFor(ui);
    const draft = await dataset(wrapper, b.timeoutMs);
    const id = draft.proposalId;
    if (!id) throw new Error("the proposal page has no data-proposal-id after saving");
    await clickConfirming(page, byCoopId(page, T.proposalSubmit).first(), b);
    const submitted = await untilOnPage(
      this.open(author),
      R.proposal(id),
      `proposal ${id} data-status=discussion`,
      async (p) => {
        const d = await dataset(byCoopId(p, T.proposal), b.timeoutMs);
        return d.status && d.status !== "draft" ? d : null;
      },
      b,
    );
    return { id, kind: submitted.kind ?? shownKind ?? "", status: submitted.status ?? "" };
  }

  async vote(
    user: SignedInUser,
    proposalId: string,
    choice: Choice,
    b: WaitBudget,
  ): Promise<{ myVote: string | null }> {
    const ui = { timeout: b.timeoutMs };
    const page = await untilOnPage(
      this.open(user),
      R.proposal(proposalId),
      `vote-panel data-can-vote=true on ${proposalId}`,
      async (p) => ((await byCoopId(p, T.votePanel, { "can-vote": "true" }).count()) > 0 ? p : null),
      b,
    );
    const panel = byCoopId(page, T.votePanel).first();
    const option = byCoopId(panel, TT.voteChoiceItem(choice)).first();
    await (await withRole(option, "radio", b.timeoutMs)).click(ui);
    await byCoopId(panel, T.voteSubmit).first().click(ui);
    const mine = await waitFor(
      `vote-panel data-my-vote=${choice}`,
      async () => {
        const v = await panel.getAttribute("data-my-vote", { timeout: 1_000 }).catch(() => null);
        return v === choice ? v : null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 200, signal: b.signal },
    );
    return { myVote: mine };
  }

  async tally(viewer: SignedInUser, proposalId: string, b: WaitBudget): Promise<TallyView | null> {
    const page = await this.openAs(viewer, R.proposal(proposalId));
    const wrapper = await dataset(byCoopId(page, T.proposal), b.timeoutMs);
    const tally = byCoopId(page, T.tally).first();
    if (!(await visible(tally, 3_000))) return null;
    const d = await dataset(tally, b.timeoutMs);
    return {
      status: wrapper.status ?? "",
      passed: flag(d.passed),
      reason: d.reason ?? "",
      rows: (await datasets(byCoopId(page, T.tallyRow))).map((r) => ({
        scope: r.scope ?? "",
        yes: num(r.yes),
        no: num(r.no),
        abstain: num(r.abstain),
        eligible: num(r.eligible),
      })),
      checks: (await datasets(byCoopId(page, T.tallyCheck))).map((c) => ({
        rule: c.rule ?? "",
        passed: flag(c.passed),
      })),
    };
  }

  async council(viewer: SignedInUser, b: WaitBudget): Promise<CouncilSnapshot> {
    const page = await this.openAs(viewer, R.council);
    const wrapper = byCoopId(page, T.council);
    // The wrapper renders (with an empty data-term-id) while the council loads: give it a moment
    // to fill in before reading. An instance with no term keeps it empty, so this is bounded.
    await wrapper
      .and(page.locator(":not([data-term-id=''])"))
      .waitFor({ timeout: Math.min(b.timeoutMs, 10_000) })
      .catch(() => undefined);
    const d = await dataset(wrapper, b.timeoutMs);
    return {
      termId: d.termId || null,
      members: (await datasets(byCoopId(page, T.councilMember))).map((m) => ({
        userId: m.userId ?? "",
        rank: num(m.rank),
      })),
    };
  }

  async settings(viewer: SignedInUser, b: WaitBudget): Promise<SettingSnapshot[]> {
    const page = await this.openAs(viewer, R.settings);
    await byCoopId(page, T.settings).waitFor({ timeout: b.timeoutMs });
    await byCoopId(page, T.settingRow).first().waitFor({ timeout: b.timeoutMs });
    return (await datasets(byCoopId(page, T.settingRow))).map((d) => ({
      key: d.key ?? "",
      protected: flag(d.protected),
      updatedBy: d.updatedBy || null,
    }));
  }

  private async treasuryTab(user: SignedInUser, tab: string, b: WaitBudget): Promise<Page> {
    const page = await this.openAs(user, R.treasury);
    await byCoopId(page, TREASURY).waitFor({ timeout: b.timeoutMs });
    await byCoopId(page, tab).click({ timeout: b.timeoutMs });
    return page;
  }

  async refundShare(treasurer: SignedInUser, shareId: string, note: string, b: WaitBudget): Promise<void> {
    const ui = { timeout: b.timeoutMs };
    const short = { ...b, timeoutMs: Math.min(b.timeoutMs, 10_000) };
    const row = await waitFor(
      `treasury-share-row[data-share-id=${shareId}] refund_pending`,
      async () => {
        const page = await this.treasuryTab(treasurer, T.treasuryTabShares, short);
        const r = byCoopId(page, T.treasuryShareRow, { "share-id": shareId }).first();
        return (await visible(r, 5_000)) && (await r.getAttribute("data-status")) === "refund_pending" ? r : null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
    const page = row.page();
    await byCoopId(row, T.treasuryShareRefund).first().click(ui);
    await byCoopId(page, T.treasuryShareRefundNote).fill(note, ui);
    await byCoopId(page, T.treasuryShareRefundSubmit).click(ui);
    // The tab lists refund_pending shares, so a refunded row leaves it; the API then says refunded.
    await waitFor(
      `treasury-share-row[data-share-id=${shareId}] gone and the share refunded`,
      async () => {
        const p = await this.treasuryTab(treasurer, T.treasuryTabShares, short);
        const r = byCoopId(p, T.treasuryShareRow, { "share-id": shareId }).first();
        if ((await visible(r, 1_000)) && (await r.getAttribute("data-status")) === "refund_pending") return null;
        const refunded = await treasurer.api.client.coop.shares.list({ status: "refunded", limit: 100 });
        return refunded.items.some((x) => x.id === shareId) ? true : null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
  }

  async runPatronage(treasurer: SignedInUser, start: Date, end: Date, b: WaitBudget): Promise<PatronageRunView> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.treasuryTab(treasurer, T.treasuryTabPatronage, b);
    await byCoopId(page, T.patronageRunForm).waitFor(ui);
    await byCoopId(page, T.patronageRunStart).fill(datetimeLocalUtc(start), ui);
    await byCoopId(page, T.patronageRunEnd).fill(datetimeLocalUtc(end), ui);
    await byCoopId(page, T.patronageRunSurplus).fill("", ui);
    await clickConfirming(page, byCoopId(page, T.patronageRunSubmit), b);
    const d = await dataset(byCoopId(page, T.patronageRunResult), b.timeoutMs);
    const members = num(d.members);
    const cents = parseCents(d.cents);
    if (!d.periodId || members === null || cents === null)
      throw new Error("patronage-run-result lacks data-period-id, data-members or data-cents");
    return { periodId: d.periodId, members, cents };
  }

  async periods(staff: SignedInUser, b: WaitBudget): Promise<PeriodRowView[]> {
    const page = await this.treasuryTab(staff, T.treasuryTabPatronage, b);
    await byCoopId(page, T.patronagePeriodRow).first().waitFor({ timeout: b.timeoutMs });
    const rows = byCoopId(page, T.patronagePeriodRow);
    const out: PeriodRowView[] = [];
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const d = await dataset(row, b.timeoutMs);
      const approve = byCoopId(row, T.patronageApprove).first();
      let approveDisabled: boolean | null = null;
      if ((await approve.count()) > 0) {
        approveDisabled = (await approve.isDisabled()) || (await approve.getAttribute("aria-disabled")) === "true";
      }
      out.push({
        periodId: d.periodId ?? "",
        status: d.status ?? "",
        cents: parseCents(d.cents),
        computedBy: d.computedBy || null,
        approvedBy: d.approvedBy || null,
        approveDisabled,
      });
    }
    return out;
  }

  async approvePatronage(approver: SignedInUser, periodId: string, b: WaitBudget): Promise<void> {
    const page = await this.treasuryTab(approver, T.treasuryTabPatronage, b);
    const row = byCoopId(page, T.patronagePeriodRow, { "period-id": periodId }).first();
    await row.waitFor({ timeout: b.timeoutMs });
    await clickConfirming(page, byCoopId(row, T.patronageApprove).first(), b);
    await waitFor(
      `patronage-period-row[data-period-id=${periodId}] data-status=approved`,
      async () => {
        const p = await this.treasuryTab(approver, T.treasuryTabPatronage, { ...b, timeoutMs: 10_000 });
        const r = byCoopId(p, T.patronagePeriodRow, { "period-id": periodId }).first();
        return (await visible(r, 5_000)) && (await r.getAttribute("data-status")) === "approved" ? true : null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
  }

  async statement(member: SignedInUser, periodId: string, b: WaitBudget): Promise<StatementView> {
    const page = await this.openAs(member, R.statement(periodId));
    const s = byCoopId(page, T.statement).first();
    const d = await dataset(s, b.timeoutMs);
    const lines = byCoopId(page, T.statementLine);
    const out: StatementView["lines"] = [];
    for (let i = 0; i < (await lines.count()); i++) {
      const line = lines.nth(i);
      const l = await dataset(line, b.timeoutMs);
      const text =
        (await byCoopId(line, T.statementLineExplanation)
          .first()
          .textContent()
          .catch(() => null)) ?? "";
      out.push({
        component: l.component ?? "",
        cents: parseCents(l.cents),
        capApplied: flag(l.capApplied),
        explained: text.trim().length > 0,
      });
    }
    return {
      periodId: d.periodId ?? "",
      status: d.status ?? "",
      cents: parseCents(d.cents) ?? 0,
      formulaVersion: d.formulaVersion ?? "",
      lines: out,
    };
  }

  async transparency(viewer: SignedInUser, b: WaitBudget): Promise<TransparencyView> {
    const page = await this.openAs(viewer, R.transparency);
    await byCoopId(page, T.transparencyGovernance)
      .or(byCoopId(page, T.transparencyPatronage))
      .first()
      .waitFor({ timeout: b.timeoutMs });
    return {
      governance: (await datasets(byCoopId(page, T.transparencyGovernance))).map((d) => ({
        proposalId: d.proposalId ?? "",
        status: d.status ?? "",
        kind: d.kind ?? "",
        passed: d.passed === undefined || d.passed === "" ? null : d.passed === "true",
        month: d.month ?? "",
      })),
      patronage: (await datasets(byCoopId(page, T.transparencyPatronage))).map((d) => ({
        month: d.month ?? "",
        cents: parseCents(d.cents) ?? 0,
      })),
    };
  }
}

/** This month in the transparency view's terms. */
export function patronageIn(view: TransparencyView, at: Date): number {
  const month = utcMonthOf(at);
  return view.patronage.filter((p) => p.month === month).reduce((s, p) => s + p.cents, 0);
}
