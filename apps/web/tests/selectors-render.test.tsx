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
import { COMPOSITION_ATTRS, COMPOSITION_TEST_IDS } from "./composition-ids.ts";
import { ChatEventRow } from "../src/chat/chat-event-row.tsx";
import { chatEventView } from "../src/chat/events.ts";
import { SupportForm, SupportInstructions } from "../src/components/support/support-dialog.tsx";
import { subscription, supportInfo } from "./support-fixtures.ts";

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

  it("support: every form id on each tab, support-tier/support-tip-amount through composition props", () => {
    const checkout = async () => {
      throw new Error("unused");
    };
    const info = supportInfo({ viewer: { isOwner: false, subscription: subscription({ status: "incomplete" }) } });
    const sub = render(<SupportForm channel="rivertide" info={info} checkout={checkout} onInstructions={noop} />);
    for (const id of [
      "support-tab-sub",
      "support-tab-gift",
      "support-tab-tip",
      "support-split",
      "support-total",
      "support-submit",
    ])
      one(sub, `[data-testid="${id}"]`);
    const current = one(sub, '[data-testid="support-current"]');
    expect([current.getAttribute("data-status"), current.getAttribute("data-tier")]).toEqual(["incomplete", "2"]);
    const tiers = [...sub.querySelectorAll('[data-testid="support-tier"]')];
    expect(
      tiers.map((t) => [t.getAttribute("role"), t.getAttribute("data-tier"), t.getAttribute("data-cents")]),
    ).toEqual([
      ["radio", "1", "499"],
      ["radio", "2", "999"],
      ["radio", "3", "2499"],
    ]);
    expect(tiers[0]?.getAttribute("aria-checked")).toBe("true");
    const split = one(sub, '[data-testid="support-split"]');
    expect([split.getAttribute("data-streamer-share"), split.getAttribute("data-coop-share")]).toEqual(["0.9", "0.1"]);
    expect(one(sub, '[data-testid="support-total"]').getAttribute("data-cents")).toBe("499");
    expect(one(sub, '[data-testid="support-submit"]').tagName).toBe("BUTTON");
    expect(sub.querySelector('[data-testid="support-error"]')).toBeNull();

    const gift = render(
      <SupportForm
        channel="rivertide"
        info={info}
        checkout={checkout}
        onInstructions={noop}
        initial={{ tab: "gift", gift: { count: "5", mode: "random", to: "" } }}
      />,
    );
    expect(gift.querySelectorAll('[data-testid="support-tier"]')).toHaveLength(3);
    one(gift, '[data-testid="support-gift-recipient"]');
    one(gift, '[data-testid="support-gift-recipient-random"]');
    one(gift, '[data-testid="support-gift-recipient-viewer"]');
    expect(one(gift, '[data-testid="support-gift-count"]').tagName).toBe("INPUT");
    expect(one(gift, '[data-testid="support-total"]').getAttribute("data-cents")).toBe("2495");
    const giftTo = render(
      <SupportForm
        channel="rivertide"
        info={info}
        checkout={checkout}
        onInstructions={noop}
        initial={{ tab: "gift", gift: { count: "1", mode: "viewer", to: "mothwing" } }}
      />,
    );
    expect(one(giftTo, '[data-testid="support-gift-to"]').tagName).toBe("INPUT");

    const tip = render(
      <SupportForm
        channel="rivertide"
        info={info}
        checkout={checkout}
        onInstructions={noop}
        initial={{ tab: "tip", tip: { cents: 500, message: "", anonymous: false } }}
      />,
    );
    const amount = one(tip, '[data-testid="support-tip-amount"]');
    expect([amount.tagName, amount.getAttribute("data-cents"), amount.getAttribute("value")]).toEqual([
      "INPUT",
      "500",
      "5.00",
    ]);
    expect(one(tip, '[data-testid="support-tip-message"]').tagName).toBe("TEXTAREA");
    one(tip, '[data-testid="support-tip-anonymous"]');

    const done = render(
      <SupportInstructions
        result={{
          kind: "instructions",
          paymentId: "p1",
          reference: "CA-7K2M9QXA",
          instructions: "Pay by transfer.",
          amount: { cents: 999, currency: "usd" },
        }}
        onDone={noop}
      />,
    );
    expect(one(done, '[data-testid="support-instructions"]').getAttribute("data-payment-id")).toBe("p1");
    const ref = one(done, '[data-testid="support-reference"]');
    expect([ref.textContent, ref.getAttribute("data-reference")]).toEqual(["CA-7K2M9QXA", "CA-7K2M9QXA"]);
    expect(one(done, '[data-testid="support-amount"]').getAttribute("data-cents")).toBe("999");
    seenIds.add("support-tier").add("support-tip-amount");
    seenAttrs.add("data-tier={tier.tier}").add("data-cents={tier.price.cents}");
  });

  it("chat: chat-event rows carry type, user, tier, cents and total", () => {
    const tip = chatEventView("channel.tip", {
      broadcaster_user_id: "b",
      broadcaster_user_login: "rivertide",
      broadcaster_user_name: "Rivertide",
      user_id: null,
      user_login: null,
      user_name: null,
      is_anonymous: true,
      amount: { value: 500, decimal_places: 2, currency: "usd" },
      message: "hi",
    });
    const gift = chatEventView("channel.subscription.gift", {
      broadcaster_user_id: "b",
      broadcaster_user_login: "rivertide",
      broadcaster_user_name: "Rivertide",
      user_id: "u",
      user_login: "kanjikat",
      user_name: "KanjiKat",
      total: 2,
      tier: "1000",
      is_anonymous: false,
    });
    if (!tip || !gift) throw new Error("fixture did not parse");
    const t = one(render(<ChatEventRow event={tip} />), '[data-testid="chat-event"]');
    expect([t.tagName, t.getAttribute("data-type"), t.getAttribute("data-user"), t.getAttribute("data-cents")]).toEqual(
      ["ARTICLE", "channel.tip", "", "500"],
    );
    const g = one(render(<ChatEventRow event={gift} />), '[data-testid="chat-event"]');
    expect(["data-type", "data-user", "data-tier", "data-total"].map((a) => g.getAttribute(a))).toEqual([
      "channel.subscription.gift",
      "kanjikat",
      "1",
      "2",
    ]);
    expect(g.hasAttribute("data-cents")).toBe(false);
  });

  it("covers every composition-only id and attribute", () => {
    expect([...seenIds].sort()).toEqual([...COMPOSITION_TEST_IDS].sort());
    expect([...seenAttrs].sort()).toEqual([...COMPOSITION_ATTRS].sort());
  });
});
