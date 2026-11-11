// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d6-studio: the checklist's "Get paid" step (overhaul wave 4, J2-h). The rules (listed after the
 * first stream while open, though optional; never before), the one line from `payout.rules`, and
 * the action per payout account: the Connect onboarding link, the treasurer's instructions with
 * "I've contacted the treasurer" (which marks the step), and the revenue page as the fallback.
 */
import type { StreamSetupState } from "@commonair/contracts/dto";
import { STREAM_SETUP_STEPS, type StreamSetupStep } from "@commonair/contracts/enums";
import { LocaleProvider, TooltipProvider, formatMoney } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GoLiveChecklist } from "../src/components/setup-checklist/checklist.tsx";
import type { SetupClient } from "../src/components/setup-checklist/client.ts";
import { STEP_KEYS } from "../src/components/setup-checklist/keys.ts";
import { checklistPhase, currentStep, phaseSteps } from "../src/components/setup-checklist/model.ts";
import { payoutRuleLine, payoutRules } from "../src/components/setup-checklist/payout-rules.ts";
import type { PayoutStepClient } from "../src/components/setup-checklist/payout-step.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { PayoutAccountDto } from "../src/lib/money.ts";

const track = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => {
    track.calls.push(`${surface}|${action}|${step}`);
  },
}));

afterEach(() => {
  cleanup();
  track.calls.length = 0;
  vi.restoreAllMocks();
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

type Done = Partial<Record<StreamSetupStep, boolean | null>>;
/** After the first stream: every required step done unless `done` says otherwise. */
function afterFirst(done: Done): StreamSetupState {
  const steps = STREAM_SETUP_STEPS.map((step) => ({
    step,
    done: step in done ? (done[step] ?? null) : step === "import_twitch" ? null : step === "rehearsal" ? false : true,
    optional: step === "rehearsal" || step === "get_paid",
  }));
  return { steps, signupIntent: null, complete: steps.every((s) => s.optional || s.done !== false) };
}

const RULES = [
  { key: "platform.cut", value: { streamerShare: 0.9, coopShare: 0.1 } },
  { key: "payout.rules", value: { minimumCents: 2500, schedule: "monthly", holdDays: 7, currency: "usd" } },
];

function setupClient(states: StreamSetupState[]) {
  let i = 0;
  return {
    state: vi.fn<SetupClient["state"]>(async () => {
      const s = states[Math.min(i, states.length - 1)];
      i += 1;
      if (!s) throw new Error("no state");
      return s;
    }),
    mark: vi.fn<SetupClient["mark"]>(async () => ({ ok: true })),
    ingest: vi.fn<SetupClient["ingest"]>(async () => {
      throw new Error("not used");
    }),
    obsConfig: vi.fn<SetupClient["obsConfig"]>(async () => ({ filename: "x.json", json: "{}" })),
    createKey: vi.fn<SetupClient["createKey"]>(async () => ({ key: "k", prefix: "p" })),
    health: vi.fn<SetupClient["health"]>(async () => {
      throw new Error("not used");
    }),
    followLinkConversions: vi.fn<SetupClient["followLinkConversions"]>(async () => 0),
    createFollowLink: vi.fn<SetupClient["createFollowLink"]>(async () => ({ url: "https://site.test/m/x" })),
  } satisfies SetupClient;
}

function payoutClient(account: PayoutAccountDto | Error, settings: unknown[] = RULES) {
  return {
    account: vi.fn<PayoutStepClient["account"]>(async () => {
      if (account instanceof Error) throw account;
      return account;
    }),
    settings: vi.fn<PayoutStepClient["settings"]>(async () => settings as { key: string; value: unknown }[]),
  } satisfies PayoutStepClient;
}

const STRIPE: PayoutAccountDto = {
  provider: "stripe",
  payoutsEnabled: false,
  onboardingUrl: "https://connect.stripe.test/onboard/abc",
  instructions: null,
};
const MANUAL: PayoutAccountDto = {
  provider: "manual",
  payoutsEnabled: false,
  onboardingUrl: null,
  instructions: "Email the treasurer with your bank details.",
};

const ruleLine = () => t("d6Studio.getPaid.rule.monthly", { minimum: formatMoney(2500, "usd", locale) });

describe("the step's rules", () => {
  it("is listed after the first stream while open, though optional, and becomes current", () => {
    const open = afterFirst({ get_paid: false });
    expect(open.complete).toBe(true);
    expect(checklistPhase(open)).toBe("after");
    expect(phaseSteps(open).map((s) => s.step)).toEqual(["get_paid"]);
    expect(currentStep(phaseSteps(open))).toBe("get_paid");
  });

  it("a required step open comes first", () => {
    const both = afterFirst({ get_paid: false, bring_your_audience: false });
    expect(phaseSteps(both).map((s) => s.step)).toEqual(["get_paid", "bring_your_audience"]);
    expect(currentStep(phaseSteps(both))).toBe("bring_your_audience");
  });

  it("done or not applying: complete", () => {
    expect(checklistPhase(afterFirst({ get_paid: true }))).toBe("complete");
    expect(checklistPhase(afterFirst({ get_paid: null }))).toBe("complete");
  });

  it("the rehearsal still does not keep the card open", () => {
    expect(checklistPhase(afterFirst({ get_paid: null, rehearsal: false }))).toBe("complete");
  });

  it("has its own title key", () => {
    expect(t(STEP_KEYS.get_paid.title)).toBe("Get paid: add payout details");
  });
});

describe("payout.rules", () => {
  it("reads the minimum and schedule, never a literal", () => {
    expect(payoutRules(RULES)).toEqual({ minimumCents: 2500, schedule: "monthly", currency: "usd" });
    expect(payoutRuleLine({ minimumCents: 2500, schedule: "monthly", currency: "usd" }, locale)).toBe(ruleLine());
    expect(payoutRuleLine({ minimumCents: 5000, schedule: "monthly", currency: "eur" }, locale)).toContain(
      formatMoney(5000, "eur", locale),
    );
    expect(payoutRuleLine({ minimumCents: 0, schedule: "monthly", currency: "usd" }, locale)).toBe(
      t("d6Studio.getPaid.rule.monthlyNoMinimum"),
    );
  });

  it("missing or unknown shapes read as nothing", () => {
    expect(payoutRules(null)).toBeNull();
    expect(payoutRules([])).toBeNull();
    expect(
      payoutRules([{ key: "payout.rules", value: { minimumCents: 2500, schedule: "weekly", currency: "usd" } }]),
    ).toBeNull();
    expect(
      payoutRules([{ key: "payout.rules", value: { minimumCents: -1, schedule: "monthly", currency: "usd" } }]),
    ).toBeNull();
  });
});

describe("the rendered step", () => {
  it("Stripe: the rule line and the onboarding link", async () => {
    const payout = payoutClient(STRIPE);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setupClient([afterFirst({ get_paid: false })])}
        payoutClient={payout}
      />,
    );
    const link = await screen.findByTestId("setup-step-get_paid-action");
    expect(link.getAttribute("href")).toBe(STRIPE.onboardingUrl);
    expect(link.textContent).toBe(t("d6Studio.getPaid.action"));
    expect(screen.getByText(t("d6Studio.getPaid.title"))).toBeTruthy();
    await waitFor(() => expect(screen.getByText(ruleLine())).toBeTruthy());
    expect(screen.queryByTestId("setup-step-get_paid-mark")).toBeNull();
    // Neutral: no brand fill on a money action.
    expect(link.getAttribute("data-filled-cta")).toBeNull();
    fireEvent.click(link);
    expect(track.calls).toContain("studio.checklist|click|get_paid");
  });

  it("Stripe Connect not finished: Not now marks the step, and the card clears", async () => {
    const setup = setupClient([afterFirst({ get_paid: false }), afterFirst({ get_paid: true })]);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setup}
        payoutClient={payoutClient(STRIPE)}
      />,
    );
    const skip = await screen.findByTestId("setup-step-get_paid-skip");
    expect(skip.textContent).toBe(t("d6Studio.getPaid.notNow"));
    // The payout account loads after the step renders: wait for it rather than read it once.
    await waitFor(() => expect(screen.getByTestId("setup-get-paid").getAttribute("data-state")).toBe("connect"));
    fireEvent.click(skip);
    await waitFor(() => expect(setup.mark).toHaveBeenCalledWith("aurora", "get_paid"));
    await waitFor(() => expect(screen.queryByTestId("setup-checklist")).toBeNull());
    expect(setup.state).toHaveBeenCalledTimes(2);
  });

  it("the payout account failing still leaves Not now, so the card can clear", async () => {
    const setup = setupClient([afterFirst({ get_paid: false })]);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setup}
        payoutClient={payoutClient(new Error("down"))}
      />,
    );
    fireEvent.click(await screen.findByTestId("setup-step-get_paid-skip"));
    await waitFor(() => expect(setup.mark).toHaveBeenCalledWith("aurora", "get_paid"));
  });

  it("manual: the treasurer's instructions, and I've contacted the treasurer marks the step", async () => {
    const setup = setupClient([afterFirst({ get_paid: false }), afterFirst({ get_paid: true })]);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setup}
        payoutClient={payoutClient(MANUAL)}
      />,
    );
    expect((await screen.findByTestId("setup-get-paid-instructions")).textContent).toBe(MANUAL.instructions);
    expect(screen.queryByTestId("setup-step-get_paid-action")).toBeNull();
    expect(screen.queryByTestId("setup-step-get_paid-skip")).toBeNull();
    const mark = screen.getByTestId("setup-step-get_paid-mark");
    expect(mark.textContent).toBe(t("d6Studio.getPaid.contacted"));
    fireEvent.click(mark);
    await waitFor(() => expect(setup.mark).toHaveBeenCalledWith("aurora", "get_paid"));
    expect(track.calls).toContain("studio.checklist|click|get_paid");
    // The reload answers with the step done: the card goes away.
    await waitFor(() => expect(screen.queryByTestId("setup-checklist")).toBeNull());
    expect(setup.state).toHaveBeenCalledTimes(2);
  });

  it("manual with no instructions says the treasurer sets it up, and still offers the mark", async () => {
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setupClient([afterFirst({ get_paid: false })])}
        payoutClient={payoutClient({ ...MANUAL, instructions: null })}
      />,
    );
    expect((await screen.findByTestId("setup-get-paid")).getAttribute("data-state")).toBe("waiting");
    expect(screen.getByText(t("d6Studio.getPaid.waiting"))).toBeTruthy();
    expect(screen.getByTestId("setup-step-get_paid-mark")).toBeTruthy();
  });

  it("a failed mark says so and keeps the step", async () => {
    const setup = setupClient([afterFirst({ get_paid: false })]);
    setup.mark.mockRejectedValueOnce(new Error("nope"));
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setup}
        payoutClient={payoutClient(MANUAL)}
      />,
    );
    fireEvent.click(await screen.findByTestId("setup-step-get_paid-mark"));
    await waitFor(() => expect(setup.mark).toHaveBeenCalled());
    expect(screen.getByTestId("setup-checklist")).toBeTruthy();
    expect(setup.state).toHaveBeenCalledTimes(1);
  });

  it("without the account (failed) or while not current: the revenue page; the plain hint without rules", async () => {
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setupClient([afterFirst({ get_paid: false, bring_your_audience: false })])}
        payoutClient={payoutClient(new Error("down"), [])}
      />,
    );
    const link = await screen.findByTestId("setup-step-get_paid-revenue");
    expect(link.getAttribute("href")).toBe("/revenue");
    expect(screen.getByText(t("d6Studio.getPaid.hint"))).toBeTruthy();
  });

  it("not applying: never listed, and the payout account is never read", async () => {
    const payout = payoutClient(STRIPE);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={setupClient([afterFirst({ get_paid: null, bring_your_audience: false })])}
        payoutClient={payout}
      />,
    );
    await screen.findByTestId("setup-checklist");
    expect(document.querySelector('[data-step="get_paid"]')).toBeNull();
    expect(payout.account).not.toHaveBeenCalled();
    expect(payout.settings).not.toHaveBeenCalled();
  });
});
