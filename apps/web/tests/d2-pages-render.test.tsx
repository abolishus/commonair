// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d2-pages components: `/creators` (calculator, claim field, the import section's switch), the
 * `/coop` join band, the patronage and jury explainers, and the public legal pages.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Availability } from "../src/components/creators/claim-field.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { live } from "./d1-fixtures.tsx";

const tracked = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => {
    tracked.calls.push(`${surface}|${action}|${step}`);
  },
}));

const { CreatorsPage } = await import("../src/components/creators/creators-page.tsx");
const { ClaimField } = await import("../src/components/creators/claim-field.tsx");
const { coopFacts } = await import("../src/components/creators/facts.ts");
const { CoopJoinBand } = await import("../src/components/coop/join-band.tsx");
const { CoopOverview } = await import("../src/components/coop/overview.tsx");
const { PatronageExplainer } = await import("../src/components/coop/patronage-explainer.tsx");
const { JuryExplainer } = await import("../src/components/coop/jury-explainer.tsx");
const { LegalPage } = await import("../src/components/legal-pages/legal-page.tsx");

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const SETTINGS = [
  { key: "platform.cut", value: { streamerShare: 0.9 } },
  { key: "payout.rules", value: { minimumCents: 2500, holdDays: 7, currency: "usd" } },
  {
    key: "membership.classes",
    value: {
      streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2 },
      viewer: {
        shareCents: 500,
        shareRefundableOnExit: true,
        activeSubscriptionQualifies: true,
        minSubscriptionCents: 300,
      },
    },
  },
  { key: "governance.protections", value: { memberWideThreshold: 2 / 3, streamerClassThreshold: 0.5 } },
];
const FACTS = coopFacts(SETTINGS, [{ key: "platform.cut", changedAt: null }]);

const id = (testId: string) => screen.getByTestId(testId);
const none = (testId: string) => expect(screen.queryAllByTestId(testId)).toHaveLength(0);
const noHardCodedCut = (el: HTMLElement) => expect(el.textContent ?? "").not.toMatch(/undefined|\{\w+\}/);

beforeEach(() => {
  tracked.calls = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("/creators", () => {
  const page = (over: Partial<React.ComponentProps<typeof CreatorsPage>> = {}) =>
    wrap(
      <CreatorsPage
        facts={FACTS}
        live={null}
        site="Test Air"
        host="air.example/"
        twitchImport={false}
        check={async (username) => ({ username, available: true, reason: null })}
        go={() => undefined}
        {...over}
      />,
    );

  it("leads with the share from platform.cut and links sign-up with the stream intent", () => {
    page();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Keep 90% from your first sub");
    const cta = id("creators-hero-cta");
    expect(cta.getAttribute("href")).toBe("/signup?intent=stream");
    expect(cta.hasAttribute("data-filled-cta")).toBe(true);
    fireEvent.click(cta);
    expect(tracked.calls).toContain("creators.hero|view|none");
    expect(tracked.calls).toContain("creators.hero|click|stream");
    noHardCodedCut(id("creators-page"));
  });

  it("hides the import while the Twitch import is off, and says 'other platforms'", () => {
    page();
    none("creators-import");
    none("creators-hero-import");
    expect(screen.getByText(en["d2Pages.creators.tools.title"])).toBeTruthy();
    expect(tracked.calls.some((c) => c.startsWith("creators.import"))).toBe(false);
  });

  it("shows the import section and its outline button when the import is on", () => {
    page({ twitchImport: true });
    id("creators-import");
    expect(id("creators-hero-import").getAttribute("href")).toBe("/signup?intent=import");
    expect(id("creators-hero-import").hasAttribute("data-filled-cta")).toBe(false);
    expect(tracked.calls).toContain("creators.import|view|none");
  });

  it("states the payout minimum and hold, the streamer class and every condition", () => {
    page();
    expect(id("creators-gate-payout").textContent).toBe("Payouts are monthly, with a $25.00 minimum and a 7-day hold.");
    expect(screen.getByText(/Stream 10 hours to 2 or more verified viewers within 90 days/)).toBeTruthy();
    const notes = id("calc-notes").textContent ?? "";
    expect(notes).toContain("once you've earned $25.00, after a 7-day hold");
    expect(notes).toContain("last checked 2026-11-06");
    expect(notes).toContain("Kick pays a higher share of subs (95%)");
    expect(notes).toContain("average tip of $10.00");
    expect(screen.getByText("The split hasn't changed since the co-op set it up.")).toBeTruthy();
    expect(id("creators-cut-split")).toBeTruthy();
    const faq = screen.getAllByTestId("creators-faq-item").map((el) => el.getAttribute("data-faq"));
    expect(faq).toEqual(["fee", "paid", "compare", "leave", "mature", "owner", "change"]);
  });

  it("ranks the comparison with CommonAir first and every competitor sourced", () => {
    page();
    const rows = screen.getAllByTestId("calc-row");
    expect(rows.map((r) => r.getAttribute("data-platform"))).toEqual([
      "commonair",
      "kick",
      "youtube",
      "twitch",
      "patreon",
      "kofi",
    ]);
    expect(rows[0]?.getAttribute("data-cents")).toBe("63000");
    for (const row of rows.slice(1)) {
      const link = within(row).getByRole("link");
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
      expect(link.getAttribute("rel")).toBe("noreferrer");
    }
    expect(within(rows[5] as HTMLElement).getByText(/from a secondary source/)).toBeTruthy();
    expect(id("calc-ours").textContent).toBe("About $630.00 a month");
  });

  it("recalculates from a preset and counts the first use once", () => {
    page();
    const preset = screen.getAllByTestId("calc-preset").find((b) => b.textContent === "500");
    if (!preset) throw new Error("no 500 preset");
    fireEvent.click(preset);
    expect(preset.getAttribute("aria-pressed")).toBe("true");
    expect(id("calc-ours").getAttribute("data-cents")).toBe(String(Math.round(500 * 500 * 0.9 + 20_000 * 0.9)));
    const ten = screen.getAllByTestId("calc-preset").find((b) => b.textContent === "10");
    if (!ten) throw new Error("no 10 preset");
    fireEvent.click(ten);
    expect(tracked.calls.filter((c) => c === "creators.calc|used|none")).toHaveLength(1);
  });

  it("names every slider for assistive tech", () => {
    page();
    const sliders = Array.from(id("fee-calculator").querySelectorAll('input[type="range"]'));
    expect(sliders.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Subscribers",
      "Average sub price",
      "Tips a month",
    ]);
  });

  it("shows the calculator's error with Retry when the settings didn't load, and no number", () => {
    page({ facts: null });
    id("creators-calc-error");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(en["d2Pages.creators.hero.titleNoShare"]);
    none("fee-calculator");
    none("creators-gate-payout");
    expect(screen.getByText(en["d2Pages.creators.gate.fees.bodyNoShare"])).toBeTruthy();
    expect(screen.getByText(en["d2Pages.creators.gate.owner.bodyNoRules"])).toBeTruthy();
    const faq = screen.getAllByTestId("creators-faq-item").map((el) => el.getAttribute("data-faq"));
    expect(faq).toEqual(["leave", "mature", "owner"]);
    fireEvent.click(screen.getByRole("button", { name: "Who owns Test Air?" }));
    expect(screen.getByText(en["d2Pages.creators.faq.owner.aNoSub"])).toBeTruthy();
  });

  it("says so when the cut itself is unreadable but other settings loaded", () => {
    page({ facts: coopFacts(SETTINGS.slice(1)) });
    expect(id("creators-calc-noshare").textContent).toBe(en["d2Pages.creators.calc.noShare"]);
    none("fee-calculator");
    none("creators-cut-split");
  });

  it("shows a live stream in the hero when one is live", () => {
    page({ live: live("aurora", { viewers: 12 }) });
    expect(within(id("creators-live")).getByTestId("stream-card").getAttribute("data-channel")).toBe("aurora");
  });
});

describe("the claim field", () => {
  const setup = (check: (u: string) => Promise<Availability>) => {
    const go = vi.fn<(href: string) => void>();
    wrap(<ClaimField host="air.example/" check={check} go={go} debounceMs={10} />);
    return { go, input: id("claim-input"), status: () => id("claim-status") };
  };

  it("checks after a pause, then goes to sign-up with the name", async () => {
    const check = vi.fn<(u: string) => Promise<Availability>>(async (username) => ({
      username,
      available: true,
      reason: null,
    }));
    const { go, input, status } = setup(check);
    fireEvent.change(input, { target: { value: "River_Tide" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("free"));
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("river_tide");
    expect(status().textContent).toBe("river_tide is free");
    fireEvent.submit(id("claim-form"));
    expect(go).toHaveBeenCalledWith("/signup?intent=stream&username=river_tide");
    expect(tracked.calls).toContain("creators.claim|submit|stream");
  });

  it("says a name is taken or reserved and stays on the page", async () => {
    const answers: Record<string, "taken" | "reserved"> = { aurora_pixel: "taken", fees: "reserved" };
    const { go, input, status } = setup(async (username) => ({
      username,
      available: false,
      reason: answers[username] ?? null,
    }));
    fireEvent.change(input, { target: { value: "aurora_pixel" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("taken"));
    expect(status().textContent).toBe("aurora_pixel is taken. Try another.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(tracked.calls).toContain("creators.claim|error|username_taken");
    fireEvent.submit(id("claim-form"));
    expect(go).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "fees" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("reserved"));
    expect(status().textContent).toBe("fees is reserved.");
  });

  it("explains the format without asking the API", async () => {
    const check = vi.fn<(u: string) => Promise<Availability>>(async (username) => ({
      username,
      available: true,
      reason: null,
    }));
    const { go, input, status } = setup(check);
    fireEvent.change(input, { target: { value: "aurora-pixel" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("invalid"));
    expect(status().textContent).toBe(en["d2Pages.creators.claim.invalid"]);
    expect(check).not.toHaveBeenCalled();
    fireEvent.submit(id("claim-form"));
    expect(go).not.toHaveBeenCalled();
    expect(tracked.calls).toContain("creators.claim|error|invalid");
  });

  it("stays quiet when the check fails (a 501 until the endpoint ships) and still lets the visitor go on", async () => {
    const { go, input, status } = setup(async () => {
      throw new Error("NOT_IMPLEMENTED");
    });
    fireEvent.change(input, { target: { value: "newname" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("unchecked"));
    expect(status().textContent).toBe("We'll check newname when you create your account.");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    fireEvent.submit(id("claim-form"));
    expect(go).toHaveBeenCalledWith("/signup?intent=stream&username=newname");
  });

  it("only lets the newest answer set the status", async () => {
    let release: (v: Availability) => void = () => undefined;
    const slow = new Promise<Availability>((r) => {
      release = r;
    });
    const check = vi.fn<(u: string) => Promise<Availability>>((username) =>
      username === "first_name" ? slow : Promise.resolve({ username, available: false, reason: "taken" }),
    );
    const { input, status } = setup(check);
    fireEvent.change(input, { target: { value: "first_name" } });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "second_name" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("taken"));
    await act(async () => {
      release({ username: "first_name", available: true, reason: null });
      await slow;
    });
    expect(status().getAttribute("data-status")).toBe("taken");
  });

  it("clears the status when the field is emptied", async () => {
    const { input, status } = setup(async (username) => ({ username, available: true, reason: null }));
    fireEvent.change(input, { target: { value: "somebody" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("free"));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(status().getAttribute("data-status")).toBe("idle"));
  });
});

describe("/coop join band", () => {
  it("states the refundable share, the qualifying sub and the streamer hours, and links membership", () => {
    wrap(<CoopJoinBand membership={FACTS.membership} />);
    expect(id("coop-join-band-body").textContent).toBe(
      "A $5.00 share makes you a member, refunded if you leave. Or subscribe to any channel at $3.00 or more a month. Streamers join automatically once they've streamed 10 hours.",
    );
    const cta = id("coop-join-band-cta");
    expect(cta.getAttribute("href")).toBe("/coop/membership");
    expect(cta.hasAttribute("data-filled-cta")).toBe(true);
    fireEvent.click(cta);
    expect(tracked.calls).toEqual(["coop.band|view|none", "coop.band|click|join"]);
  });

  it("drops what the settings don't support, and speaks generally without them", () => {
    const membership = FACTS.membership;
    if (!membership) throw new Error("no membership facts");
    wrap(<CoopJoinBand membership={{ ...membership, refundableOnExit: false, minSubCents: null }} />);
    expect(id("coop-join-band-body").textContent).toBe(
      "A $5.00 share makes you a member. Streamers join automatically once they've streamed 10 hours.",
    );
    cleanup();
    wrap(<CoopJoinBand membership={null} />);
    expect(id("coop-join-band-body").textContent).toBe(en["d2Pages.coopBand.generic"]);
    id("coop-join-band-cta");
  });

  it("sits under the overview's header, and the overview renders without one", () => {
    wrap(
      <CoopOverview
        signedIn={false}
        membership={null}
        openProposals={[]}
        council={null}
        months={null}
        joinBand={<CoopJoinBand membership={null} />}
      />,
    );
    const coop = id("coop");
    const band = id("coop-join-band");
    expect(coop.contains(band)).toBe(true);
    expect(band.previousElementSibling?.tagName).toBe("HEADER");
    cleanup();
    wrap(<CoopOverview signedIn={false} membership={null} openProposals={[]} council={null} months={null} />);
    none("coop-join-band");
  });
});

describe("co-op explainers for visitors", () => {
  it("patronage: what it is, where the books stand, the weights, and the way in", () => {
    wrap(
      <PatronageExplainer
        weights={{ revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 }}
        standing={{ months: 12, surplusCents: -12_000, distributedCents: 0, currency: "usd" }}
      />,
    );
    id("patronage-explainer");
    expect(id("patronage-standing-line").textContent).toBe(en["d2Pages.patronage.now.deficit"]);
    expect(
      within(id("patronage-weights"))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Sub and tip revenue: 50%",
      "Hours streamed: 20%",
      "Video relayed for other viewers: 20%",
      "Hours watched: 10%",
    ]);
    expect(id("coop-explainer-signup").getAttribute("href")).toBe("/signup?intent=join&redirect=%2Fcoop%2Fpatronage");
    expect(id("coop-explainer-signin").getAttribute("href")).toBe("/signin?redirect=%2Fcoop%2Fpatronage");
    expect(id("coop-explainer-signup").hasAttribute("data-filled-cta")).toBe(true);
    expect(id("coop-explainer-signin").hasAttribute("data-filled-cta")).toBe(false);
  });

  it("patronage: a past surplus and what was shared, never a projection; sections drop without data", () => {
    wrap(
      <PatronageExplainer
        weights={null}
        standing={{ months: 12, surplusCents: 150_000, distributedCents: 40_000, currency: "usd" }}
      />,
    );
    expect(id("patronage-standing-line").textContent).toBe(
      "Over the last 12 months the co-op had $1,500.00 left over. Members decide whether to share any of it.",
    );
    expect(screen.getByText("Members have shared $400.00 by contribution in that time.")).toBeTruthy();
    none("patronage-weights");
    cleanup();
    wrap(<PatronageExplainer weights={null} standing={null} />);
    none("patronage-standing");
    expect(screen.getByText(en["d2Pages.patronage.what.body"])).toBeTruthy();
  });

  it("jury: what jurors do, who can serve, and the way in", () => {
    wrap(<JuryExplainer />);
    id("jury-explainer");
    expect(screen.getByText(en["jury.explainer.cases"])).toBeTruthy();
    expect(screen.queryByText(en["jury.explainer.optout"])).toBeNull();
    expect(screen.getByText(en["d2Pages.jury.who.body"])).toBeTruthy();
    expect(id("coop-explainer-signup").getAttribute("href")).toBe("/signup?intent=join&redirect=%2Fcoop%2Fjury");
  });
});

describe("public legal pages", () => {
  const doc = {
    id: "d1",
    kind: "terms" as const,
    title: "Terms of service",
    version: "2026-11-01-w3-draft",
    body: "> **Draft.** Questions: help@air.example.\n\nIntro.\n\n## 1. Who can use it\n\n- Be 16.\n\n## 2. Your account\n\nKeep it safe.\n",
    isDraft: true,
    requiresAcceptance: true,
  };

  it("renders the document with a table of contents that links each section", () => {
    wrap(<LegalPage kind="terms" doc={doc} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Terms of service");
    expect(screen.getByText("Version 2026-11-01-w3-draft · Draft pending legal review")).toBeTruthy();
    const toc = id("legal-toc");
    const links = within(toc).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#1-who-can-use-it", "#2-your-account"]);
    const body = id("legal-body");
    expect(body.querySelector("h2#1-who-can-use-it")?.textContent).toBe("1. Who can use it");
    expect(body.querySelector("blockquote strong")?.textContent).toBe("Draft.");
    expect(body.querySelector("a[href='mailto:help@air.example']")).toBeTruthy();
    expect(screen.getAllByTestId("legal-other").map((a) => a.getAttribute("href"))).toEqual([
      "/privacy",
      "/guidelines",
    ]);
  });

  it("never renders the body's markup as HTML", () => {
    wrap(<LegalPage kind="privacy" doc={{ ...doc, kind: "privacy", body: "<img src=x onerror=alert(1)> <b>x</b>" }} />);
    const body = id("legal-body");
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("b")).toBeNull();
    expect(body.textContent).toContain("<img src=x onerror=alert(1)>");
    none("legal-toc");
  });

  it("says when nothing is published, and offers Retry when the load failed", () => {
    wrap(<LegalPage kind="guidelines" doc={null} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(en["d2Pages.legal.guidelines"]);
    id("legal-missing");
    cleanup();
    wrap(<LegalPage kind="guidelines" doc={undefined} />);
    id("legal-error");
    expect(screen.getByRole("button", { name: en["common.retry"] })).toBeTruthy();
  });
});
