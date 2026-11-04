// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-settings (F25, F28): the co-op's plain-text empties are `<EmptyState>`s. No elections and no
 * board seats explain themselves (nobody on the page can fill them, so no action); an empty
 * discussion gives a member who may comment a "Write the first comment" action that focuses the
 * composer. While the discussion loads it shows a skeleton with `aria-busy`, not a blank.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CouncilPage } from "../src/components/coop/council.tsx";
import { ProposalPage, type ProposalPageProps } from "../src/components/coop/proposal.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { ProposalDto } from "../src/lib/coop.ts";
import { ME, NOW, council, proposal, votingProposal } from "./coop-fixtures.ts";

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

const noop = () => undefined;
const asyncNoop = async () => undefined;

function proposalPage(p: ProposalDto, over: Partial<ProposalPageProps> = {}) {
  return wrap(
    <ProposalPage
      proposal={p}
      comments={[]}
      hasMoreComments={false}
      loadingMoreComments={false}
      onLoadMoreComments={noop}
      meId={ME}
      member
      councilMember={false}
      now={NOW}
      votingClosed={false}
      onSubmitProposal={asyncNoop}
      onWithdraw={asyncNoop}
      onActionError={noop}
      onComment={asyncNoop}
      onVote={asyncNoop}
      onCouncilRespond={asyncNoop}
      {...over}
    />,
  );
}

const isEmptyState = (el: HTMLElement) => el.getAttribute("data-slot") === "empty-state";

describe("council empties (F25)", () => {
  it("no elections and no board seats are EmptyStates with a heading and a description", () => {
    wrap(<CouncilPage council={council} board={[]} elections={[]} />);
    const elections = screen.getByTestId("council-elections-empty");
    const board = screen.getByTestId("council-board-empty");
    for (const [el, title, hint] of [
      [elections, "coop.elections.empty", "settings.coop.electionsEmptyHint"],
      [board, "coop.board.empty", "settings.coop.boardEmptyHint"],
    ] as const) {
      expect(isEmptyState(el)).toBe(true);
      expect(within(el).getByRole("heading", { level: 3 }).textContent).toBe(t(title));
      expect(el.textContent).toContain(t(hint));
      // Nobody on this page can schedule an election or fill a seat.
      expect(within(el).queryByRole("button")).toBeNull();
    }
  });
});

describe("the empty discussion (F25)", () => {
  it("a member gets an EmptyState whose action focuses the composer", () => {
    proposalPage(votingProposal());
    const empty = screen.getByTestId("proposal-discussion-empty");
    expect(isEmptyState(empty)).toBe(true);
    expect(within(empty).getByRole("heading", { level: 3 }).textContent).toBe(t("coop.discussion.empty"));
    const action = within(empty).getByTestId("empty-state-action");
    expect(action.textContent).toBe(t("settings.coop.discussionStart"));
    fireEvent.click(action);
    expect(document.activeElement).toBe(screen.getByTestId("proposal-comment-body"));
  });

  it("a non-member gets the EmptyState without an action, saying why", () => {
    proposalPage(votingProposal(), { member: false });
    const empty = screen.getByTestId("proposal-discussion-empty");
    expect(within(empty).queryByTestId("empty-state-action")).toBeNull();
    expect(empty.textContent).toContain(t("coop.discussion.membersOnly"));
    // Said once, in the empty state, not again under it.
    expect(screen.getAllByText(t("coop.discussion.membersOnly"))).toHaveLength(1);
  });

  it("a closed discussion says it is closed", () => {
    proposalPage(proposal({ status: "rejected" }));
    const empty = screen.getByTestId("proposal-discussion-empty");
    expect(within(empty).queryByTestId("empty-state-action")).toBeNull();
    expect(empty.textContent).toContain(t("coop.discussion.closed"));
  });

  it("while the comments load: a skeleton with aria-busy (F28)", () => {
    proposalPage(votingProposal(), { comments: null });
    const loading = screen.getByTestId("proposal-comments-loading");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("proposal-discussion-empty")).toBeNull();
  });
});

describe("no plain-text empties left (F25)", () => {
  it.each([
    ["src/components/coop/council.tsx", ['<p>{t("coop.elections.empty")}</p>', '<p>{t("coop.board.empty")}</p>']],
    ["src/components/coop/proposal.tsx", ['<p>{t("coop.discussion.empty")}</p>']],
  ])("%s", (file, plain) => {
    const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    for (const p of plain) expect(text).not.toContain(p);
  });
});
