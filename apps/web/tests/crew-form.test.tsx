// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `/crew` in the web: the propose form (rows, basis, the preview, the optional window on the shared
 * date-time field, submit and its errors), a split version (answering, ending, its window and
 * shares), the list's empty state and the "offered to you" section.
 *
 * The preview while the instance's cut is still loading: CI run 41345495956 read "0" for the
 * recipient because the page priced the example with a placeholder share of 0 until
 * `money.support` answered.
 */
import { LocaleProvider, TooltipProvider, formatHour } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CrewListSkeleton,
  CrewOffered,
  CrewPayoutNote,
  CrewProposeForm,
  CrewSplitItem,
  CrewSplitList,
  bpsPercent,
  type ProposeInput,
  type SplitDto,
} from "../src/components/money/crew.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string, options?: unknown) => void>(),
}));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});
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

const NOW = new Date(2026, 10, 4, 12, 0).getTime();

function form(streamerShare: number | null, onPropose: (input: ProposeInput) => Promise<void> = async () => {}) {
  return wrap(<CrewProposeForm currency="USD" streamerShare={streamerShare} onPropose={onPropose} now={NOW} />);
}

function fill(username: string, bps: string, row = 0) {
  fireEvent.change(screen.getAllByTestId("crew-recipient")[row] as HTMLElement, { target: { value: username } });
  fireEvent.change(screen.getAllByTestId("crew-bps")[row] as HTMLElement, { target: { value: bps } });
}

const preview = () => screen.getByTestId("crew-preview");
const submit = () => screen.getByTestId("crew-propose-submit") as HTMLButtonElement;
const addRow = () => fireEvent.click(screen.getByRole("button", { name: t("splits.addRecipient") }));
const removeButtons = () => screen.queryAllByRole("button", { name: t("splits.removeRecipient") });

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByTestId("crew-propose-form"));
  });
}

async function pick(trigger: string, name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(trigger));
  const item = await screen.findByRole("option", { name });
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

describe("CrewProposeForm preview", () => {
  it("does not price the example until the instance's cut is known, and can still be proposed", () => {
    form(null);
    fill("crewmate", "2000");
    expect(preview().getAttribute("data-recipient-cents")).toBe("");
    expect(preview().textContent).toContain(t("splits.preview.loading"));
    expect(submit().disabled).toBe(false);
  });

  it("prices the example once the cut is known", () => {
    form(0.9);
    fill("crewmate", "2000");
    expect(preview().getAttribute("data-recipient-cents")).toBe("180");
    expect(preview().textContent).toContain(t("splits.preview.recipient", { username: "crewmate", amount: "$1.80" }));
    expect(preview().textContent).toContain(t("splits.preview.owner", { amount: "$7.20" }));
    expect(submit().disabled).toBe(false);
  });

  it("explains an incomplete split whether or not the cut is known", () => {
    for (const share of [null, 0.9]) {
      form(share);
      fill("", "2000");
      expect(preview().getAttribute("data-recipient-cents")).toBe("");
      expect(preview().textContent).toContain(t("splits.preview.invalid"));
      expect(submit().disabled).toBe(true);
      cleanup();
    }
  });

  it("says when the crew's shares leave the owner nothing", () => {
    form(0.9);
    fill("one", "5000");
    addRow();
    fill("two", "5000", 1);
    expect(preview().textContent).toContain(t("splits.preview.tooMuch"));
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(t("splits.bpsHint", { percent: bpsPercent(10_000, locale) }))).toBeTruthy();
  });

  it("refuses the same recipient twice, whatever the case", () => {
    form(0.9);
    fill("crewmate", "1000");
    addRow();
    fill("CrewMate", "1000", 1);
    expect(submit().disabled).toBe(true);
    fill("other", "1000", 1);
    expect(submit().disabled).toBe(false);
  });
});

describe("CrewProposeForm rows and basis", () => {
  it("adds rows up to the recipient cap and removes any row but the last", () => {
    form(0.9);
    expect(removeButtons()).toHaveLength(0);
    addRow();
    expect(screen.getAllByTestId("crew-recipient")).toHaveLength(2);
    expect(removeButtons()).toHaveLength(2);
    fill("first", "100", 0);
    fill("second", "200", 1);
    fireEvent.click(removeButtons()[0] as HTMLElement);
    expect(screen.getAllByTestId("crew-recipient")).toHaveLength(1);
    expect((screen.getByTestId("crew-recipient") as HTMLInputElement).value).toBe("second");
    expect(removeButtons()).toHaveLength(0);
    for (let i = 1; i < 10; i++) addRow();
    expect(screen.getAllByTestId("crew-recipient")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: t("splits.addRecipient") })).toBeNull();
  });

  it("sums the typed shares in the hint", () => {
    form(0.9);
    fill("one", "1250");
    addRow();
    fill("two", "abc", 1);
    // An unparseable share leaves the split incomplete: nothing is summed yet.
    expect(screen.getByText(t("splits.bpsHint", { percent: bpsPercent(0, locale) }))).toBeTruthy();
    fill("two", "250", 1);
    expect(screen.getByText(t("splits.bpsHint", { percent: bpsPercent(1500, locale) }))).toBeTruthy();
  });

  it("proposes on the chosen basis", async () => {
    const onPropose = vi.fn<(input: ProposeInput) => Promise<void>>(async () => undefined);
    form(0.9, onPropose);
    expect(screen.getByTestId("crew-basis").getAttribute("data-value")).toBe("tips");
    fireEvent.click(screen.getByTestId("crew-basis"));
    const subs = await screen.findByTestId("crew-basis-subs");
    fireEvent.pointerDown(subs, { pointerType: "mouse" });
    fireEvent.click(subs);
    await waitFor(() => expect(screen.getByTestId("crew-basis").getAttribute("data-value")).toBe("subs"));
    expect(screen.getByTestId("crew-basis").textContent).toContain(t("splits.basis.subs"));
    fill("crewmate", "2000");
    await send();
    expect(onPropose).toHaveBeenCalledWith({ basis: "subs", shares: [{ username: "crewmate", bps: 2000 }] });
  });
});

describe("CrewProposeForm submit", () => {
  it("proposes trimmed shares with no window, then resets and says so", async () => {
    const onPropose = vi.fn<(input: ProposeInput) => Promise<void>>(async () => undefined);
    form(0.9, onPropose);
    fill("  crewmate  ", " 2000 ");
    await send();
    expect(onPropose).toHaveBeenCalledWith({ basis: "tips", shares: [{ username: "crewmate", bps: 2000 }] });
    expect(toasts.success).toHaveBeenCalledWith(t("splits.propose.done"));
    expect((screen.getByTestId("crew-recipient") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("crew-bps") as HTMLInputElement).value).toBe("");
  });

  it("does nothing for an incomplete split", async () => {
    const onPropose = vi.fn<(input: ProposeInput) => Promise<void>>(async () => undefined);
    form(0.9, onPropose);
    fill("crewmate", "");
    await send();
    expect(onPropose).not.toHaveBeenCalled();
  });

  it("sends a whole window as ISO instants in the viewer's time", async () => {
    const onPropose = vi.fn<(input: ProposeInput) => Promise<void>>(async () => undefined);
    form(0.9, onPropose);
    fill("crewmate", "2000");
    await pick("crew-starts-year", "2027");
    await pick("crew-starts-month", "January");
    await pick("crew-starts-day", "2");
    await pick("crew-starts-hour", formatHour(9, locale));
    await pick("crew-starts-minute", "15");
    await pick("crew-ends-year", "2027");
    await pick("crew-ends-month", "February");
    await pick("crew-ends-day", "1");
    await send();
    expect(onPropose).toHaveBeenCalledWith({
      basis: "tips",
      shares: [{ username: "crewmate", bps: 2000 }],
      startsAt: new Date(2027, 0, 2, 9, 15).toISOString(),
      endsAt: new Date(2027, 1, 1, 0, 0).toISOString(),
    });
    // The window is emptied with the rows.
    expect(screen.getByTestId("crew-starts").getAttribute("data-value")).toBe("");
    expect(screen.queryByTestId("crew-starts-clear")).toBeNull();
  });

  it("shows an incomplete window's error only after blur or submit, and blocks submitting", async () => {
    const onPropose = vi.fn<(input: ProposeInput) => Promise<void>>(async () => undefined);
    form(0.9, onPropose);
    fill("crewmate", "2000");
    await pick("crew-starts-day", "3");
    // Choosing within the field is not a blur: no error yet.
    expect(screen.queryByText(t("studio.dateTime.incomplete"))).toBeNull();
    fireEvent.focusOut(screen.getByTestId("crew-starts-day"), { relatedTarget: submit() });
    expect(screen.getAllByText(t("studio.dateTime.incomplete"))).toHaveLength(1);
    await pick("crew-ends-month", "March");
    fireEvent.focusOut(screen.getByTestId("crew-ends-month"), { relatedTarget: null });
    expect(screen.getAllByText(t("studio.dateTime.incomplete"))).toHaveLength(2);
    await send();
    expect(screen.getAllByText(t("studio.dateTime.incomplete"))).toHaveLength(2);
    expect(onPropose).not.toHaveBeenCalled();
    // Clearing an optional window removes its error.
    fireEvent.click(screen.getByTestId("crew-starts-clear"));
    fireEvent.click(screen.getByTestId("crew-ends-clear"));
    expect(screen.queryByText(t("studio.dateTime.incomplete"))).toBeNull();
    await send();
    expect(onPropose).toHaveBeenCalledTimes(1);
  });

  it("shows an untouched incomplete window's error once the form is submitted", async () => {
    const onPropose = vi.fn<(input: ProposeInput) => Promise<void>>(async () => undefined);
    form(0.9, onPropose);
    fill("crewmate", "2000");
    await pick("crew-ends-year", "2028");
    expect(screen.queryByText(t("studio.dateTime.incomplete"))).toBeNull();
    await send();
    expect(screen.getAllByText(t("studio.dateTime.incomplete"))).toHaveLength(1);
    expect(onPropose).not.toHaveBeenCalled();
  });

  it("explains a recipient requirement the server refused", async () => {
    for (const [requirement, key] of [
      ["split_recipient_account_age", "splits.error.accountAge"],
      ["split_recipient_payout_account", "splits.error.payoutAccount"],
      ["split_owner_is_crew", "splits.error.ownerIsCrew"],
    ] as const) {
      form(0.9, async () => {
        throw Object.assign(new Error("refused"), { code: "BAD_REQUEST", data: { requirement } });
      });
      fill("crewmate", "2000");
      await send();
      expect(screen.getByTestId("form-error").textContent).toBe(t(key));
      // The rows stay for a correction.
      expect((screen.getByTestId("crew-recipient") as HTMLInputElement).value).toBe("crewmate");
      cleanup();
    }
  });

  it("maps not found, conflict and anything else to their messages", async () => {
    for (const [err, key] of [
      [{ code: "NOT_FOUND" }, "splits.error.notFound"],
      [{ code: "CONFLICT" }, "splits.error.conflict"],
      [{ code: "BAD_REQUEST", data: { requirement: "unknown_rule" } }, "splits.propose.failed"],
      [null, "splits.propose.failed"],
    ] as const) {
      form(0.9, async () => {
        throw err;
      });
      fill("crewmate", "2000");
      await send();
      expect(screen.getByTestId("form-error").textContent).toBe(t(key));
      expect(toasts.success).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("toasts an expired session instead of an inline error", async () => {
    form(0.9, async () => {
      throw { code: "UNAUTHORIZED" };
    });
    fill("crewmate", "2000");
    await send();
    expect(toasts.error).toHaveBeenCalledWith(t("auth.sessionExpired"), expect.anything());
    expect(screen.queryByTestId("form-error")).toBeNull();
  });

  it("clears the last error on the next attempt", async () => {
    const onPropose = vi
      .fn<(input: ProposeInput) => Promise<void>>()
      .mockRejectedValueOnce({ code: "CONFLICT" })
      .mockResolvedValueOnce(undefined);
    form(0.9, onPropose);
    fill("crewmate", "2000");
    await send();
    expect(screen.getByTestId("form-error")).toBeTruthy();
    await send();
    expect(screen.queryByTestId("form-error")).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith(t("splits.propose.done"));
  });
});

// ── A version ────────────────────────────────────────────────────────────────────────────────

const ME = "0192f000-0000-7000-8000-0000000000aa";
const OTHER = "0192f000-0000-7000-8000-0000000000bb";

const split = (over: Partial<SplitDto> = {}): SplitDto => ({
  id: "0192f000-0000-7000-8000-000000000001",
  channelSlug: "rivertide",
  version: 2,
  status: "proposed",
  basis: "tips",
  startsAt: "2026-11-01T00:00:00.000Z",
  endsAt: null,
  shares: [
    { recipient: { id: ME, username: "me", displayName: "Me" }, bps: 1250, decision: null, decidedAt: null },
    {
      recipient: { id: OTHER, username: "other", displayName: "Other" },
      bps: 500,
      decision: "accepted",
      decidedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  createdAt: "2026-11-01T00:00:00.000Z",
  acceptedAt: null,
  endedAt: null,
  awaitingYou: true,
  ...over,
});

function item(s: SplitDto, over: Partial<React.ComponentProps<typeof CrewSplitItem>> = {}) {
  const props = {
    split: s,
    meId: ME,
    canEnd: false,
    onAnswer: vi.fn<(id: string, accept: boolean) => Promise<void>>(async () => undefined),
    onEnd: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    ...over,
  };
  wrap(<CrewSplitItem {...props} />);
  return props;
}

describe("bpsPercent", () => {
  it("formats basis points as a locale percent", () => {
    expect(bpsPercent(1250, "en")).toBe("12.5%");
    expect(bpsPercent(1, "en")).toBe("0.01%");
    expect(bpsPercent(10_000, "en")).toBe("100%");
  });
});

describe("CrewSplitItem", () => {
  it("shows the version, its status, basis, open-ended window and each share's answer", () => {
    item(split());
    const row = screen.getByTestId("crew-split");
    expect(row.getAttribute("data-version")).toBe("2");
    expect(row.getAttribute("data-status")).toBe("proposed");
    expect(row.getAttribute("data-basis")).toBe("tips");
    expect(row.textContent).toContain(t("splits.version", { version: 2, channel: "rivertide" }));
    expect(row.textContent).toContain(t("splits.status.proposed"));
    expect(row.textContent).toContain(t("splits.basis.tips"));
    expect(row.textContent).not.toContain(t("splits.until"));
    expect(row.textContent).not.toContain(t("splits.acceptedAt"));
    const [mine, theirs] = screen.getAllByTestId("crew-share");
    expect(mine?.getAttribute("data-accepted")).toBe("false");
    expect(mine?.textContent).toContain(t("splits.share", { username: "me", percent: "12.5%" }));
    expect(mine?.textContent).toContain(t("splits.decision.pending"));
    expect(theirs?.getAttribute("data-accepted")).toBe("true");
    expect(theirs?.textContent).toContain(t("splits.decision.accepted"));
  });

  it("shows an end date, a refusal and when it was accepted", () => {
    item(
      split({
        status: "accepted",
        basis: "all",
        endsAt: "2027-01-01T00:00:00.000Z",
        acceptedAt: "2026-11-02T00:00:00.000Z",
        shares: [
          {
            recipient: { id: OTHER, username: "other", displayName: "Other" },
            bps: 500,
            decision: "rejected",
            decidedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const row = screen.getByTestId("crew-split");
    expect(row.textContent).toContain(t("splits.until"));
    expect(row.textContent).toContain(t("splits.acceptedAt"));
    expect(row.textContent).toContain(t("splits.basis.all"));
    expect(row.textContent).toContain(t("splits.status.accepted"));
    expect(screen.getByTestId("crew-share").textContent).toContain(t("splits.decision.rejected"));
  });

  it("labels every status", () => {
    for (const status of ["ended", "rejected"] as const) {
      item(split({ status }));
      expect(screen.getByTestId("crew-split").textContent).toContain(t(`splits.status.${status}`));
      cleanup();
    }
  });

  it("lets a recipient answer only their own undecided share of a proposal", () => {
    item(split({ shares: split().shares.slice(1) }));
    expect(screen.queryByTestId("crew-accept")).toBeNull();
    cleanup();
    item(split({ status: "accepted" }));
    expect(screen.queryByTestId("crew-accept")).toBeNull();
    cleanup();
    item(split(), { meId: OTHER });
    expect(screen.queryByTestId("crew-accept")).toBeNull();
    cleanup();
    item(split());
    expect(screen.getByTestId("crew-accept")).toBeTruthy();
    expect(screen.getByTestId("crew-reject")).toBeTruthy();
  });

  it("accepts and refuses", async () => {
    const props = item(split());
    await act(async () => {
      fireEvent.click(screen.getByTestId("crew-accept"));
    });
    expect(props.onAnswer).toHaveBeenLastCalledWith(split().id, true);
    expect(toasts.success).toHaveBeenLastCalledWith(t("splits.accept.done"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("crew-reject"));
    });
    expect(props.onAnswer).toHaveBeenLastCalledWith(split().id, false);
    expect(toasts.success).toHaveBeenLastCalledWith(t("splits.reject.done"));
  });

  it("disables both answers while one is in flight", async () => {
    item(split(), { onAnswer: () => new Promise<void>(() => undefined) });
    await act(async () => {
      fireEvent.click(screen.getByTestId("crew-accept"));
    });
    expect((screen.getByTestId("crew-accept") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("crew-reject") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toasts a failed answer, or a sign-in prompt for an expired session", async () => {
    item(split(), {
      onAnswer: async () => {
        throw { code: "CONFLICT" };
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("crew-accept"));
    });
    expect(toasts.error).toHaveBeenLastCalledWith(t("splits.error.conflict"));
    expect((screen.getByTestId("crew-accept") as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    item(split(), {
      onAnswer: async () => {
        throw { code: "UNAUTHORIZED" };
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("crew-reject"));
    });
    expect(toasts.error).toHaveBeenLastCalledWith(t("auth.sessionExpired"), expect.anything());
  });

  it("offers End only to the owner, on a proposed or accepted version", () => {
    item(split({ status: "accepted" }));
    expect(screen.queryByTestId("crew-end")).toBeNull();
    cleanup();
    for (const status of ["ended", "rejected"] as const) {
      item(split({ status }), { canEnd: true });
      expect(screen.queryByTestId("crew-end")).toBeNull();
      cleanup();
    }
    for (const status of ["proposed", "accepted"] as const) {
      item(split({ status }), { canEnd: true });
      expect(screen.getByTestId("crew-end")).toBeTruthy();
      cleanup();
    }
  });

  it("ends a version after confirmation", async () => {
    const props = item(split({ status: "accepted" }), { canEnd: true });
    fireEvent.click(screen.getByTestId("crew-end"));
    const dialog = await screen.findByTestId("crew-end-confirm");
    expect(dialog.textContent).toContain(t("splits.end.title", { version: 2 }));
    expect(props.onEnd).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });
    expect(props.onEnd).toHaveBeenCalledWith(split().id);
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(t("splits.end.done")));
  });

  it("toasts a failed end, or a sign-in prompt for an expired session", async () => {
    for (const [err, expected] of [
      [{ code: "NOT_FOUND" }, [t("splits.error.notFound")]],
      [{ code: "UNAUTHORIZED" }, [t("auth.sessionExpired"), expect.anything()]],
    ] as const) {
      item(split({ status: "accepted" }), {
        canEnd: true,
        onEnd: async () => {
          throw err;
        },
      });
      fireEvent.click(screen.getByTestId("crew-end"));
      const confirm = await screen.findByTestId("confirm-dialog-confirm");
      await act(async () => {
        fireEvent.click(confirm);
      });
      await waitFor(() => expect(toasts.error).toHaveBeenLastCalledWith(...expected));
      expect(toasts.success).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("CrewSplitList", () => {
  const noop = async () => undefined;
  it("shows its empty state with the owner's action", () => {
    wrap(
      <CrewSplitList
        splits={[]}
        meId={ME}
        canEnd
        empty={{ title: "splits.offered.empty", hint: "splits.offered.emptyHint", action: <button>Propose</button> }}
        onAnswer={noop}
        onEnd={noop}
      />,
    );
    const empty = screen.getByTestId("crew-empty");
    expect(empty.textContent).toContain(t("splits.offered.empty"));
    expect(empty.textContent).toContain(t("splits.offered.emptyHint"));
    expect(screen.getByRole("button", { name: "Propose" })).toBeTruthy();
  });

  it("lists every version", () => {
    wrap(
      <CrewSplitList
        splits={[split(), split({ id: "0192f000-0000-7000-8000-000000000002", version: 1, status: "ended" })]}
        meId={ME}
        canEnd
        empty={{ title: "splits.offered.empty", hint: "splits.offered.emptyHint" }}
        onAnswer={noop}
        onEnd={noop}
      />,
    );
    expect(screen.getAllByTestId("crew-split").map((r) => r.getAttribute("data-version"))).toEqual(["2", "1"]);
    expect(screen.getAllByTestId("crew-end")).toHaveLength(1);
  });
});

describe("CrewOffered", () => {
  it("counts the splits waiting for the viewer's answer", () => {
    const onAnswer = vi.fn<(id: string, accept: boolean) => Promise<void>>(async () => undefined);
    wrap(
      <CrewOffered
        splits={[split(), split({ id: "0192f000-0000-7000-8000-000000000002", awaitingYou: true })]}
        meId={ME}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByText(t("splits.offered.waiting", { count: 2 }))).toBeTruthy();
    // A recipient never ends a split.
    expect(screen.queryByTestId("crew-end")).toBeNull();
  });

  it("explains the section when nothing is waiting, and shows its empty state", () => {
    wrap(<CrewOffered splits={[]} meId={ME} onAnswer={async () => undefined} />);
    expect(screen.getByText(t("splits.offered.hint"))).toBeTruthy();
    expect(screen.getByTestId("crew-empty").textContent).toContain(t("splits.offered.empty"));
  });
});

describe("crew notes and loading", () => {
  it("explains how crew are paid, and announces loading", () => {
    wrap(
      <>
        <CrewPayoutNote />
        <CrewListSkeleton />
      </>,
    );
    expect(screen.getByTestId("crew-payout-note").textContent).toContain(t("splits.payoutNote"));
    expect(screen.getByText(t("splits.loading"))).toBeTruthy();
  });
});
