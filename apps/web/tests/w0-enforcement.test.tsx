// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Statements of reasons on /settings/appeals (ADR 0019, docs/testing/w0-selectors.md "Test ids"). */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppealDto } from "../src/components/safety/client.ts";
import {
  EnforcementList,
  EnforcementSection,
  automationLabel,
  mayAppealStatement,
  restrictionLabel,
  type EnforcementClient,
  type EnforcementStatementDto,
} from "../src/components/safety/enforcement.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const CASE = "0192f000-0000-7000-8000-0000000000c1";
const restricted: EnforcementStatementDto = {
  id: "0192f000-0000-7000-8000-0000000000a1",
  sourceAuditId: "0192f000-0000-7000-8000-0000000000b1",
  sourceAction: "moderation.t1.restrict",
  recipientUserId: "0192f000-0000-7000-8000-0000000000d1",
  channelId: "0192f000-0000-7000-8000-0000000000e1",
  content: { type: "broadcast", id: "0192f000-0000-7000-8000-0000000000f1" },
  restriction: { kind: "visibility", detail: "restricted", endsAt: null, territorialScope: "all" },
  facts: {
    code: "classifier",
    category: "weapons",
    tier: "t1",
    threshold: 0.95,
    capturedAt: "2026-10-27T12:00:00.000Z",
  },
  source: "own_initiative",
  automatedDetection: true,
  automatedDecision: "fully",
  ground: { kind: "terms", clauseId: "safety.weapons", clauseVersion: 1, legalBasis: null },
  documents: {
    guidelinesId: "0192f000-0000-7000-8000-000000000101",
    noticeId: "0192f000-0000-7000-8000-000000000102",
  },
  appeal: { kind: "moderation", subjectType: "moderation_case", subjectId: CASE },
  createdAt: "2026-10-27T12:00:00.000Z",
  clauseTitle: "Dangerous weapons",
  explanation: "Content that shows weapons in a way that threatens people is not allowed.",
  noticeIsDraft: true,
  moderatorNote: null,
  appealId: null,
  reversedAt: null,
};
const t0: EnforcementStatementDto = {
  ...restricted,
  id: "0192f000-0000-7000-8000-0000000000a2",
  sourceAction: "moderation.t0.match",
  restriction: { kind: "account", detail: "suspended", endsAt: null, territorialScope: "all" },
  facts: { code: "hash_match", listCategory: "ncii", capturedAt: "2026-10-27T12:00:00.000Z" },
  ground: { kind: "illegal", clauseId: "illegal.ncii", clauseVersion: 1, legalBasis: "us.take-it-down" },
  appeal: null,
  noticeIsDraft: false,
};
const appealed: EnforcementStatementDto = {
  ...restricted,
  id: "0192f000-0000-7000-8000-0000000000a3",
  sourceAction: "moderation.case.warn",
  restriction: { kind: "warning", detail: "none", endsAt: null, territorialScope: "all" },
  facts: { code: "moderator_review", caseId: CASE, caseOrigin: "classifier", decision: "warn" },
  automatedDecision: "not",
  moderatorNote: "Please label the stream.",
  appealId: "0192f000-0000-7000-8000-0000000000aa",
};

function stubClient(items: EnforcementStatementDto[], over: Partial<EnforcementClient> = {}) {
  const appeal = vi.fn<EnforcementClient["appeal"]>(async (s, body): Promise<AppealDto> => ({
    id: "0192f000-0000-7000-8000-0000000000ff",
    kind: s.kind,
    subjectType: s.subjectType,
    subjectId: s.subjectId,
    body,
    status: "open",
    resolution: null,
    createdAt: "2026-10-27T13:00:00.000Z",
    resolvedAt: null,
  }));
  const client: EnforcementClient = {
    list: vi.fn<EnforcementClient["list"]>(async () => ({ items, nextCursor: null })),
    appeal,
    ...over,
  };
  return { client, appeal };
}

describe("enforcement list", () => {
  it("renders each statement with the selectors' data attributes", () => {
    wrap(<EnforcementList statements={[restricted, t0, appealed]} onAppeal={async () => {}} />);
    const list = screen.getByTestId("enforcement-list");
    const rows = within(list).getAllByTestId("enforcement-statement");
    expect(rows).toHaveLength(3);
    const first = rows[0]!;
    expect(first.dataset).toMatchObject({
      statementId: restricted.id,
      sourceAction: "moderation.t1.restrict",
      restrictionKind: "visibility",
      restrictionDetail: "restricted",
      clauseId: "safety.weapons",
      clauseVersion: "1",
      automatedDecision: "fully",
      reversed: "false",
    });
    expect(first.textContent).toContain(restricted.clauseTitle);
    expect(first.textContent).toContain(restricted.explanation);
    expect(first.textContent).toContain(en["safety.enforcement.restriction.restricted"]);
    expect(first.textContent).toContain(en["safety.enforcement.automation.fully"]);
    expect(rows[2]!.textContent).toContain("Please label the stream.");
  });

  it("shows the empty state, and a skeleton while loading", () => {
    const { rerender } = wrap(<EnforcementList statements={[]} onAppeal={async () => {}} />);
    expect(screen.getByTestId("enforcement-empty")).toBeTruthy();
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <EnforcementList statements={null} onAppeal={async () => {}} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(screen.queryByTestId("enforcement-empty")).toBeNull();
    expect(screen.queryAllByTestId("enforcement-statement")).toHaveLength(0);
  });

  it("the draft notice appears only for statements made under an unreviewed notice", () => {
    wrap(<EnforcementList statements={[restricted, t0]} onAppeal={async () => {}} />);
    const [draft, final] = screen.getAllByTestId("enforcement-statement");
    expect(within(draft!).queryByTestId("enforcement-draft-notice")).not.toBeNull();
    expect(within(final!).queryByTestId("enforcement-draft-notice")).toBeNull();
  });

  it("the appeal control is absent when the appeal is null or already filed, or the decision was reversed", () => {
    wrap(
      <EnforcementList
        statements={[
          restricted,
          t0,
          appealed,
          { ...restricted, id: "0192f000-0000-7000-8000-0000000000a4", reversedAt: "2026-10-27T14:00:00.000Z" },
        ]}
        onAppeal={async () => {}}
      />,
    );
    const rows = screen.getAllByTestId("enforcement-statement");
    expect(rows.map((r) => within(r).queryByTestId("enforcement-appeal-open") !== null)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(rows[3]!.dataset.reversed).toBe("true");
    expect(rows[1]!.textContent).toContain(en["safety.enforcement.noAppeal"]);
    expect(mayAppealStatement(t0)).toBe(false);
    expect(mayAppealStatement(restricted)).toBe(true);
  });

  it("opens the shared appeal dialog prefilled from the statement's appeal and files it", async () => {
    const { client, appeal } = stubClient([restricted, t0]);
    wrap(<EnforcementSection client={client} />);
    const open = await screen.findByTestId("enforcement-appeal-open");
    fireEvent.click(open);
    const dialog = await screen.findByTestId("enforcement-appeal-dialog");
    expect(dialog.dataset).toMatchObject({
      statementId: restricted.id,
      subjectType: "moderation_case",
      subjectId: CASE,
    });
    fireEvent.change(within(dialog).getByTestId("enforcement-appeal-body"), {
      target: { value: "The object was a stage prop." },
    });
    fireEvent.click(within(dialog).getByTestId("enforcement-appeal-submit"));
    await waitFor(() =>
      expect(appeal).toHaveBeenCalledWith(
        { kind: "moderation", subjectType: "moderation_case", subjectId: CASE },
        "The object was a stage prop.",
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("enforcement-appeal-open")).toBeNull());
  });

  it("a load failure says so instead of an empty list", async () => {
    wrap(<EnforcementSection client={stubClient([], { list: async () => Promise.reject(new Error("x")) }).client} />);
    expect(await screen.findByText(en["safety.enforcement.loadFailed"])).toBeTruthy();
    expect(screen.queryByTestId("enforcement-empty")).toBeNull();
  });
});

describe("labels", () => {
  it("names every restriction and automation level", () => {
    expect(restrictionLabel({ kind: "service", detail: "suspended", endsAt: null, territorialScope: "all" })).toBe(
      en["safety.enforcement.restriction.channelSuspended"],
    );
    expect(restrictionLabel({ kind: "account", detail: "suspended", endsAt: null, territorialScope: "all" })).toBe(
      en["safety.enforcement.restriction.accountSuspended"],
    );
    for (const detail of ["removed", "disabled", "restricted", "age_gated", "none"] as const)
      expect(restrictionLabel({ kind: "visibility", detail, endsAt: null, territorialScope: "all" })).not.toBe("");
    expect(automationLabel({ automatedDecision: "not", automatedDetection: false })).toBe(
      en["safety.enforcement.automation.not"],
    );
    expect(automationLabel({ automatedDecision: "not", automatedDetection: true })).toBe(
      en["safety.enforcement.automation.notDetected"],
    );
    expect(automationLabel({ automatedDecision: "partially", automatedDetection: true })).toBe(
      en["safety.enforcement.automation.partially"],
    );
  });
});
