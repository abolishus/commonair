// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E7 appeals on the web: account actions on /settings/appeals and the overturn effect on /admin/appeals. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppealQueue, AppealQueueList, RESOLUTION_MAX } from "../src/components/safety/appeal-queue.tsx";
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
  AppealQueueClient,
  AppealsClient,
} from "../src/components/safety/client.ts";
import { appealSubjectLabel, overturnEffect, overturnEffectLabel } from "../src/components/safety/labels.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({ success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));

afterEach(() => {
  cleanup();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

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
  exclusionCategory: null,
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
    // Only unreversed actions without an open appeal carry the control (e7-selectors).
    expect(within(rows[0]!).queryByTestId("account-action-appeal-open")).toBeNull();
    expect(rows[0]!.textContent).toContain(en["appeals.account.appealPending"]);
    expect(within(rows[1]!).getByTestId("account-action-appeal-open")).toBeTruthy();
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
    expect(screen.queryByTestId("account-action-appeal-open")).toBeNull();
    expect(screen.getByTestId("account-action").textContent).toContain(en["appeals.account.appealPending"]);
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
  const second = "0192f000-0000-7000-8000-0000000000c2";
  const queue = (): AppealDto[] => [
    appealOf(strike.id),
    appealOf("0192f000-0000-7000-8000-0000000000e1", {
      id: second,
      kind: "moderation",
      subjectType: "moderation_action",
      body: "The stream was not what the report said.",
    }),
    appealOf("0192f000-0000-7000-8000-0000000000e2", {
      id: "0192f000-0000-7000-8000-0000000000c3",
      kind: "moderation",
      subjectType: "content_label",
    }),
  ];
  const items = () => screen.getAllByTestId("appealq-item");
  const toggle = (item: HTMLElement) => within(item).getByTestId("appealq-item-toggle");

  it("shows each appeal as a closed row of its key facts, with no form", () => {
    wrap(<AppealQueueList appeals={queue()} onResolve={vi.fn<AppealResolve>()} />);
    expect(items().map((i) => [i.dataset.kind, i.dataset.status, i.dataset.open])).toEqual([
      ["account", "open", "false"],
      ["moderation", "open", "false"],
      ["moderation", "open", "false"],
    ]);
    const row = items()[0]!;
    expect(row.textContent).toContain(appealSubjectLabel("account_action"));
    expect(row.textContent).toContain(en["appeals.account.kind.account"]);
    expect(row.textContent).toContain("This strike was a mistake.");
    expect(toggle(row).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("appealq-detail")).toBeNull();
    expect(screen.queryByTestId("appealq-resolution")).toBeNull();
    expect(screen.queryByTestId("appealq-submit")).toBeNull();
  });

  it("opening a row shows the kind and what overturning will do", () => {
    wrap(<AppealQueueList appeals={queue()} onResolve={vi.fn<AppealResolve>()} />);
    fireEvent.click(toggle(items()[0]!));
    expect(items()[0]!.dataset.open).toBe("true");
    expect(toggle(items()[0]!).getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByTestId("appealq-detail");
    expect(detail.textContent).toContain(en["appeals.account.effect.accountAction"]);
    fireEvent.click(toggle(items()[1]!));
    expect(screen.getByTestId("appealq-detail").textContent).toContain(en["appeals.account.effect.moderationAction"]);
    fireEvent.click(toggle(items()[2]!));
    expect(screen.getByTestId("appealq-detail").querySelector("[data-effect]")).toBeNull();
  });

  it("one row is open at a time, so the page has one form", () => {
    wrap(<AppealQueueList appeals={queue()} onResolve={vi.fn<AppealResolve>()} />);
    fireEvent.click(toggle(items()[0]!));
    fireEvent.click(toggle(items()[1]!));
    expect(items().map((i) => i.dataset.open)).toEqual(["false", "true", "false"]);
    expect(screen.getAllByTestId("appealq-resolution")).toHaveLength(1);
    fireEvent.click(toggle(items()[1]!));
    expect(screen.queryByTestId("appealq-resolution")).toBeNull();
  });

  it("the toggle is a focusable native button that controls the detail", () => {
    wrap(<AppealQueueList appeals={queue()} onResolve={vi.fn<AppealResolve>()} />);
    const button = toggle(items()[0]!);
    // A native button turns Enter and Space into a click, so the keyboard opens the row.
    expect(button.tagName).toBe("BUTTON");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    const detail = screen.getByTestId("appealq-detail");
    expect(button.getAttribute("aria-controls")).toBe(detail.id);
    expect(screen.getByTestId("appealq-resolution")).toBeTruthy();
  });

  it("a draft survives closing the row", () => {
    wrap(<AppealQueueList appeals={queue()} onResolve={vi.fn<AppealResolve>()} />);
    fireEvent.click(toggle(items()[1]!));
    fireEvent.click(screen.getByTestId("appealq-resolve-overturned"));
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "Reversed." } });
    fireEvent.click(toggle(items()[0]!));
    fireEvent.click(toggle(items()[1]!));
    expect((screen.getByTestId("appealq-resolution") as HTMLTextAreaElement).value).toBe("Reversed.");
    expect((screen.getByTestId("appealq-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("resolves from the open row", async () => {
    const onResolve = vi.fn<AppealResolve>(async () => {});
    wrap(<AppealQueueList appeals={queue()} onResolve={onResolve} />);
    fireEvent.click(toggle(items()[1]!));
    const submit = screen.getByTestId("appealq-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("appealq-resolve-upheld"));
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "  The decision stands.  " } });
    fireEvent.click(submit);
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    const [appeal, status, resolution] = onResolve.mock.calls[0]!;
    expect([appeal.id, status, resolution]).toEqual([second, "upheld", "The decision stands."]);
  });

  it("a resolved appeal opens to its text without a form", () => {
    wrap(<AppealQueueList appeals={[appealOf(strike.id, { status: "upheld" })]} onResolve={vi.fn<AppealResolve>()} />);
    fireEvent.click(toggle(items()[0]!));
    expect(screen.getByTestId("appealq-detail").textContent).toContain("This strike was a mistake.");
    expect(screen.queryByTestId("appealq-resolution")).toBeNull();
  });
});

describe("appeal queue: decision form edges", () => {
  const items = () => screen.getAllByTestId("appealq-item");
  const openFirst = () => fireEvent.click(within(items()[0]!).getByTestId("appealq-item-toggle"));
  const submit = () => screen.getByTestId("appealq-submit") as HTMLButtonElement;

  it("a skeleton while loading and an empty state with no appeals", () => {
    const { unmount } = wrap(<AppealQueueList appeals={null} onResolve={vi.fn<AppealResolve>()} />);
    expect(screen.getByText(en["safety.appealq.loading"])).toBeTruthy();
    expect(screen.queryByTestId("appealq-item")).toBeNull();
    unmount();
    wrap(<AppealQueueList appeals={[]} onResolve={vi.fn<AppealResolve>()} />);
    expect(screen.getByText(en["safety.appealq.empty"])).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("needs both a decision and a reply that is not just spaces, capped at the maximum", () => {
    wrap(<AppealQueueList appeals={[appealOf(strike.id)]} onResolve={vi.fn<AppealResolve>()} />);
    openFirst();
    expect((screen.getByTestId("appealq-resolution") as HTMLTextAreaElement).maxLength).toBe(RESOLUTION_MAX);
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("appealq-resolve-overturned"));
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "Reversed." } });
    expect(submit().disabled).toBe(false);
  });

  it("submitting the form without a decision sends nothing", async () => {
    const onResolve = vi.fn<AppealResolve>(async () => {});
    wrap(<AppealQueueList appeals={[appealOf(strike.id)]} onResolve={onResolve} />);
    openFirst();
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "No decision." } });
    // The button is disabled, but Enter in a form can still submit it.
    fireEvent.submit(submit().closest("form")!);
    await Promise.resolve();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("is busy while resolving, confirms, and clears the draft", async () => {
    let finish: () => void = () => {};
    const onResolve = vi.fn<AppealResolve>(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    wrap(<AppealQueueList appeals={[appealOf(strike.id)]} onResolve={onResolve} />);
    openFirst();
    fireEvent.click(screen.getByTestId("appealq-resolve-overturned"));
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "Reversed." } });
    fireEvent.click(submit());
    await waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("true"));
    expect(submit().disabled).toBe(true);
    // A second submit while one is in flight is dropped.
    fireEvent.submit(submit().closest("form")!);
    expect(onResolve).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(en["safety.appealq.resolved"]));
    expect((screen.getByTestId("appealq-resolution") as HTMLTextAreaElement).value).toBe("");
    expect(submit().getAttribute("aria-busy")).toBeNull();
  });

  it("a failed resolve says so and keeps the draft", async () => {
    const onResolve = vi.fn<AppealResolve>(async () => {
      throw new Error("boom");
    });
    wrap(<AppealQueueList appeals={[appealOf(strike.id)]} onResolve={onResolve} />);
    openFirst();
    fireEvent.click(screen.getByTestId("appealq-resolve-upheld"));
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "Stands." } });
    fireEvent.click(submit());
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["safety.appealq.failed"]));
    expect(toasts.success).not.toHaveBeenCalled();
    expect((screen.getByTestId("appealq-resolution") as HTMLTextAreaElement).value).toBe("Stands.");
    expect(submit().disabled).toBe(false);
  });

  it("an expired session asks to sign in again", async () => {
    const onResolve = vi.fn<AppealResolve>(async () => {
      throw Object.assign(new Error("no"), { code: "UNAUTHORIZED" });
    });
    wrap(<AppealQueueList appeals={[appealOf(strike.id)]} onResolve={onResolve} />);
    openFirst();
    fireEvent.click(screen.getByTestId("appealq-resolve-upheld"));
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: "Stands." } });
    fireEvent.click(submit());
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["auth.sessionExpired"], expect.anything()));
  });
});

describe("AppealQueue with its client", () => {
  const page = (items: AppealDto[], nextCursor: string | null = null) => ({ items, nextCursor });
  const fake = (over: Partial<AppealQueueClient> = {}): AppealQueueClient => ({
    queue: vi.fn<AppealQueueClient["queue"]>(async () => page([appealOf(strike.id)])),
    resolve: vi.fn<AppealQueueClient["resolve"]>(async (input) => appealOf(strike.id, { status: input.status })),
    ...over,
  });

  it("shows a skeleton, then the first page of open appeals", async () => {
    let answer: (p: { items: AppealDto[]; nextCursor: string | null }) => void = () => {};
    const queue = vi.fn<AppealQueueClient["queue"]>(
      () =>
        new Promise((r) => {
          answer = r;
        }),
    );
    const client = fake({ queue });
    wrap(<AppealQueue client={client} />);
    expect(screen.getByText(en["safety.appealq.loading"])).toBeTruthy();
    answer(page([appealOf(strike.id)]));
    expect(await screen.findByTestId("appealq-item")).toBeTruthy();
    expect(queue).toHaveBeenCalledWith(undefined);
    // One page only: no "load more".
    expect(screen.queryByText(en["safety.modq.loadMore"])).toBeNull();
  });

  it("a failed load says so and shows the empty list rather than a skeleton", async () => {
    const client = fake({
      queue: vi.fn<AppealQueueClient["queue"]>(async () => {
        throw new Error("down");
      }),
    });
    wrap(<AppealQueue client={client} />);
    expect(await screen.findByText(en["safety.appealq.loadFailed"])).toBeTruthy();
    expect(screen.getByText(en["safety.appealq.empty"])).toBeTruthy();
    expect(screen.queryByText(en["safety.appealq.loading"])).toBeNull();
  });

  it("loads more pages from the cursor and appends them", async () => {
    const second = appealOf(strike.id, { id: "0192f000-0000-7000-8000-0000000000d2", body: "Second page." });
    const queue = vi.fn<AppealQueueClient["queue"]>(async (cursor) =>
      cursor === "c2" ? page([second]) : page([appealOf(strike.id)], "c2"),
    );
    wrap(<AppealQueue client={fake({ queue })} />);
    const more = await screen.findByText(en["safety.modq.loadMore"]);
    fireEvent.click(more);
    await waitFor(() => expect(screen.getAllByTestId("appealq-item")).toHaveLength(2));
    expect(queue).toHaveBeenLastCalledWith("c2");
    expect(screen.queryByText(en["safety.modq.loadMore"])).toBeNull();
  });

  it("a failed next page toasts and keeps the rows", async () => {
    const queue = vi.fn<AppealQueueClient["queue"]>(async (cursor) => {
      if (cursor) throw new Error("down");
      return page([appealOf(strike.id)], "c2");
    });
    wrap(<AppealQueue client={fake({ queue })} />);
    fireEvent.click(await screen.findByText(en["safety.modq.loadMore"]));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["safety.appealq.loadMoreFailed"]));
    expect(screen.getAllByTestId("appealq-item")).toHaveLength(1);
  });

  it("resolving sends the decision and reloads the queue", async () => {
    let open = true;
    const queue = vi.fn<AppealQueueClient["queue"]>(async () => page(open ? [appealOf(strike.id)] : []));
    const resolve = vi.fn<AppealQueueClient["resolve"]>(async (input) => {
      open = false;
      return appealOf(strike.id, { status: input.status });
    });
    wrap(<AppealQueue client={fake({ queue, resolve })} />);
    fireEvent.click(within(await screen.findByTestId("appealq-item")).getByTestId("appealq-item-toggle"));
    fireEvent.click(screen.getByTestId("appealq-resolve-overturned"));
    fireEvent.change(screen.getByTestId("appealq-resolution"), { target: { value: " Reversed. " } });
    fireEvent.click(screen.getByTestId("appealq-submit"));
    await waitFor(() => expect(screen.getByText(en["safety.appealq.empty"])).toBeTruthy());
    expect(resolve).toHaveBeenCalledWith({
      id: "0192f000-0000-7000-8000-0000000000c1",
      status: "overturned",
      resolution: "Reversed.",
    });
    expect(queue).toHaveBeenCalledTimes(2);
    expect(toasts.success).toHaveBeenCalledWith(en["safety.appealq.resolved"]);
  });
});

type AppealResolve = (a: AppealDto, s: "upheld" | "overturned", r: string) => Promise<void>;
