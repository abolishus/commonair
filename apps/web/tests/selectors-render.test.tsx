// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Render-level selector contract: ids and attributes that reach the DOM only through a
 * `@commonair/ui` composition prop (COMPOSITION_TEST_IDS / COMPOSITION_ATTRS) are server-rendered
 * from the app's own components with fixture data and checked on the resulting DOM. The text-content
 * contracts of `stream-server-url`, `stream-key` and `relay-token` are checked here too.
 */
import type { StreamCard } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { Window } from "happy-dom";
import type * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ChatPanel } from "../src/chat/chat-panel.tsx";
import { Directory } from "../src/components/directory.tsx";
import { IngestServerUrl, NewStreamKey } from "../src/components/ingest-values.tsx";
import { SignInPasswordField, SignUpPasswordField } from "../src/components/password-fields.tsx";
import { NewRelayToken, RelayTable } from "../src/components/relays.tsx";
import { InstanceFooter } from "../src/components/site-chrome.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { RelayNodeDto } from "../src/lib/relays.ts";
import { Player } from "../src/player/player.tsx";
import {
  PayoutAccountCard,
  RevenueLedger,
  RevenueMonthFilter,
  RevenueSources,
  RevenueStats,
  RevenueTiers,
  TierEditor,
} from "../src/components/money/revenue.tsx";
import { TransparencyReport } from "../src/components/money/transparency.tsx";
import {
  CostForm,
  DisputeForm,
  MarkPaidForm,
  PaymentsPanel,
  PayoutAccountForm,
  PayoutResult,
  PayoutsPanel,
  TreasuryTabs,
} from "../src/components/money/treasury.tsx";
import { Dialog } from "@commonair/ui/components/dialog";
import type {
  RevenueLineDto,
  RevenueSummaryDto,
  TransparencyMonthDto,
  TreasurerPaymentDto,
  TreasurerPayoutDto,
} from "../src/lib/money.ts";
import { COMPOSITION_ATTRS, COMPOSITION_TEST_IDS } from "./composition-ids.ts";

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

function render(node: React.ReactNode): Document {
  const html = renderToString(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
  const { document } = new Window();
  document.body.innerHTML = html;
  return document as unknown as Document;
}

const one = (doc: Document, selector: string): Element => {
  const all = doc.querySelectorAll(selector);
  expect(all.length, selector).toBe(1);
  return all[0] as Element;
};

const card = (slug: string): StreamCard => ({
  channel: { id: `id-${slug}`, slug, displayName: slug, avatarUrl: null, accent: "zinc" },
  broadcast: {
    id: `b-${slug}`,
    title: `${slug} live`,
    category: null,
    startedAt: "2026-10-18T12:00:00.000Z",
    mature: false,
    viewerCount: 3,
    thumbnailUrl: null,
  },
  tags: [],
  language: "en",
  reason: "popular",
});

const relay = (id: string, over: Partial<RelayNodeDto> = {}): RelayNodeDto => ({
  id,
  name: `relay ${id}`,
  publicUrl: "https://relay.example.org",
  region: "eu",
  declaredCapacityMbps: 1000,
  measuredCapacityMbps: null,
  status: "active",
  lastHealthAt: null,
  suspendedReason: null,
  retiredAt: null,
  version: null,
  bytesVerified30d: 123_456,
  lastReceiptAt: null,
  receipts30d: { pending: 1, verified: 2, rejected: 0 },
  ...over,
});

const noop = () => {};

/** Every listed id and attribute, found on a rendered element (filled in by the tests below). */
const seenIds = new Set<string>();
const seenAttrs = new Set<string>();

describe("composition-rendered selectors", () => {
  it("directory: stream-card with data-channel on each StreamGrid card", () => {
    const doc = render(<Directory sections={[{ id: "live", cards: [card("rivertide"), card("mothwing")] }]} />);
    const cards = [...doc.querySelectorAll('[data-testid="directory-section"] [data-testid="stream-card"]')];
    expect(cards.map((c) => c.getAttribute("data-channel"))).toEqual(["rivertide", "mothwing"]);
    expect(cards[0]?.querySelector('a[href="/rivertide"]')).not.toBeNull();
    seenIds.add("stream-card");
    seenAttrs.add("data-channel={card.channel.slug}");
  });

  it("directory: offline sections render channel-card links after directory-empty", () => {
    const doc = render(
      <Directory
        sections={[]}
        offline={[
          {
            id: "recent",
            cards: [
              {
                channel: { id: "c1", slug: "rivertide", displayName: "Rivertide", avatarUrl: null, accent: "teal" },
                title: "Last show",
                category: { id: "k1", slug: "music", name: "Music" },
                lastLiveAt: "2026-10-18T12:00:00.000Z",
                followerCount: 3,
                mature: false,
              },
            ],
          },
        ]}
      />,
    );
    expect(doc.querySelector('[data-testid="directory-empty"]')).not.toBeNull();
    const card = doc.querySelector(
      '[data-testid="directory-section"][data-section="recent"] [data-testid="channel-card"]',
    );
    expect(card?.getAttribute("data-channel")).toBe("rivertide");
    expect(card?.getAttribute("href")).toBe("/rivertide");
    expect(card?.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-18T12:00:00.000Z");
  });

  it("relays: relay-row carries data-relay-id and data-status through DataTable rowProps", () => {
    const doc = render(
      <RelayTable
        relays={[relay("r1"), relay("r2", { status: "suspended", suspendedReason: "over-reporting" })]}
        onRemoved={noop}
      />,
    );
    const rows = [...doc.querySelectorAll('tr[data-testid="relay-row"]')];
    expect(rows.map((r) => [r.getAttribute("data-relay-id"), r.getAttribute("data-status")])).toEqual([
      ["r1", "active"],
      ["r2", "suspended"],
    ]);
    const first = rows[0] as Element;
    expect(first.querySelector('[data-testid="relay-bytes-verified"]')?.getAttribute("data-bytes")).toBe("123456");
    const receipts = first.querySelector('[data-testid="relay-receipts"]');
    expect([receipts?.getAttribute("data-pending"), receipts?.getAttribute("data-verified")]).toEqual(["1", "2"]);
    expect(first.querySelector('[data-testid="relay-status"]')).not.toBeNull();
    expect(first.querySelector('[data-testid="relay-remove"]')).not.toBeNull();
    expect(first.querySelector('[data-testid="relay-suspended-reason"]')).toBeNull();
    expect(rows[1]?.querySelector('[data-testid="relay-suspended-reason"]')).not.toBeNull();
    seenIds.add("relay-row");
    seenAttrs.add("data-relay-id={relay.id}").add("data-status={relay.status}");
  });

  it("relays: an empty list shows relays-empty and no rows", () => {
    const doc = render(<RelayTable relays={[]} onRemoved={noop} />);
    one(doc, '[data-testid="relays-empty"]');
    expect(doc.querySelectorAll('[data-testid="relay-row"]')).toHaveLength(0);
  });

  it("chat: chat-input and chat-send for signed-in viewers, the sign-in prompt otherwise", () => {
    const signedIn = render(<ChatPanel channel="rivertide" signedIn selfUsername="fan" />);
    one(signedIn, '[data-testid="chat"][data-state="connecting"]');
    expect(one(signedIn, '[data-testid="chat-input"]').tagName).toBe("INPUT");
    expect(one(signedIn, '[data-testid="chat-send"]').getAttribute("type")).toBe("submit");
    expect(signedIn.querySelector('[data-testid="chat-signin-prompt"]')).toBeNull();
    const anonymous = render(<ChatPanel channel="rivertide" signedIn={false} />);
    one(anonymous, '[data-testid="chat-signin-prompt"]');
    expect(anonymous.querySelector('[data-testid="chat-input"]')).toBeNull();
    seenIds.add("chat-input").add("chat-send");
  });

  it("auth: the password ids are on the <input> elements", () => {
    const signIn = one(render(<SignInPasswordField />), '[data-testid="signin-password"]');
    expect([signIn.tagName, signIn.getAttribute("name"), signIn.getAttribute("autocomplete")]).toEqual([
      "INPUT",
      "password",
      "current-password",
    ]);
    const signUp = one(render(<SignUpPasswordField />), '[data-testid="signup-password"]');
    expect([signUp.tagName, signUp.getAttribute("name"), signUp.getAttribute("autocomplete")]).toEqual([
      "INPUT",
      "password",
      "new-password",
    ]);
    seenIds.add("signin-password").add("signup-password");
  });

  it("footer: footer-source-link is the AGPL source link", () => {
    const doc = render(
      <InstanceFooter instance={{ name: "Test Air", sourceUrl: "https://code.example.org/commonair" }} />,
    );
    const link = one(doc, '[data-testid="footer-source-link"]');
    expect([link.tagName, link.getAttribute("href")]).toEqual(["A", "https://code.example.org/commonair"]);
    seenIds.add("footer-source-link");
  });

  it("player: live-badge only while live, on the player chrome", () => {
    const live = render(<Player channel="rivertide" live />);
    one(live, '[data-testid="player"] [data-testid="live-badge"]');
    one(live, 'video[data-testid="player-video"]');
    const offline = render(<Player channel="rivertide" live={false} />);
    expect(offline.querySelector('[data-testid="live-badge"]')).toBeNull();
    seenIds.add("live-badge");
  });

  it("dashboard: server URL and new key are text content, with stream-key-copy", () => {
    const server = one(
      render(<IngestServerUrl value="rtmp://ingest.example.org/live" />),
      '[data-testid="stream-server-url"]',
    );
    expect(server.textContent).toBe("rtmp://ingest.example.org/live");
    const doc = render(<NewStreamKey value="live_abc123" />);
    expect(one(doc, '[data-testid="stream-key"]').textContent).toBe("live_abc123");
    expect(one(doc, '[data-testid="stream-key-copy"]').tagName).toBe("BUTTON");
    seenIds.add("stream-key-copy");
  });

  it("relays: relay-token and relay-run-command are text content", () => {
    const doc = render(
      <NewRelayToken
        created={{ name: "home", token: "relay_TOKEN" }}
        publicUrl="https://air.example.org/"
        onDismiss={noop}
      />,
    );
    expect(one(doc, '[data-testid="relay-token"]').textContent).toBe("relay_TOKEN");
    expect(one(doc, '[data-testid="relay-run-command"]').textContent).toBe(
      "commonair-relay --api https://air.example.org --token relay_TOKEN --public-url https://<your-host>",
    );
  });

  // ── E4b web-money ──────────────────────────────────────────────────────────────────────────

  const usd = (cents: number) => ({ cents, currency: "usd" });
  const summary = (over: Partial<RevenueSummaryDto["balance"]> = {}): RevenueSummaryDto => ({
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    gross: usd(4000),
    coopCut: usd(600),
    refundsAndChargebacks: usd(0),
    net: usd(3400),
    pendingPayout: usd(0),
    activeSubscriptions: { tier1: 2, tier2: 1, tier3: 0 },
    tips: 1,
    split: { streamerShare: 0.85, coopShare: 0.15 },
    daily: [],
    balance: { available: usd(1200), held: usd(3400), owed: usd(0), minimumPayout: usd(5000), holdDays: 14, ...over },
    bySource: { subscriptions: 1700, gifts: 1275, tips: 425 },
    tiers: [
      { tier: 1, active: 2, monthlyShare: usd(850) },
      { tier: 2, active: 1, monthlyShare: usd(850) },
      { tier: 3, active: 0, monthlyShare: usd(0) },
    ],
    previousNet: usd(1000),
  });
  const line = (id: string, over: Partial<RevenueLineDto> = {}): RevenueLineDto => ({
    id,
    occurredAt: "2026-10-05T12:00:00.000Z",
    type: "subscription",
    tier: 2,
    quantity: 1,
    from: { id: "u1", username: "fan", displayName: "Fan" },
    reference: "CA-ABCD1234",
    gross: usd(1000),
    deductions: usd(-150),
    net: usd(850),
    ...over,
  });
  const payment = (id: string, over: Partial<TreasurerPaymentDto> = {}): TreasurerPaymentDto => ({
    paymentId: id,
    reference: `CA-${id.toUpperCase().padEnd(8, "0")}`,
    kind: "subscription",
    status: "pending",
    amount: usd(1000),
    refunded: usd(0),
    tier: 2,
    quantity: 1,
    user: null,
    channelSlug: "rivertide",
    createdAt: "2026-10-05T12:00:00.000Z",
    succeededAt: null,
    expiresAt: null,
    ...over,
  });
  const payout = (id: string, over: Partial<TreasurerPayoutDto> = {}): TreasurerPayoutDto => ({
    id,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    amount: usd(6000),
    status: "pending",
    provider: "manual",
    holdReason: null,
    paidAt: null,
    user: { id: "u9", username: "rivertide", displayName: "Rivertide" },
    reference: null,
    createdAt: "2026-10-20T12:00:00.000Z",
    ...over,
  });
  const attrs = (el: Element | null | undefined, names: string[]) => names.map((n) => el?.getAttribute(n) ?? null);
  const asyncNoop = async () => {};

  it("revenue: month filter, stat cards, sources and tier rows", () => {
    const filter = render(
      <RevenueMonthFilter
        value="2026-10"
        options={[{ value: "2026-10", label: "October 2026" }]}
        onValueChange={noop}
      />,
    );
    one(filter, '[data-testid="revenue-month"]');
    seenIds.add("revenue-month");

    const stats = render(<RevenueStats summary={summary()} />);
    expect(attrs(one(stats, '[data-testid="revenue-available"]'), ["data-cents", "data-minimum"])).toEqual([
      "1200",
      "5000",
    ]);
    expect(one(stats, '[data-testid="revenue-held"]').getAttribute("data-cents")).toBe("3400");
    expect(attrs(one(stats, '[data-testid="revenue-earned"]'), ["data-cents", "data-previous"])).toEqual([
      "3400",
      "1000",
    ]);
    expect(stats.querySelector('[data-testid="revenue-owed"]')).toBeNull();
    const owed = render(<RevenueStats summary={summary({ owed: usd(250) })} />);
    expect(one(owed, '[data-testid="revenue-owed"]').getAttribute("data-cents")).toBe("250");

    const sources = [
      ...render(<RevenueSources summary={summary()} />).querySelectorAll('li[data-testid="revenue-source"]'),
    ];
    expect(sources.map((s) => attrs(s, ["data-source", "data-cents"]))).toEqual([
      ["subscriptions", "1700"],
      ["gifts", "1275"],
      ["tips", "425"],
    ]);
    seenIds.add("revenue-source");
    seenAttrs.add("data-source={source}").add("data-cents={summary.bySource[source]}");

    const tiers = [
      ...render(<RevenueTiers summary={summary()} />).querySelectorAll('tr[data-testid="revenue-tier-row"]'),
    ];
    expect(tiers.map((r) => attrs(r, ["data-tier", "data-active", "data-cents"]))).toEqual([
      ["1", "2", "850"],
      ["2", "1", "850"],
      ["3", "0", "0"],
    ]);
    seenIds.add("revenue-tier-row");
    seenAttrs.add("data-tier={row.tier}").add("data-active={row.active}").add("data-cents={row.monthlyShare.cents}");
  });

  it("revenue: ledger rows, load more, CSV; empty and loading states", () => {
    const ledger = { loadingMore: false, onLoadMore: noop, downloading: false, onDownload: noop };
    const doc = render(
      <RevenueLedger
        {...ledger}
        hasMore
        lines={[
          line("t1"),
          line("t2", { type: "chargeback", gross: usd(-1000), deductions: usd(150), net: usd(-850) }),
          line("t3", {
            type: "payout",
            tier: null,
            from: null,
            quantity: 1,
            gross: null,
            deductions: null,
            net: usd(-5000),
          }),
        ]}
      />,
    );
    const rows = [...doc.querySelectorAll('tr[data-testid="revenue-ledger-row"]')];
    const names = [
      "data-transaction-id",
      "data-type",
      "data-tier",
      "data-quantity",
      "data-gross",
      "data-deductions",
      "data-net",
    ];
    expect(rows.map((r) => attrs(r, names))).toEqual([
      ["t1", "subscription", "2", "1", "1000", "-150", "850"],
      ["t2", "chargeback", "2", "1", "-1000", "150", "-850"],
      ["t3", "payout", "", "1", "", "", "-5000"],
    ]);
    expect(one(doc, '[data-testid="revenue-ledger-more"]').tagName).toBe("BUTTON");
    expect(one(doc, '[data-testid="revenue-statement-csv"]').tagName).toBe("BUTTON");
    seenIds.add("revenue-ledger-row");
    for (const a of [
      "data-transaction-id={line.id}",
      "data-type={line.type}",
      'data-tier={line.tier ?? ""}',
      "data-quantity={line.quantity}",
      "data-gross={signed(line.gross?.cents)}",
      "data-deductions={signed(line.deductions?.cents)}",
      "data-net={line.net.cents}",
    ])
      seenAttrs.add(a);

    const empty = render(<RevenueLedger {...ledger} hasMore={false} lines={[]} />);
    expect(empty.querySelectorAll('[data-testid="revenue-ledger-row"]')).toHaveLength(0);
    expect(empty.querySelector('[data-testid="revenue-ledger-more"]')).toBeNull();
    const loading = render(<RevenueLedger {...ledger} hasMore={false} lines={null} />);
    expect(loading.querySelectorAll('[data-testid="revenue-ledger-row"]')).toHaveLength(0);
  });

  it("revenue: payout account card and tier editor inputs", () => {
    const manual = one(
      render(
        <PayoutAccountCard
          account={{ provider: "manual", payoutsEnabled: false, onboardingUrl: null, instructions: "Bank transfer" }}
        />,
      ),
      '[data-testid="revenue-payout-account"]',
    );
    expect(attrs(manual, ["data-provider", "data-enabled"])).toEqual(["manual", "false"]);
    expect(manual.textContent).toContain("Bank transfer");
    const stripe = one(
      render(
        <PayoutAccountCard
          account={{
            provider: "stripe",
            payoutsEnabled: true,
            onboardingUrl: "https://connect.example.org/x",
            instructions: null,
          }}
        />,
      ),
      '[data-testid="revenue-payout-account"]',
    );
    expect(attrs(stripe, ["data-provider", "data-enabled"])).toEqual(["stripe", "true"]);
    expect(stripe.querySelector('a[href="https://connect.example.org/x"]')).not.toBeNull();

    const doc = render(
      <TierEditor
        currency="usd"
        tiers={[
          { tier: 1, name: "Bronze", price: usd(500), benefits: "Badge" },
          { tier: 2, name: "Silver", price: usd(1000), benefits: "" },
          { tier: 3, name: "Gold", price: usd(2500), benefits: "" },
        ]}
        onSave={async (tiers) => tiers}
      />,
    );
    expect(one(doc, '[data-testid="revenue-tiers"]').querySelector("form")).not.toBeNull();
    for (const n of [1, 2, 3]) {
      expect(one(doc, `[data-testid="revenue-tier-name-${n}"]`).tagName).toBe("INPUT");
      expect(one(doc, `[data-testid="revenue-tier-price-${n}"]`).tagName).toBe("INPUT");
      expect(one(doc, `[data-testid="revenue-tier-benefits-${n}"]`).tagName).toBe("TEXTAREA");
      seenIds.add(`revenue-tier-price-${n}`);
    }
    expect(one(doc, '[data-testid="revenue-tier-price-2"]').getAttribute("value")).toBe("10.00");
    const save = one(doc, '[data-testid="revenue-tiers-save"]');
    expect([save.getAttribute("type"), save.hasAttribute("disabled")]).toEqual(["submit", false]);
  });

  it("treasury: tabs, search and payment rows with their actions", () => {
    const tabs = render(
      <TreasuryTabs
        value="payments"
        onValueChange={noop}
        payments={null}
        payouts={null}
        accounts={null}
        costs={null}
      />,
    );
    for (const id of ["payments", "payouts", "accounts", "costs"]) one(tabs, `[data-testid="treasury-tab-${id}"]`);

    const doc = render(
      <PaymentsPanel
        search=""
        onSearchChange={noop}
        onConfirm={asyncNoop}
        onDispute={asyncNoop}
        payments={[
          payment("p1"),
          payment("p2", { status: "partially_refunded", refunded: usd(300), kind: "tip", tier: null }),
          payment("p3", { status: "charged_back" }),
        ]}
      />,
    );
    expect(one(doc, '[data-testid="treasury-search"]').tagName).toBe("INPUT");
    seenIds.add("treasury-search");
    const rows = [...doc.querySelectorAll('tr[data-testid="treasury-payment-row"]')];
    const names = ["data-payment-id", "data-reference", "data-status", "data-kind", "data-cents", "data-refunded"];
    expect(rows.map((r) => attrs(r, names))).toEqual([
      ["p1", "CA-P1000000", "pending", "subscription", "1000", "0"],
      ["p2", "CA-P2000000", "partially_refunded", "tip", "1000", "300"],
      ["p3", "CA-P3000000", "charged_back", "subscription", "1000", "0"],
    ]);
    const [pending, partial, chargedBack] = rows;
    expect(pending?.querySelector('[data-testid="treasury-confirm"]')).not.toBeNull();
    expect(pending?.querySelector('[data-testid="treasury-refund"]')).toBeNull();
    expect(partial?.querySelector('[data-testid="treasury-confirm"]')).toBeNull();
    expect(partial?.querySelector('[data-testid="treasury-refund"]')).not.toBeNull();
    expect(partial?.querySelector('[data-testid="treasury-chargeback"]')).not.toBeNull();
    expect(chargedBack?.querySelector("button")).toBeNull();
    seenIds.add("treasury-payment-row");
    for (const a of [
      "data-payment-id={p.paymentId}",
      "data-reference={p.reference}",
      "data-status={p.status}",
      "data-kind={p.kind}",
      "data-cents={p.amount.cents}",
      "data-refunded={p.refunded.cents}",
    ])
      seenAttrs.add(a);

    const form = render(
      <Dialog open>
        <DisputeForm
          payment={payment("p2", { status: "partially_refunded", refunded: usd(300) })}
          kind="refund"
          onSubmit={asyncNoop}
        />
      </Dialog>,
    );
    // Defaults to the refundable rest.
    expect(one(form, 'input[data-testid="treasury-dispute-amount"]').getAttribute("value")).toBe("7.00");
    expect(one(form, '[data-testid="treasury-dispute-reason"]').tagName).toBe("TEXTAREA");
    expect(one(form, '[data-testid="treasury-dispute-submit"]').getAttribute("type")).toBe("submit");
    seenIds.add("treasury-dispute-amount");
  });

  it("treasury: payouts run, result, rows and mark paid", () => {
    const doc = render(
      <PayoutsPanel
        running={false}
        onRun={noop}
        onMarkPaid={asyncNoop}
        result={{ created: 1, held: 1, total: usd(6000) }}
        payouts={[
          payout("o1"),
          payout("o2", { status: "held", holdReason: "payout_account_not_ready" }),
          payout("o3", { status: "paid", reference: "wire-1" }),
        ]}
      />,
    );
    expect(one(doc, '[data-testid="treasury-run-payouts"]').tagName).toBe("BUTTON");
    expect(
      attrs(one(doc, '[data-testid="treasury-payouts-result"]'), ["data-created", "data-held", "data-cents"]),
    ).toEqual(["1", "1", "6000"]);
    const rows = [...doc.querySelectorAll('tr[data-testid="treasury-payout-row"]')];
    const names = ["data-payout-id", "data-username", "data-status", "data-cents", "data-hold-reason"];
    expect(rows.map((r) => attrs(r, names))).toEqual([
      ["o1", "rivertide", "pending", "6000", ""],
      ["o2", "rivertide", "held", "6000", "payout_account_not_ready"],
      ["o3", "rivertide", "paid", "6000", ""],
    ]);
    expect(rows.map((r) => r.querySelector('[data-testid="treasury-mark-paid"]') !== null)).toEqual([
      true,
      false,
      false,
    ]);
    seenIds.add("treasury-payout-row");
    for (const a of [
      "data-payout-id={p.id}",
      "data-username={p.user.username}",
      "data-status={p.status}",
      'data-hold-reason={p.holdReason ?? ""}',
    ])
      seenAttrs.add(a);
    expect(
      render(<PayoutResult result={{ created: 0, held: 0, total: usd(0) }} />)
        .querySelector('[data-testid="treasury-payouts-result"]')
        ?.getAttribute("data-created"),
    ).toBe("0");

    const form = render(
      <Dialog open>
        <MarkPaidForm payout={payout("o1")} onSubmit={asyncNoop} />
      </Dialog>,
    );
    expect(one(form, '[data-testid="treasury-mark-paid-reference"]').tagName).toBe("INPUT");
    // Disabled until a reference is typed.
    expect(one(form, '[data-testid="treasury-mark-paid-submit"]').hasAttribute("disabled")).toBe(true);
  });

  it("treasury: payout account and cost forms", () => {
    const account = render(<PayoutAccountForm onSubmit={asyncNoop} />);
    for (const id of ["treasury-account-username", "treasury-account-reference", "treasury-account-submit"])
      one(account, `[data-testid="${id}"]`);
    one(account, '[data-testid="treasury-account-enabled"]');
    seenIds.add("treasury-account-enabled");

    const cost = render(<CostForm currency="usd" onSubmit={asyncNoop} />);
    for (const id of ["treasury-cost-category", "treasury-cost-description", "treasury-cost-submit"])
      one(cost, `[data-testid="${id}"]`);
    expect(one(cost, '[data-testid="treasury-cost-amount"]').tagName).toBe("INPUT");
    seenIds.add("treasury-cost-amount");
  });

  it("transparency: stats, flow, month rows; empty state without months", () => {
    const month = (key: string, revenue: number): TransparencyMonthDto => ({
      month: key,
      revenue: usd(revenue),
      streamerPayouts: usd(6000),
      coopRetained: usd(1500),
      costs: [{ category: "hosting", amount: usd(400) }],
      surplus: usd(1100),
      patronageDistributed: usd(0),
      egressBySource: { origin: 600, relay: 400, p2p: 0, cdn: 0 },
      governance: [],
      members: { streamer: 0, viewer: 0, worker: 0 },
    });
    const doc = render(<TransparencyReport months={[month("2026-10", 10_000), month("2026-09", 5000)]} />);
    const stats = [...doc.querySelectorAll('[data-testid="transparency-stat"]')];
    expect(stats.map((s) => attrs(s, ["data-stat", "data-cents"]))).toEqual([
      ["revenue", "15000"],
      ["payouts", "12000"],
      ["costs", "800"],
      ["surplus", "2200"],
    ]);
    one(doc, '[data-testid="transparency-flow"]');
    expect(doc.querySelector('[data-testid="transparency-empty"]')).toBeNull();
    const rows = [...doc.querySelectorAll('tr[data-testid="transparency-month-row"]')];
    const names = ["data-month", "data-revenue", "data-payouts", "data-costs", "data-surplus", "data-patronage"];
    expect(rows.map((r) => attrs(r, names))).toEqual([
      ["2026-10", "10000", "6000", "400", "1100", "0"],
      ["2026-09", "5000", "6000", "400", "1100", "0"],
    ]);
    seenIds.add("transparency-month-row");
    for (const a of [
      "data-month={m.month}",
      "data-revenue={m.revenue.cents}",
      "data-payouts={m.streamerPayouts.cents}",
      "data-costs={monthCosts(m)}",
      "data-surplus={m.surplus.cents}",
      "data-patronage={m.patronageDistributed.cents}",
    ])
      seenAttrs.add(a);

    const empty = render(<TransparencyReport months={[]} />);
    one(empty, '[data-testid="transparency-empty"]');
    expect(empty.querySelector('[data-testid="transparency-stat"]')).toBeNull();
  });

  it("footer: footer-transparency-link goes to /transparency", () => {
    const link = one(
      render(<InstanceFooter instance={{ name: "Test Air", sourceUrl: null }} />),
      '[data-testid="footer-transparency-link"]',
    );
    expect([link.tagName, link.getAttribute("href")]).toEqual(["A", "/transparency"]);
  });

  it("covers every composition-only id and attribute", () => {
    expect([...seenIds].sort()).toEqual([...COMPOSITION_TEST_IDS].sort());
    expect([...seenAttrs].sort()).toEqual([...COMPOSITION_ATTRS].sort());
  });
});
