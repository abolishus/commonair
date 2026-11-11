// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-settings copy slips: the counter-notice receipt reads "restored in 2 weeks" (F39, a catalogue
 * fix with its interpolation checked in every locale); an ended suspension reads "Ended … ago",
 * never "Until … ago" (F39); subscriptions name channels by display name with `@slug` beside it,
 * from `Subscription.channel`, and the avatar's initial comes from that name (F38); the copyright strike note is the card's
 * note style (F35).
 */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CounterReceipt } from "../src/components/dmca/copyright.tsx";
import { RestrictionEnd, restrictionEnded } from "../src/components/safety/enforcement.tsx";
import { SubscriptionList, subscriptionChannelName } from "../src/components/support/subscription-list.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { subscription } from "./support-fixtures.ts";

// RelativeTime reads the wall clock: pin it to NOW.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const LOCALES = join(import.meta.dirname, "../src/i18n/locales");

function wrap(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{node}</> });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <NowProvider now={NOW}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </NowProvider>
    </LocaleProvider>,
  );
}

const catalog = (lang: string, ns: string): Record<string, string> =>
  JSON.parse(readFileSync(join(LOCALES, lang, `${ns}.json`), "utf8")) as Record<string, string>;

// ── F39: copyright ───────────────────────────────────────────────────────────────────────────

describe("the counter-notice receipt (F39)", () => {
  const counter = {
    id: "0192f000-0000-7000-8000-0000000000c1",
    restoreAfter: new Date(NOW + 14 * 86_400_000).toISOString(),
    restoredAt: null,
    suitFiledAt: null,
  } as unknown as Parameters<typeof CounterReceipt>[0]["counter"];

  it("reads as one sentence with the time inside it", async () => {
    wrap(<CounterReceipt counter={counter} />);
    const receipt = await screen.findByTestId("counter-receipt");
    const text = receipt.textContent ?? "";
    expect(text).toMatch(/Your material is restored in 2 weeks\./);
    expect(text).not.toContain("after in");
    expect(text).not.toContain("{time}");
  });

  it.each(["en", "es"])("%s: the sentence has exactly one {time} and no leftover 'after'", (lang) => {
    const value = catalog(lang, "d5-settings")["settings.copyright.restoreAfter"] ?? "";
    expect(value.match(/\{time\}/g)).toHaveLength(1);
    expect(value).not.toMatch(/\bafter\b|después de\s*\{time\}/);
  });

  it("the old fragment is gone from the catalogue", () => {
    for (const lang of readdirSync(LOCALES).filter((d) => d === "en" || d === "es"))
      expect(catalog(lang, "e7-dmca")).not.toHaveProperty("copyright.receipt.restoreAfter");
  });

  it("the strike note uses the card's note style (F35)", () => {
    const text = readFileSync(join(import.meta.dirname, "../src/components/dmca/copyright.tsx"), "utf8");
    const note = /data-testid="copyright-strike-note" className="([^"]+)"/.exec(text)?.[1] ?? "";
    // The note style is 14 px reading text since D1.
    expect(note).toContain("text-sm");
    expect(note).toContain("text-muted-foreground");
    expect(note).not.toMatch(/\btext-(xs|base|lg)\b/);
  });
});

// ── F39: an ended suspension ─────────────────────────────────────────────────────────────────

describe("restriction end (F39)", () => {
  it("ended once the end is now or past", () => {
    expect(restrictionEnded("2026-11-04T11:59:59.000Z", NOW)).toBe(true);
    expect(restrictionEnded("2026-11-04T12:00:00.000Z", NOW)).toBe(true);
    expect(restrictionEnded("2026-11-04T12:00:01.000Z", NOW)).toBe(false);
    expect(restrictionEnded("not a date", NOW)).toBe(false);
  });

  it("a past end reads Ended … ago", async () => {
    wrap(<RestrictionEnd endsAt={new Date(NOW - 17 * 3_600_000).toISOString()} now={NOW} />);
    const end = await screen.findByTestId("enforcement-ends");
    expect(end.dataset.ended).toBe("true");
    expect(end.textContent).toBe("Ended 17 hours ago");
    expect(end.textContent).not.toContain(t("safety.enforcement.until"));
  });

  it("a future end still reads Until in …", async () => {
    wrap(<RestrictionEnd endsAt={new Date(NOW + 3 * 86_400_000).toISOString()} now={NOW} />);
    const end = await screen.findByTestId("enforcement-ends");
    expect(end.dataset.ended).toBe("false");
    expect(end.textContent).toBe(`${t("safety.enforcement.until")} in 3 days`);
  });

  it("uses the request clock when no `now` is passed", async () => {
    wrap(<RestrictionEnd endsAt={new Date(NOW - 60_000).toISOString()} />);
    expect((await screen.findByTestId("enforcement-ends")).dataset.ended).toBe("true");
  });

  it.each(["en", "es"])("%s: 'ended' has one {time}", (lang) => {
    expect((catalog(lang, "d5-settings")["settings.enforcement.ended"] ?? "").match(/\{time\}/g)).toHaveLength(1);
  });
});

// ── F38: subscriptions by display name ───────────────────────────────────────────────────────

describe("subscription names (F38)", () => {
  const aurora = { slug: "demo_streamer1", displayName: "Aurora Pixel", avatarUrl: null };

  it("display name first, @slug second; the slug alone when the name is blank", () => {
    expect(subscriptionChannelName(subscription({ channelSlug: "demo_streamer1", channel: aurora }))).toEqual({
      name: "Aurora Pixel",
      handle: "@demo_streamer1",
    });
    const blank = subscription({ channelSlug: "x", channel: { slug: "x", displayName: "  ", avatarUrl: null } });
    expect(subscriptionChannelName(blank)).toEqual({ name: "x", handle: null });
  });

  it("the row shows the display name, the handle and the name's initial", async () => {
    wrap(
      <SubscriptionList
        subscriptions={[subscription({ channelSlug: "demo_streamer1", channel: aurora })]}
        onCancel={async () => {}}
        onCancelError={() => {}}
      />,
    );
    const row = await screen.findByTestId("subscription-row");
    expect(within(row).getByTestId("subscription-channel").textContent).toBe("Aurora Pixel");
    expect(row.textContent).toContain("@demo_streamer1");
    // The avatar's fallback initial: "A" from the name, not "D" from the slug.
    const avatar = row.querySelector('[data-slot="avatar"]') ?? row.querySelector("[data-accent]");
    expect(avatar?.textContent?.trim()).toBe("A");
    expect(row.dataset.channel).toBe("demo_streamer1");
  });

  it("the avatar takes the channel's accent", async () => {
    wrap(
      <SubscriptionList
        subscriptions={[subscription({ channelSlug: "demo_streamer1", channel: { ...aurora, accent: "violet" } })]}
        onCancel={async () => {}}
        onCancelError={() => {}}
      />,
    );
    const row = await screen.findByTestId("subscription-row");
    expect(row.querySelector("[data-accent]")?.getAttribute("data-accent")).toBe("violet");
  });

  it("the page reads names from the subscriptions, with no per-channel lookups", () => {
    const route = readFileSync(join(import.meta.dirname, "../src/routes/_app/settings.subscriptions.tsx"), "utf8");
    expect(route).not.toContain("channels.get");
    expect(route).not.toContain("useSubscriptionChannels");
    const list = readFileSync(join(import.meta.dirname, "../src/components/support/subscription-list.tsx"), "utf8");
    expect(list).not.toContain("channels.get");
  });
});
