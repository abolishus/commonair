// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E7-dmca web: the notice form (validation, receipt), the counter-notice dialog (every
 * § 512(g)(3) field, the confirmation), the DMCA queue's decision flow, and the selector ids of
 * docs/testing/e7-selectors.md ("DMCA notice", "Your content", "DMCA queue").
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { Dialog, DialogContent } from "@commonair/ui/components/dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  CopyrightClient,
  DmcaNoticeClient,
  DmcaNoticeDto,
  DmcaNoticeForOwnerDto,
  DmcaQueueClient,
} from "../src/components/dmca/client.ts";
import {
  CopyrightNotices,
  CounterForm,
  canCounter,
  counterErrors,
  counterDraftFor,
  counterInput,
} from "../src/components/dmca/copyright.tsx";
import { DmcaQueue, isRepeatInfringer } from "../src/components/dmca/dmca-queue.tsx";
import { DmcaNoticeForm, EMPTY_DMCA_DRAFT, dmcaErrors, dmcaInput } from "../src/components/dmca/notice-form.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";

// The real widget solves a proof of work in a worker; here one click "solves" it.
vi.mock("../src/components/altcha-field.tsx", () => ({
  AltchaField: ({ onChange }: { onChange: (p: string | null) => void }) => (
    <button type="button" data-testid="fake-altcha" onClick={() => onChange("solved-payload")}>
      solve
    </button>
  ),
}));

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const byId = (id: string) => screen.getByTestId(id);
const type = (id: string, value: string) => fireEvent.change(byId(id), { target: { value } });

const NOTICE = "0192f000-0000-7000-8000-000000000001";
const ITEM_A = "0192f000-0000-7000-8000-0000000000a1";
const ITEM_B = "0192f000-0000-7000-8000-0000000000b1";
const OWNER = "0192f000-0000-7000-8000-0000000000e1";
const COUNTER = "0192f000-0000-7000-8000-0000000000c1";
const at = "2026-10-27T10:00:00.000Z";

const ownerNotice = (over: Partial<DmcaNoticeForOwnerDto> = {}): DmcaNoticeForOwnerDto => ({
  id: NOTICE,
  status: "actioned",
  claimantName: "Claire Claimant",
  copyrightedWork: "My song",
  items: [
    {
      id: ITEM_A,
      url: "https://air.example.test/ada/clip/x",
      subjectType: "clip",
      subjectId: "0192f000-0000-7000-8000-0000000000d1",
      ownerId: OWNER,
      removedAt: at,
      restoredAt: null,
    },
    {
      id: ITEM_B,
      url: "https://air.example.test/ada/videos/y",
      subjectType: "vod",
      subjectId: "0192f000-0000-7000-8000-0000000000d2",
      ownerId: OWNER,
      removedAt: at,
      restoredAt: null,
    },
  ],
  counter: null,
  createdAt: at,
  actionedAt: at,
  ...over,
});

const staffNotice = (over: Partial<DmcaNoticeDto> = {}): DmcaNoticeDto => ({
  id: NOTICE,
  status: "received",
  claimantName: "Claire Claimant",
  claimantEmail: "claire@example.test",
  claimantAddress: "1 Rights Road",
  claimantPhone: null,
  copyrightedWork: "My song",
  infringingUrls: ["https://air.example.test/ada/clip/x", "https://elsewhere.example/z"],
  signature: "Claire",
  items: [
    { ...ownerNotice().items[0]!, removedAt: null },
    {
      id: ITEM_B,
      url: "https://elsewhere.example/z",
      subjectType: null,
      subjectId: null,
      ownerId: null,
      removedAt: null,
      restoredAt: null,
    },
  ],
  counters: [],
  ownerStrikes: { [OWNER]: 3 },
  handledBy: null,
  decisionNote: null,
  createdAt: at,
  actionedAt: null,
  ...over,
});

describe("notice form", () => {
  it("validates every statutory element; the phone is optional", () => {
    const errors = dmcaErrors(EMPTY_DMCA_DRAFT);
    expect(Object.keys(errors).sort()).toEqual(
      ["accuracy", "address", "email", "goodFaith", "name", "signature", "urls", "work"].sort(),
    );
    const ok = {
      name: "Claire",
      email: "claire@example.test",
      address: "1 Rights Road",
      phone: "",
      work: "My song",
      urls: "https://air.example.test/a/clip/x\n\nhttps://air.example.test/a/clip/y",
      goodFaith: true,
      accuracy: true,
      signature: "Claire",
    };
    expect(dmcaErrors(ok)).toEqual({});
    expect(dmcaErrors({ ...ok, phone: "12" })).toHaveProperty("phone");
    expect(dmcaErrors({ ...ok, urls: "not a url" })).toHaveProperty("urls");
    expect(
      dmcaErrors({ ...ok, urls: Array.from({ length: 51 }, (_, i) => `https://a.test/${i}`).join("\n") }),
    ).toHaveProperty("urls");
    const input = dmcaInput(ok, "p");
    expect(input).not.toHaveProperty("claimantPhone");
    expect(input.infringingUrls).toHaveLength(2);
    expect(dmcaInput({ ...ok, phone: " +1 555 0100 " }, "p").claimantPhone).toBe("+1 555 0100");
  });

  it("submits once ALTCHA is solved and shows the receipt in place of the form", async () => {
    const submit = vi.fn<DmcaNoticeClient["submit"]>(async () => ({ id: NOTICE }));
    const client: DmcaNoticeClient = { submit, policy: async () => null };
    wrap(<DmcaNoticeForm client={client} />);
    for (const id of [
      "dmca-form",
      "dmca-name",
      "dmca-email",
      "dmca-address",
      "dmca-phone",
      "dmca-work",
      "dmca-urls",
      "dmca-good-faith",
      "dmca-accuracy",
      "dmca-signature",
      "dmca-altcha",
      "dmca-submit",
    ])
      expect(byId(id)).toBeTruthy();
    expect(byId("dmca-altcha").getAttribute("data-state")).toBe("unverified");
    expect((byId("dmca-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(byId("fake-altcha"));
    expect(byId("dmca-altcha").getAttribute("data-state")).toBe("verified");
    // Submitting an empty form shows the errors and sends nothing.
    await act(async () => fireEvent.click(byId("dmca-submit")));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);

    type("dmca-name", "Claire");
    type("dmca-email", "claire@example.test");
    type("dmca-address", "1 Rights Road");
    type("dmca-work", "My song");
    type("dmca-urls", "https://air.example.test/a/clip/x");
    type("dmca-signature", "Claire");
    fireEvent.click(byId("dmca-good-faith"));
    fireEvent.click(byId("dmca-accuracy"));
    await act(async () => fireEvent.click(byId("dmca-submit")));
    await waitFor(() => expect(byId("dmca-receipt").getAttribute("data-notice-id")).toBe(NOTICE));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        claimantName: "Claire",
        infringingUrls: ["https://air.example.test/a/clip/x"],
        goodFaithStatement: true,
        accuracyStatement: true,
        altcha: "solved-payload",
      }),
    );
    expect(screen.queryByTestId("dmca-form")).toBeNull();
  });
});

describe("your content and the counter-notice", () => {
  it("lists notices with their items; empty, loading and failed states", () => {
    const onRetry = vi.fn<() => void>();
    const counter = vi.fn<CopyrightClient["counter"]>(async () => ({ restoreAfter: at }));
    const { rerender } = wrap(<CopyrightNotices notices={[]} failed={false} onRetry={onRetry} onCounter={counter} />);
    expect(byId("copyright-empty")).toBeTruthy();
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <CopyrightNotices notices={null} failed onRetry={onRetry} onCounter={counter} />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalled();
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <CopyrightNotices notices={[ownerNotice()]} failed={false} onRetry={onRetry} onCounter={counter} />
      </LocaleProvider>,
    );
    const n = byId("copyright-notice");
    expect(n.getAttribute("data-notice-id")).toBe(NOTICE);
    expect(n.getAttribute("data-status")).toBe("actioned");
    const items = screen.getAllByTestId("copyright-item");
    expect(items.map((i) => [i.getAttribute("data-item-id"), i.getAttribute("data-removed")])).toEqual([
      [ITEM_A, "true"],
      [ITEM_B, "true"],
    ]);
    expect(items[0]?.getAttribute("data-restored")).toBe("false");
    expect(items[0]?.getAttribute("data-subject-type")).toBe("clip");
    expect(byId("counter-open")).toBeTruthy();
  });

  it("shows the receipt instead of the button once countered", () => {
    const n = ownerNotice({
      status: "countered",
      counter: { id: COUNTER, restoreAfter: "2026-11-12T10:00:00.000Z", restoredAt: null, suitFiledAt: null },
    });
    expect(canCounter(n)).toBe(false);
    wrap(
      <CopyrightNotices
        notices={[n]}
        failed={false}
        onRetry={() => {}}
        onCounter={async () => ({ restoreAfter: at })}
      />,
    );
    const r = byId("counter-receipt");
    expect(r.getAttribute("data-counter-id")).toBe(COUNTER);
    expect(r.getAttribute("data-restore-after")).toBe("2026-11-12T10:00:00.000Z");
    expect(r.getAttribute("data-restored")).toBe("false");
    expect(r.getAttribute("data-suit-filed")).toBe("false");
    expect(screen.queryByTestId("counter-open")).toBeNull();
  });

  it("no counter-notice for restored items or a rejected notice", () => {
    expect(canCounter(ownerNotice({ status: "rejected" }))).toBe(false);
    const restored = ownerNotice();
    restored.items = restored.items.map((i) => ({ ...i, restoredAt: at }));
    expect(canCounter(restored)).toBe(false);
  });

  it("validates the counter-notice: phone, at least one item, both statements, signature", () => {
    const draft = counterDraftFor(ownerNotice());
    expect(draft.itemIds).toEqual([ITEM_A, ITEM_B]);
    expect(Object.keys(counterErrors(draft)).sort()).toEqual(
      ["address", "goodFaith", "jurisdiction", "name", "phone", "signature", "statement"].sort(),
    );
    expect(counterErrors({ ...draft, itemIds: [] })).toHaveProperty("itemIds");
    const ok = {
      ...draft,
      name: "Ada",
      address: "2 Lane",
      phone: "+1 555 0200",
      statement: "mistake",
      goodFaith: true,
      jurisdiction: true,
      signature: "Ada",
    };
    expect(counterErrors(ok)).toEqual({});
    expect(counterInput(NOTICE, ok)).toEqual({
      id: NOTICE,
      fullName: "Ada",
      address: "2 Lane",
      phone: "+1 555 0200",
      itemIds: [ITEM_A, ITEM_B],
      statement: "mistake",
      goodFaithStatement: true,
      consentToJurisdiction: true,
      signature: "Ada",
    });
  });

  it("the dialog has every field, items checked by default, and confirms before sending", async () => {
    const onSubmit = vi.fn<CopyrightClient["counter"]>(async () => ({ restoreAfter: at }));
    wrap(
      <Dialog open>
        <DialogContent>
          <CounterForm notice={ownerNotice()} onSubmit={onSubmit} />
        </DialogContent>
      </Dialog>,
    );
    for (const id of [
      "counter-form",
      "counter-name",
      "counter-address",
      "counter-phone",
      `counter-item-${ITEM_A}`,
      `counter-item-${ITEM_B}`,
      "counter-statement",
      "counter-good-faith",
      "counter-jurisdiction",
      "counter-signature",
      "counter-submit",
    ])
      expect(byId(id), id).toBeTruthy();
    expect(byId(`counter-item-${ITEM_A}`).getAttribute("aria-checked")).toBe("true");
    // Uncheck one item: it is left out.
    fireEvent.click(byId(`counter-item-${ITEM_B}`));
    type("counter-name", "Ada");
    type("counter-address", "2 Lane");
    type("counter-phone", "+1 555 0200");
    type("counter-statement", "mistake");
    type("counter-signature", "Ada");
    fireEvent.click(byId("counter-good-faith"));
    fireEvent.click(byId("counter-jurisdiction"));
    fireEvent.click(byId("counter-submit"));
    const confirm = await screen.findByTestId("confirm-dialog-confirm");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/name, address and telephone number/)).toBeTruthy();
    await act(async () => fireEvent.click(confirm));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ itemIds: [ITEM_A], fullName: "Ada" }));
  });
});

describe("DMCA queue", () => {
  function queueClient(notices: DmcaNoticeDto[]) {
    const action = vi.fn<DmcaQueueClient["action"]>(async (input) =>
      staffNotice({ status: input.decision, decisionNote: input.note }),
    );
    const suitFiled = vi.fn<DmcaQueueClient["suitFiled"]>(async () => staffNotice());
    const queue = vi.fn<DmcaQueueClient["queue"]>(async () => ({ items: notices, nextCursor: null }));
    const client: DmcaQueueClient = { queue, action, suitFiled };
    return { client, action, suitFiled, queue };
  }

  it("filters by status, opens a notice, shows items and strikes, and actions it after confirmation", async () => {
    const c = queueClient([staffNotice()]);
    wrap(<DmcaQueue client={c.client} />);
    expect(byId("dmcaq")).toBeTruthy();
    for (const s of ["received", "actioned", "rejected", "countered", "restored"])
      expect(byId(`dmcaq-status-${s}`)).toBeTruthy();
    const row = await screen.findByTestId("dmcaq-item");
    expect(row.getAttribute("data-notice-id")).toBe(NOTICE);
    expect(row.getAttribute("data-items")).toBe("2");
    expect(row.getAttribute("data-resolved-items")).toBe("1");
    fireEvent.click(row);
    const detail = byId("dmcaq-detail");
    expect(detail.getAttribute("data-status")).toBe("received");
    const rows = within(detail).getAllByTestId("dmcaq-item-row");
    expect(rows[0]?.getAttribute("data-owner-id")).toBe(OWNER);
    expect(rows[0]?.getAttribute("data-removed-at")).toBe("");
    const strikes = byId("dmcaq-strikes");
    expect(strikes.getAttribute("data-strikes")).toBe("3");
    expect(strikes.getAttribute("data-repeat-infringer")).toBe("true");

    fireEvent.click(byId("dmcaq-decision-actioned"));
    type("dmcaq-note", "complete notice");
    await act(async () => fireEvent.click(byId("dmcaq-submit")));
    expect(c.action).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(await screen.findByTestId("confirm-dialog-confirm")));
    await waitFor(() =>
      expect(c.action).toHaveBeenCalledWith({ id: NOTICE, decision: "actioned", note: "complete notice" }),
    );
    await waitFor(() => expect(byId("dmcaq-detail").getAttribute("data-status")).toBe("actioned"));

    fireEvent.click(byId("dmcaq-status-actioned"));
    await waitFor(() => expect(c.queue).toHaveBeenCalledWith("actioned", undefined));
  });

  it("rejects without a confirmation", async () => {
    const c = queueClient([staffNotice()]);
    wrap(<DmcaQueue client={c.client} />);
    fireEvent.click(await screen.findByTestId("dmcaq-item"));
    fireEvent.click(byId("dmcaq-decision-rejected"));
    type("dmcaq-note", "No work identified");
    await act(async () => fireEvent.click(byId("dmcaq-submit")));
    await waitFor(() =>
      expect(c.action).toHaveBeenCalledWith({ id: NOTICE, decision: "rejected", note: "No work identified" }),
    );
  });

  it("records a court action on an open counter-notice", async () => {
    const counter = {
      id: COUNTER,
      noticeId: NOTICE,
      user: { id: OWNER, username: "ada" },
      itemIds: [ITEM_A],
      fullName: "Ada",
      address: "2 Lane",
      phone: "+1 555 0200",
      statement: "mistake",
      restoreAfter: "2026-11-12T10:00:00.000Z",
      restoredAt: null,
      suitFiledAt: null,
      suitNote: null,
      createdAt: at,
    };
    const c = queueClient([staffNotice({ status: "countered", counters: [counter] })]);
    wrap(<DmcaQueue client={c.client} />);
    fireEvent.click(await screen.findByTestId("dmcaq-item"));
    const card = byId("dmcaq-counter");
    expect(card.getAttribute("data-counter-id")).toBe(COUNTER);
    expect(card.getAttribute("data-suit-filed-at")).toBe("");
    expect(screen.queryByTestId("dmcaq-submit")).toBeNull();
    type("dmcaq-suit-note", "case 1:26-cv-1");
    fireEvent.click(byId("dmcaq-suit-filed"));
    await act(async () => fireEvent.click(await screen.findByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(c.suitFiled).toHaveBeenCalledWith({ id: COUNTER, note: "case 1:26-cv-1" }));
  });

  it("shows the empty state, and an error with retry", async () => {
    const c = queueClient([]);
    wrap(<DmcaQueue client={c.client} />);
    expect(await screen.findByTestId("dmcaq-empty")).toBeTruthy();
    cleanup();
    let fail = true;
    const failing: DmcaQueueClient = {
      ...c.client,
      queue: vi.fn<DmcaQueueClient["queue"]>(async () => {
        if (fail) throw new Error("down");
        return { items: [], nextCursor: null };
      }),
    };
    wrap(<DmcaQueue client={failing} />);
    const retry = await screen.findByRole("button", { name: /try again/i });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByTestId("dmcaq-empty")).toBeTruthy();
  });

  it("repeat infringer flag follows the threshold", () => {
    expect(isRepeatInfringer(2)).toBe(false);
    expect(isRepeatInfringer(3)).toBe(true);
    expect(isRepeatInfringer(5, 0)).toBe(false);
  });
});

describe("selector ids (docs/testing/e7-selectors.md)", () => {
  const SRC = join(import.meta.dirname, "../src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const source = files(SRC)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const doc = readFileSync(join(import.meta.dirname, "../../../docs/testing/e7-selectors.md"), "utf8");
  const section = (heading: string) => {
    const start = doc.indexOf(`### ${heading}`);
    const end = doc.indexOf("\n### ", start + 4);
    return doc.slice(start, end);
  };

  it.each(["DMCA notice", "Your content", "DMCA queue"])("every %s id is in the web source", (heading) => {
    const text = section(heading);
    expect(text.length).toBeGreaterThan(50);
    const ids = [...text.matchAll(/`([a-z][a-z0-9-]*)`/g)]
      .map((m) => m[1] ?? "")
      .filter(
        (id) => /^(dmca|dmcaq|copyright|counter|footer|account)-/.test(id) || id === "copyright" || id === "dmcaq",
      );
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(source, id).toContain(`"${id}"`);
    // Pattern ids are built from their prefix.
    expect(source).toContain("`dmcaq-status-${s}`");
    expect(source).toContain("`counter-item-${i.id}`");
  });
});
