// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The advisory jury on the web (docs/testing/b7-selectors.md, "Advisory jury"; ADR 0038): the
 * opt-in states, a case card's blurred evidence and per-item reveal, vote submission, the staff
 * flags, and the transparency results with suppressed cells and the revealed seed.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { JuryCaseCard } from "../src/components/jury/case-card.tsx";
import { JuryPage, type JuryPageProps } from "../src/components/jury/jury-page.tsx";
import {
  countAttr,
  ineligibleReason,
  panelClosesAt,
  previousPeriod,
  ruleVersion,
  type JuryCaseDto,
  type JuryResultsDto,
  type JuryStatusDto,
} from "../src/components/jury/model.ts";
import { JuryResults, JuryResultsFigures } from "../src/components/transparency/jury-results.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

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
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const PANEL_ID = "0192d6f1-0000-7000-8000-0000000000d1";
const CASE_ID = "0192d6f1-0000-7000-8000-0000000000e2";
const status = (over: Partial<JuryStatusDto> = {}): JuryStatusDto => ({
  enabled: true,
  eligible: true,
  optedIn: false,
  optedInAt: null,
  seat: null,
  ...over,
});
const kase = (over: Partial<JuryCaseDto> = {}): JuryCaseDto => ({
  id: CASE_ID,
  subjectKind: "moderation_case",
  ruleRef: "safety.weapons@1",
  clauseTitle: "Weapons",
  tier: "t1",
  outcome: "actioned",
  automated: true,
  subjectPseudonym: "3FA2C1D0",
  evidence: [
    { kind: "text", value: "a kept excerpt", contentWarning: false },
    { kind: "image", value: "data:image/jpeg;base64,AAAA", contentWarning: true },
  ],
  myVote: null,
  ...over,
});
const panel = {
  id: PANEL_ID,
  period: "2026-11",
  seedCommitment: "ab".repeat(32),
  seed: null,
  openedAt: "2026-11-01T06:11:00.000Z",
  closedAt: null,
  seats: 7,
  cases: 1,
};
function page(over: Partial<JuryPageProps> = {}) {
  const props: JuryPageProps = {
    status: status(),
    ineligible: "other",
    panel: null,
    cases: null,
    flags: null,
    onOptInChange: vi.fn<JuryPageProps["onOptInChange"]>(async () => {}),
    onVote: vi.fn<JuryPageProps["onVote"]>(async () => {}),
    ...over,
  };
  wrap(<JuryPage {...props} />);
  return props;
}

describe("model", () => {
  it("panel close, rule versions, periods and reasons", () => {
    expect(panelClosesAt("2026-11-01T00:00:00.000Z")).toBe("2026-11-15T00:00:00.000Z");
    expect(ruleVersion("safety.weapons@3")).toBe(3);
    expect(ruleVersion(null)).toBeNull();
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(previousPeriod("2026-11")).toBe("2026-10");
    expect(ineligibleReason({ role: "moderator" }, ["viewer"])).toBe("staff");
    expect(ineligibleReason({ role: "user" }, [])).toBe("not_member");
    expect(ineligibleReason({ role: "user" }, null)).toBe("other");
    expect(countAttr({ suppressed: true })).toBe("suppressed");
    expect(countAttr({ suppressed: false, value: 12 })).toBe("12");
  });
});

describe("opt-in states", () => {
  it("off: the disabled empty state and nothing else", () => {
    page({ status: status({ enabled: false }) });
    expect(byId("jury-page")).not.toBeNull();
    expect(byId("jury-disabled")).not.toBeNull();
    expect(byId("jury-optin")).toBeNull();
    expect(byId("jury-optin-explainer")).toBeNull();
  });

  it("eligible and out: the switch is off, with the explainer; switching calls opt-in", async () => {
    const props = page();
    const sw = byId("jury-optin")!;
    expect(sw.dataset.state).toBe("off");
    expect(byId("jury-optin-explainer")?.textContent).toContain(t("jury.explainer.blur"));
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(props.onOptInChange).toHaveBeenCalledWith(true);
  });

  it("eligible and in: the switch is on; switching calls opt-out", async () => {
    const props = page({ status: status({ optedIn: true, optedInAt: "2026-11-01T00:00:00.000Z" }) });
    expect(byId("jury-optin")?.dataset.state).toBe("on");
    expect(byId("jury-panel")).toBeNull();
    await act(async () => {
      fireEvent.click(byId("jury-optin")!);
    });
    expect(props.onOptInChange).toHaveBeenCalledWith(false);
  });

  it("ineligible: the reason, no switch", () => {
    page({ status: status({ eligible: false }), ineligible: "staff" });
    expect(byId("jury-optin")).toBeNull();
    expect(byId("jury-ineligible")?.dataset.reason).toBe("staff");
    expect(byId("jury-ineligible")?.textContent).toContain(t("jury.ineligible.staff"));
  });

  it("ineligible but still opted in: the reason and a switch to leave the draw", async () => {
    const props = page({
      status: status({ eligible: false, optedIn: true, optedInAt: "2026-11-01T00:00:00.000Z" }),
      ineligible: "not_member",
    });
    expect(byId("jury-ineligible")?.dataset.reason).toBe("not_member");
    expect(byId("jury-optin")?.dataset.state).toBe("on");
    await act(async () => {
      fireEvent.click(byId("jury-optin")!);
    });
    expect(props.onOptInChange).toHaveBeenCalledWith(false);
  });

  it("off but still opted in: the disabled state and a switch to leave the draw", async () => {
    const props = page({
      status: status({ enabled: false, optedIn: true, optedInAt: "2026-11-01T00:00:00.000Z" }),
    });
    expect(byId("jury-disabled")).not.toBeNull();
    expect(byId("jury-page")?.textContent).toContain(t("jury.disabled.stillIn"));
    expect(byId("jury-optin")?.dataset.state).toBe("on");
    expect(byId("jury-optin-explainer")).toBeNull();
    await act(async () => {
      fireEvent.click(byId("jury-optin")!);
    });
    expect(props.onOptInChange).toHaveBeenCalledWith(false);
  });

  it("seated: the panel with its close date and cases", () => {
    page({
      status: status({ optedIn: true, seat: { panelId: PANEL_ID, period: "2026-11" } }),
      panel,
      cases: [kase()],
    });
    const p = byId("jury-panel")!;
    expect(p.dataset.panelId).toBe(PANEL_ID);
    expect(p.dataset.closesAt).toBe("2026-11-15T06:11:00.000Z");
    expect(all("jury-case")).toHaveLength(1);
  });

  it("staff see the re-review flags", () => {
    page({
      flags: [
        {
          id: "0192d6f1-0000-7000-8000-0000000000f3",
          caseId: CASE_ID,
          panelId: PANEL_ID,
          subjectKind: "report",
          subjectId: "0192d6f1-0000-7000-8000-0000000000f4",
          disagree: 5,
          votes: 7,
          createdAt: "2026-11-15T06:11:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    expect(byId("jury-flag")?.dataset.caseId).toBe(CASE_ID);
  });
});

describe("case card", () => {
  it("shows the clause, decision and pseudonym; media is blurred until revealed", async () => {
    wrap(<JuryCaseCard kase={kase()} onVote={vi.fn<JuryPageProps["onVote"]>()} />);
    const card = byId("jury-case")!;
    expect(card.dataset).toMatchObject({ caseId: CASE_ID, kind: "moderation_case", tier: "t1", automated: "true" });
    expect(byId("jury-case-clause")?.dataset.ruleRef).toBe("safety.weapons@1");
    expect(byId("jury-case-clause")?.textContent).toContain("Weapons");
    expect(card.textContent).toContain("3FA2C1D0");
    expect(byId("jury-evidence-text")?.textContent).toBe("a kept excerpt");
    const media = byId("jury-evidence-media")!;
    expect(media.dataset.revealed).toBe("false");
    expect(media.querySelector('[data-obscured="true"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(byId("jury-evidence-reveal")!);
    });
    expect(byId("jury-evidence-media")?.dataset.revealed).toBe("true");
    expect(byId("jury-evidence-media")?.querySelector('[data-obscured="true"]')).toBeNull();
  });

  it("under prefers-reduced-transparency the blurred image is not drawn until revealed", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("reduced-transparency"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      wrap(<JuryCaseCard kase={kase()} onVote={vi.fn<JuryPageProps["onVote"]>()} />);
      expect(byId("jury-evidence-media")?.querySelector("img")).toBeNull();
      await act(async () => {
        fireEvent.click(byId("jury-evidence-reveal")!);
      });
      expect(byId("jury-evidence-media")?.querySelector("img")).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("vote submission: a vote and a reason, then submit", async () => {
    const onVote = vi.fn<JuryPageProps["onVote"]>(async () => {});
    wrap(<JuryCaseCard kase={kase()} onVote={onVote} />);
    const submit = byId("jury-vote-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(byId("jury-vote-disagree")!);
    expect(byId("jury-vote-disagree")?.getAttribute("aria-pressed")).toBe("true");
    expect(submit.disabled).toBe(true);
    const trigger = byId("jury-reason")!;
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    await waitFor(() => expect(byId("jury-reason-action_too_severe")).not.toBeNull());
    const option = byId("jury-reason-action_too_severe")!;
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(option, { button: 0 });
    fireEvent.click(option);
    await waitFor(() => expect(byId("jury-reason")?.dataset.value).toBe("action_too_severe"));
    await act(async () => {
      fireEvent.click(byId("jury-vote-submit")!);
    });
    expect(onVote).toHaveBeenCalledWith(CASE_ID, "disagree", "action_too_severe");
  });

  it("a cast vote shows instead of the form", () => {
    wrap(
      <JuryCaseCard
        kase={kase({ myVote: { vote: "agree", reasonCode: "clause_fits" } })}
        onVote={vi.fn<JuryPageProps["onVote"]>()}
      />,
    );
    expect(byId("jury-vote-submit")).toBeNull();
    expect(byId("jury-voted")?.dataset).toMatchObject({ vote: "agree", reason: "clause_fits" });
  });
});

describe("results", () => {
  const n = (value: number) => ({ suppressed: false as const, value });
  const S = { suppressed: true as const };
  const closed: JuryResultsDto = {
    period: "2026-10",
    panelSize: 7,
    seedCommitment: "cd".repeat(32),
    seed: "ef".repeat(32),
    rows: [
      { clauseId: "honesty.spam", clauseTitle: "Spam", tier: null, agree: n(12), disagree: n(0), unsure: n(0) },
      { clauseId: "safety.weapons", clauseTitle: "Weapons", tier: "t1", agree: S, disagree: S, unsure: S },
      { clauseId: "decency.hate", clauseTitle: "Hate", tier: null, agree: n(14), disagree: S, unsure: S },
    ],
  };

  it("rows carry their counts or the suppressed marker; the seed and period show", () => {
    wrap(<JuryResultsFigures results={closed} />);
    const rows = all("jury-results-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.dataset).toMatchObject({ ruleRef: "honesty.spam", tier: "none", agree: "12", disagree: "0" });
    expect(rows[1]!.dataset.suppressed).toBe("true");
    expect(rows[2]!.dataset).toMatchObject({ agree: "14", disagree: "suppressed", unsure: "suppressed" });
    expect(all("jury-results-suppressed")).toHaveLength(5);
    const seed = byId("jury-results-seed")!;
    expect(seed.dataset.period).toBe("2026-10");
    expect(seed.textContent).toContain("ef".repeat(32));
  });

  it("no closed panel: the empty state; a sitting panel names its commitment", () => {
    wrap(
      <JuryResultsFigures
        results={{ period: "2026-11", panelSize: 7, seedCommitment: "ab".repeat(32), seed: null, rows: [] }}
      />,
    );
    expect(byId("jury-results-empty")?.textContent).toContain("ab".repeat(32));
  });

  it("opens on the last closed month when this month's panel is still sitting", async () => {
    const asked: string[] = [];
    const load = async (period: string): Promise<JuryResultsDto> => {
      asked.push(period);
      return asked.length === 1
        ? { period, panelSize: 7, seedCommitment: "ab".repeat(32), seed: null, rows: [] }
        : { ...closed, period };
    };
    wrap(<JuryResults load={load} />);
    await waitFor(() => expect(byId("jury-results-seed")).not.toBeNull());
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe(previousPeriod(asked[0]!));
    expect(byId("jury-results")).not.toBeNull();
  });
});
