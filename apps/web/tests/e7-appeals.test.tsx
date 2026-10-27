// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E7 appeals on the web: account actions on /settings/appeals and the overturn effect on /admin/appeals. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppealQueueList } from "../src/components/safety/appeal-queue.tsx";
import {
  AccountActionList,
  MyAppeals,
  hasOpenAccountAppeal,
  mayAppealAccountAction,
} from "../src/components/safety/appeals.tsx";
import type {
  AccountActionDto,
  AccountActionsClient,
  AppealDto,
  AppealsClient,
} from "../src/components/safety/client.ts";
import { appealSubjectLabel, overturnEffect, overturnEffectLabel } from "../src/components/safety/labels.ts";
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

const strike: AccountActionDto = {
  id: "0192f000-0000-7000-8000-0000000000a1",
  action: "dmca_strike",
  sourceType: "dmca_notice",
  sourceId: "0192f000-0000-7000-8000-0000000000b1",
  createdAt: "2026-10-20T12:00:00.000Z",
  reversedAt: null,
  reversedReason: null,
};
const termination: AccountActionDto = {
  ...strike,
  id: "0192f000-0000-7000-8000-0000000000a2",
  action: "dmca_termination",
  createdAt: "2026-10-21T12:00:00.000Z",
};
const reversed: AccountActionDto = {
  ...strike,
  id: "0192f000-0000-7000-8000-0000000000a3",
  reversedAt: "2026-10-22T12:00:00.000Z",
  reversedReason: "counter_notice_restored",
};
const appealOf = (subjectId: string, over: Partial<AppealDto> = {}): AppealDto => ({
  id: "0192f000-0000-7000-8000-0000000000c1",
  kind: "account",
  subjectType: "account_action",
  subjectId,
  body: "This strike was a mistake.",
  status: "open",
  resolution: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  resolvedAt: null,
  ...over,
});

describe("account action rules", () => {
  it("allows an appeal only while the action is in effect and no appeal of it is open", () => {
    expect(mayAppealAccountAction(strike, [])).toBe(true);
    expect(mayAppealAccountAction(reversed, [])).toBe(false);
    expect(mayAppealAccountAction(strike, [appealOf(strike.id)])).toBe(false);
    expect(mayAppealAccountAction(strike, [appealOf(strike.id, { status: "upheld" })])).toBe(true);
    expect(hasOpenAccountAppeal(strike, [appealOf(strike.id, { subjectType: "moderation_action" })])).toBe(false);
  });

  it("describes what overturning does for moderation and account actions only", () => {
    expect(overturnEffect("moderation_action", "ban")).toBe("liftsBan");
    expect(overturnEffect("moderation_action", "timeout")).toBe("liftsBan");
    expect(overturnEffect("moderation_action", "suspend_user")).toBe("liftsSuspension");
    expect(overturnEffect("moderation_action", "suspend_channel")).toBe("liftsSuspension");
    expect(overturnEffect("moderation_action", "warn")).toBe("recordsOnly");
    expect(overturnEffect("moderation_action", "delete_message")).toBe("recordsOnly");
    expect(overturnEffect("moderation_action")).toBe("moderationAction");
    expect(overturnEffect("account_action", "dmca_strike")).toBe("reversesStrike");
    expect(overturnEffect("account_action", "dmca_termination")).toBe("reversesTermination");
    expect(overturnEffect("account_action")).toBe("accountAction");
    expect(overturnEffect("content_label")).toBeNull();
    expect(overturnEffect("session")).toBeNull();
    expect(overturnEffectLabel("liftsBan")).toBe(en["appeals.account.effect.liftsBan"]);
  });

  it("names every appeal subject, with a fallback for an unknown one", () => {
    expect(appealSubjectLabel("account_action")).toBe(en["appeals.account.subject.account_action"]);
    expect(appealSubjectLabel("content_label")).toBe(en["safety.appeals.labelSubject"]);
    expect(appealSubjectLabel("something_new")).toBe(en["safety.appeals.otherSubject"]);
  });
});

describe("account actions on /settings/appeals", () => {
  it("lists actions with their selector attributes and appeal buttons", () => {
    wrap(
      <AccountActionList
        actions={[termination, strike, reversed]}
        appeals={[appealOf(termination.id)]}
        onAppeal={vi.fn<(a: AccountActionDto, body: string) => Promise<void>>()}
      />,
    );
    const rows = screen.getAllByTestId("account-action");
    expect(rows.map((r) => [r.dataset.actionId, r.dataset.action, r.dataset.reversed])).toEqual([
      [termination.id, "dmca_termination", "false"],
      [strike.id, "dmca_strike", "false"],
      [reversed.id, "dmca_strike", "true"],
    ]);
    // Pending appeal: the button is there but disabled; a reversed action has none.
    const pending = within(rows[0]!).getByTestId("account-action-appeal-open");
    expect(pending.hasAttribute("disabled") || pending.getAttribute("aria-disabled") === "true").toBe(true);
    expect(within(rows[2]!).queryByTestId("account-action-appeal-open")).toBeNull();
    expect(rows[2]!.textContent).toContain(en["appeals.account.reversal.counter_notice_restored"]);
  });

  it("opens the appeal dialog and sends a 10–5000 character body", async () => {
    const onAppeal = vi.fn<(a: AccountActionDto, body: string) => Promise<void>>(async () => {});
    wrap(<AccountActionList actions={[strike]} appeals={[]} onAppeal={onAppeal} />);
    fireEvent.click(screen.getByTestId("account-action-appeal-open"));
    const dialog = await screen.findByTestId("account-appeal-dialog");
    const submit = within(dialog).getByTestId("account-appeal-submit");
    fireEvent.change(within(dialog).getByTestId("account-appeal-body"), { target: { value: "too short" } });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByTestId("account-appeal-body"), {
      target: { value: "  The notice named someone else's video.  " },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(onAppeal).toHaveBeenCalledWith(strike, "The notice named someone else's video."));
    await waitFor(() => expect(screen.queryByTestId("account-appeal-dialog")).toBeNull());
  });

  it("shows an empty state without actions", () => {
    wrap(
      <AccountActionList
        actions={[]}
        appeals={[]}
        onAppeal={vi.fn<(a: AccountActionDto, body: string) => Promise<void>>()}
      />,
    );
    expect(screen.queryByTestId("account-action")).toBeNull();
    expect(screen.getByText(en["appeals.account.empty"])).toBeTruthy();
  });

  it("MyAppeals: a filed account appeal joins the list as an appeal-row with data-kind", async () => {
    const labelAppeal = appealOf("0192f000-0000-7000-8000-0000000000d1", {
      id: "0192f000-0000-7000-8000-0000000000c9",
      kind: "moderation",
      subjectType: "content_label",
      status: "upheld",
    });
    const client: AppealsClient = {
      labels: vi.fn<AppealsClient["labels"]>(async () => []),
      mine: vi.fn<AppealsClient["mine"]>(async () => [labelAppeal]),
      appealLabel: vi.fn<AppealsClient["appealLabel"]>(),
    };
    const appeal = vi.fn<AccountActionsClient["appeal"]>(async (id, body) => appealOf(id, { body }));
    const accountClient: AccountActionsClient = {
      list: vi.fn<AccountActionsClient["list"]>(async () => [strike]),
      appeal,
    };
    wrap(<MyAppeals client={client} accountClient={accountClient} />);
    const row = await screen.findByTestId("account-action");
    expect(row.dataset.actionId).toBe(strike.id);
    expect(screen.getAllByTestId("appeal-row").map((r) => r.dataset.kind)).toEqual(["moderation"]);
    fireEvent.click(screen.getByTestId("account-action-appeal-open"));
    const dialog = await screen.findByTestId("account-appeal-dialog");
    fireEvent.change(within(dialog).getByTestId("account-appeal-body"), {
      target: { value: "This strike is about a video I own." },
    });
    fireEvent.click(within(dialog).getByTestId("account-appeal-submit"));
    await waitFor(() => expect(screen.getAllByTestId("appeal-row")).toHaveLength(2));
    expect(appeal).toHaveBeenCalledWith(strike.id, "This strike is about a video I own.");
    const rows = screen.getAllByTestId("appeal-row");
    expect(rows[0]!.dataset).toMatchObject({ kind: "account", subjectType: "account_action", status: "open" });
    const button = screen.getByTestId("account-action-appeal-open");
    expect(button.textContent).toBe(en["appeals.account.appealPending"]);
  });

  it("MyAppeals: a failed account-action load says so and keeps the appeals", async () => {
    const client: AppealsClient = {
      labels: vi.fn<AppealsClient["labels"]>(async () => []),
      mine: vi.fn<AppealsClient["mine"]>(async () => []),
      appealLabel: vi.fn<AppealsClient["appealLabel"]>(),
    };
    const accountClient: AccountActionsClient = {
      list: vi.fn<AccountActionsClient["list"]>(async () => {
        throw new Error("down");
      }),
      appeal: vi.fn<AccountActionsClient["appeal"]>(),
    };
    wrap(<MyAppeals client={client} accountClient={accountClient} />);
    expect(await screen.findByText(en["appeals.account.loadFailed"])).toBeTruthy();
    expect(screen.getByTestId("appeals-empty")).toBeTruthy();
  });
});

describe("appeal queue on /admin/appeals", () => {
  it("shows the kind and what overturning will do", () => {
    wrap(
      <AppealQueueList
        appeals={[
          appealOf(strike.id),
          appealOf("0192f000-0000-7000-8000-0000000000e1", {
            id: "0192f000-0000-7000-8000-0000000000c2",
            kind: "moderation",
            subjectType: "moderation_action",
          }),
          appealOf("0192f000-0000-7000-8000-0000000000e2", {
            id: "0192f000-0000-7000-8000-0000000000c3",
            kind: "moderation",
            subjectType: "content_label",
          }),
        ]}
        onResolve={vi.fn<(a: AppealDto, s: "upheld" | "overturned", r: string) => Promise<void>>()}
      />,
    );
    const items = screen.getAllByTestId("appealq-item");
    expect(items.map((i) => i.dataset.kind)).toEqual(["account", "moderation", "moderation"]);
    expect(items[0]!.textContent).toContain(en["appeals.account.effect.accountAction"]);
    expect(items[0]!.textContent).toContain(en["appeals.account.kind.account"]);
    expect(items[1]!.textContent).toContain(en["appeals.account.effect.moderationAction"]);
    expect(items[2]!.querySelector("[data-effect]")).toBeNull();
  });
});
