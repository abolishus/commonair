// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `/admin/legal` (safety/legal.tsx): the queue's three paged lists (loading, empty, failed, more),
 * a T0 case's two-reviewer dismissal and confirmation, evidence that is sealed in the bucket or not
 * an image, NCMEC drafts (snapshot, filing with the shared date-time field) and legal holds.
 */
import { LocaleProvider, TooltipProvider, formatHour } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  EvidenceObjectDto,
  ImageData,
  LegalCaseDto,
  LegalClient,
  LegalHoldDto,
  NcmecReportDetailDto,
  NcmecReportDto,
  Page,
} from "../src/components/safety/client.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string, options?: unknown) => void>(),
}));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));

const { EvidenceItem, HoldList, LegalCaseCard, LegalQueue, NcmecCard, eligibleAt, localDateTimeToIso } =
  await import("../src/components/safety/legal.tsx");

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const ME = "0192f000-0000-7000-8000-0000000000aa";
const OTHER = "0192f000-0000-7000-8000-0000000000bb";
const id = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const evidence = (over: Partial<EvidenceObjectDto> = {}): EvidenceObjectDto => ({
  id: id(1),
  caseId: id(2),
  kind: "frame",
  storage: "inline",
  contentType: "image/png",
  sizeBytes: 12,
  sha256: "fixture-digest",
  sourceSubjectType: "broadcast",
  sourceSubjectId: id(3),
  capturedAt: "2026-10-21T12:00:00.000Z",
  ...over,
});

const legalCase = (over: Partial<LegalCaseDto> = {}): LegalCaseDto => ({
  id: id(10),
  tier: "t0",
  status: "open",
  origin: "hash_list",
  subjectType: "broadcast",
  subjectId: id(11),
  channel: { id: id(12), slug: "rivertide", displayName: "River Tide" },
  user: { id: id(13), username: "rivertide" },
  category: null,
  priority: 0,
  slaDueAt: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  resolvedAt: null,
  resolution: null,
  resolutionNote: null,
  assignee: null,
  assignedAt: null,
  list: "csam",
  firstReviewer: null,
  firstReviewedAt: null,
  firstReviewNote: null,
  evidence: [],
  holdId: id(14),
  ncmecReportId: null,
  flags: [],
  history: [],
  ...over,
});

const report = (over: Partial<NcmecReportDto> = {}): NcmecReportDto => ({
  id: id(20),
  caseId: id(10),
  holdId: id(14),
  userId: id(13),
  status: "draft",
  incidentAt: "2026-10-21T12:00:00.000Z",
  listCategory: "csam",
  target: "cybertipline",
  evidenceIds: [id(1)],
  externalReportId: null,
  filedAt: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  ...over,
});

const detail = (over: Partial<NcmecReportDetailDto["snapshot"]> = {}): NcmecReportDetailDto => ({
  ...report(),
  snapshot: {
    v: 1,
    incidentAt: "2026-10-21T12:00:00.000Z",
    incidentType: "csam_hash_match",
    account: {
      id: id(13),
      username: "rivertide",
      displayName: "River Tide",
      email: "river@example.invalid",
      createdAt: "2026-01-01T00:00:00.000Z",
      ipHashes: [],
      ips: ["192.0.2.1", "192.0.2.2"],
    },
    subject: { type: "broadcast", id: id(11), channelId: id(12), channelSlug: "rivertide" },
    match: { listCategory: "csam", provider: "pdq", listVersion: "v7", distance: 4, pdq: "ff" },
    evidenceIds: [id(1), id(2)],
    ...over,
  },
});

const hold = (over: Partial<LegalHoldDto> = {}): LegalHoldDto => ({
  id: id(30),
  userId: id(13),
  reasonCode: "csam_match",
  reason: "",
  caseId: id(10),
  createdAt: "2026-10-21T12:00:00.000Z",
  filedAt: null,
  eligibleForReleaseAt: null,
  releasedAt: null,
  ...over,
});

const page = <T,>(items: T[], nextCursor: string | null = null): Page<T> => ({ items, nextCursor });
const never = <T,>() => new Promise<T>(() => undefined);
/** The busy skeleton groups, each announcing "loading" to screen readers. */
const skeletons = () =>
  [...document.querySelectorAll('[data-slot="skeleton-group"][aria-busy="true"]')].filter((el) =>
    el.textContent?.includes(t("safety.legal.loading")),
  );
const unauthorized = Object.assign(new Error("expired"), { code: "UNAUTHORIZED" });

async function confirmDialog(): Promise<void> {
  const confirm = await screen.findByTestId("confirm-dialog-confirm");
  await act(async () => {
    fireEvent.click(confirm);
  });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────

describe("localDateTimeToIso", () => {
  it("is null for empty, blank and unparseable text", () => {
    expect(localDateTimeToIso("")).toBeNull();
    expect(localDateTimeToIso("   ")).toBeNull();
    expect(localDateTimeToIso("not a date")).toBeNull();
  });

  it("reads the text as the reviewer's local time", () => {
    expect(localDateTimeToIso("2026-10-21T09:30")).toBe(new Date(2026, 9, 21, 9, 30).toISOString());
  });
});

describe("eligibleAt", () => {
  const at = "2027-10-21T12:00:00.000Z";
  it("is empty until the release date, and the date from then on", () => {
    expect(eligibleAt(hold({ eligibleForReleaseAt: null }), Date.parse(at))).toBe("");
    expect(eligibleAt(hold({ eligibleForReleaseAt: at }), Date.parse(at) - 1)).toBe("");
    expect(eligibleAt(hold({ eligibleForReleaseAt: at }), Date.parse(at))).toBe(at);
    expect(eligibleAt(hold({ eligibleForReleaseAt: at }), Date.parse(at) + 1)).toBe(at);
  });

  it("fails closed without a clock", () => {
    expect(eligibleAt(hold({ eligibleForReleaseAt: at }), Number.NaN)).toBe("");
  });
});

// ── Holds ────────────────────────────────────────────────────────────────────────────────────

describe("HoldList", () => {
  it("shows a skeleton while loading and an empty state for no holds", () => {
    const loading = wrap(<HoldList holds={null} />);
    expect(skeletons()).toHaveLength(1);
    loading.unmount();
    wrap(<HoldList holds={[]} />);
    expect(screen.getByText(t("safety.legal.holdsEmpty"))).toBeTruthy();
  });

  it("lists each hold with its reason, filing state and release eligibility", () => {
    const now = Date.parse("2027-11-01T00:00:00.000Z");
    wrap(
      <HoldList
        now={now}
        holds={[
          hold({ id: id(31), filedAt: "2026-10-22T00:00:00.000Z", eligibleForReleaseAt: "2027-10-22T00:00:00.000Z" }),
          hold({ id: id(32), reasonCode: "litigation", reason: "Case 42", eligibleForReleaseAt: null }),
        ]}
      />,
    );
    const [filed, manual] = screen.getAllByTestId("legal-hold");
    expect(filed?.getAttribute("data-reason")).toBe("csam_match");
    expect(filed?.getAttribute("data-eligible-at")).toBe("2027-10-22T00:00:00.000Z");
    expect(filed?.textContent).toContain(t("safety.legal.holdFiled"));
    expect(manual?.getAttribute("data-reason")).toBe("litigation");
    expect(manual?.getAttribute("data-eligible-at")).toBe("");
    expect(manual?.textContent).toContain(`${t("safety.legal.holdNotFiled")}${t("common.listSeparator")}Case 42`);
  });

  it("never marks a hold eligible without a request clock", () => {
    wrap(<HoldList holds={[hold({ eligibleForReleaseAt: "2000-01-01T00:00:00.000Z" })]} />);
    expect(screen.getByTestId("legal-hold").getAttribute("data-eligible-at")).toBe("");
  });
});

// ── Evidence ─────────────────────────────────────────────────────────────────────────────────

describe("EvidenceItem", () => {
  it("does not offer a view of evidence sealed in the bucket", () => {
    const load = vi.fn<(id: string) => Promise<ImageData>>();
    wrap(<EvidenceItem evidence={evidence({ storage: "bucket", kind: "vod_object" })} load={load} />);
    const item = screen.getByTestId("legal-evidence");
    expect(item.getAttribute("data-storage")).toBe("bucket");
    expect(item.getAttribute("data-kind")).toBe("vod_object");
    expect(item.textContent).toContain(t("safety.legal.bucketEvidence"));
    expect(item.textContent).toContain(t("safety.legal.sha256", { sha: "fixture-digest" }));
    expect(screen.queryByTestId("legal-evidence-view")).toBeNull();
  });

  it("says so when the loaded evidence is not an image", async () => {
    const load = vi.fn<(id: string) => Promise<ImageData>>(async () => ({
      contentType: "application/pdf",
      dataBase64: "JVBERg==",
    }));
    wrap(<EvidenceItem evidence={evidence()} load={load} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-evidence-view"));
    });
    expect(load).toHaveBeenCalledWith(id(1));
    expect(await screen.findByText(t("safety.legal.evidenceNotImage"))).toBeTruthy();
    expect(screen.queryByTestId("legal-evidence-reveal")).toBeNull();
  });

  it("toasts a failed load and lets the reviewer try again", async () => {
    const load = vi.fn<(id: string) => Promise<ImageData>>(async () => {
      throw new Error("boom");
    });
    wrap(<EvidenceItem evidence={evidence()} load={load} />);
    const view = screen.getByTestId("legal-evidence-view") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(view);
    });
    expect(toasts.error).toHaveBeenCalledWith(t("safety.legal.evidenceFailed"));
    await waitFor(() => expect(view.disabled).toBe(false));
    expect(view.getAttribute("aria-busy")).toBeNull();
  });

  it("is busy while the bytes load", async () => {
    wrap(<EvidenceItem evidence={evidence()} load={() => never()} />);
    const view = screen.getByTestId("legal-evidence-view") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(view);
    });
    expect(view.disabled).toBe(true);
    expect(view.getAttribute("aria-busy")).toBe("true");
  });
});

// ── Cases ────────────────────────────────────────────────────────────────────────────────────

function caseCard(c: LegalCaseDto, over: Partial<React.ComponentProps<typeof LegalCaseCard>> = {}) {
  const props = {
    legalCase: c,
    meId: ME,
    loadEvidence: vi.fn<(id: string) => Promise<ImageData>>(async () => ({
      contentType: "image/png",
      dataBase64: "aGVsbG8=",
    })),
    onConfirm: vi.fn<(note: string) => Promise<void>>(async () => undefined),
    onDismiss: vi.fn<(note: string) => Promise<string>>(async () => "dismissal_pending"),
    ...over,
  };
  wrap(<LegalCaseCard {...props} />);
  return props;
}

const typeNote = (note: string) => fireEvent.change(screen.getByTestId("legal-note"), { target: { value: note } });
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const noteValue = () => (screen.getByTestId("legal-note") as HTMLTextAreaElement).value;

describe("LegalCaseCard", () => {
  it("names the source list for each kind of case", () => {
    for (const [list, key] of [
      ["csam", "safety.legal.list.csam"],
      ["ncii", "safety.legal.list.ncii"],
      ["human", "safety.legal.list.human"],
    ] as const) {
      caseCard(legalCase({ list }));
      const card = screen.getByTestId("legal-case");
      expect(card.getAttribute("data-list")).toBe(list);
      expect(card.textContent).toContain(t(key));
      cleanup();
    }
  });

  it("titles the case by channel, then user, then unknown", () => {
    caseCard(legalCase());
    expect(screen.getByText(t("safety.legal.caseTitle", { subject: "River Tide" }))).toBeTruthy();
    cleanup();
    caseCard(legalCase({ channel: null }));
    expect(screen.getByText(t("safety.legal.caseTitle", { subject: "rivertide" }))).toBeTruthy();
    cleanup();
    caseCard(legalCase({ channel: null, user: null }));
    expect(screen.getByText(t("safety.legal.caseTitle", { subject: t("safety.modq.unknownSubject") }))).toBeTruthy();
  });

  it("lists each hash match, the first reviewer and their note, and the evidence", () => {
    const flag = {
      id: id(40),
      tier: "t0" as const,
      origin: "hash_list" as const,
      category: null,
      score: null,
      listCategory: "csam" as const,
      hasFrame: false,
      capturedAt: "2026-10-21T12:00:00.000Z",
    };
    caseCard(
      legalCase({
        status: "dismissal_pending",
        firstReviewer: { id: OTHER, username: "reviewer-one" },
        firstReviewNote: "Looks like a false match.",
        flags: [
          { ...flag, distance: 3, provider: "pdq", providerVersion: "v7" },
          { ...flag, id: id(41), distance: null, provider: "manual", providerVersion: "1" },
        ],
        evidence: [evidence(), evidence({ id: id(5), storage: "bucket" })],
      }),
    );
    const card = screen.getByTestId("legal-case");
    expect(card.getAttribute("data-first-reviewer")).toBe(OTHER);
    expect(card.textContent).toContain(t("safety.legal.matchValue", { distance: 3, provider: "pdq", version: "v7" }));
    expect(card.textContent).toContain(
      t("safety.legal.matchValue", { distance: "", provider: "manual", version: "1" }),
    );
    expect(card.textContent).toContain("reviewer-one");
    expect(card.textContent).toContain("Looks like a false match.");
    expect(screen.getAllByTestId("legal-evidence")).toHaveLength(2);
    expect(card.textContent).not.toContain(t("safety.legal.noEvidence"));
  });

  it("says when a case has no evidence", () => {
    caseCard(legalCase());
    expect(screen.getByText(t("safety.legal.noEvidence"))).toBeTruthy();
    expect(screen.getByTestId("legal-case").getAttribute("data-first-reviewer")).toBe("");
  });

  it("offers no decision on a case that is already decided", () => {
    for (const status of ["confirmed", "dismissed"] as const) {
      caseCard(legalCase({ status }));
      expect(screen.queryByTestId("legal-note")).toBeNull();
      expect(screen.queryByTestId("legal-confirm")).toBeNull();
      expect(screen.queryByTestId("legal-dismiss")).toBeNull();
      cleanup();
    }
  });

  it("needs a note before confirming, then confirms with it trimmed", async () => {
    const props = caseCard(legalCase());
    expect(button("legal-confirm").disabled).toBe(true);
    expect(button("legal-dismiss").disabled).toBe(true);
    expect(button("legal-dismiss").textContent).toBe(t("safety.legal.dismiss"));
    typeNote("   ");
    expect(button("legal-confirm").disabled).toBe(true);
    typeNote("  Confirmed match.  ");
    expect(button("legal-confirm").disabled).toBe(false);
    fireEvent.click(button("legal-confirm"));
    expect(await screen.findByText(t("safety.legal.confirmTitle"))).toBeTruthy();
    await confirmDialog();
    expect(props.onConfirm).toHaveBeenCalledWith("Confirmed match.");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(t("safety.legal.confirmed")));
    expect(noteValue()).toBe("");
  });

  it("toasts a failed confirmation and keeps the note", async () => {
    caseCard(legalCase(), {
      onConfirm: vi.fn<(note: string) => Promise<void>>(async () => {
        throw new Error("nope");
      }),
    });
    typeNote("Confirmed match.");
    fireEvent.click(button("legal-confirm"));
    await confirmDialog();
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(t("safety.legal.actionFailed")));
    expect(noteValue()).toBe("Confirmed match.");
  });

  it("records the first dismissal as pending", async () => {
    const props = caseCard(legalCase());
    typeNote("False match");
    fireEvent.click(button("legal-dismiss"));
    expect(await screen.findByText(t("safety.legal.dismissTitle"))).toBeTruthy();
    await confirmDialog();
    expect(props.onDismiss).toHaveBeenCalledWith("False match");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(t("safety.legal.dismissPending")));
    expect(noteValue()).toBe("");
  });

  it("lets a different reviewer give the second dismissal, and says when the case is dismissed", async () => {
    const props = caseCard(legalCase({ status: "dismissal_pending", firstReviewer: { id: OTHER, username: "one" } }), {
      onDismiss: vi.fn<(note: string) => Promise<string>>(async () => "dismissed"),
    });
    // Only an open case can be confirmed.
    expect(screen.queryByTestId("legal-confirm")).toBeNull();
    expect(button("legal-dismiss").textContent).toBe(t("safety.legal.dismissSecond"));
    expect(screen.queryByText(t("safety.legal.secondReviewerNeeded"))).toBeNull();
    typeNote("Agreed");
    expect(button("legal-dismiss").getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(button("legal-dismiss"));
    expect(await screen.findByText(t("safety.legal.dismissSecondTitle"))).toBeTruthy();
    await confirmDialog();
    expect(props.onDismiss).toHaveBeenCalledWith("Agreed");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(t("safety.legal.dismissed")));
  });

  it("blocks the first reviewer from giving the second dismissal, and says why", () => {
    caseCard(legalCase({ status: "dismissal_pending", firstReviewer: { id: ME, username: "me" } }));
    typeNote("Still false");
    const dismiss = button("legal-dismiss");
    expect(dismiss.disabled).toBe(true);
    const why = screen.getByText(t("safety.legal.secondReviewerNeeded"));
    expect(dismiss.getAttribute("aria-describedby")).toBe(why.id);
  });

  it("sends an expired session to sign in when a dismissal fails", async () => {
    caseCard(legalCase(), {
      onDismiss: vi.fn<(note: string) => Promise<string>>(async () => {
        throw unauthorized;
      }),
    });
    typeNote("False match");
    fireEvent.click(button("legal-dismiss"));
    await confirmDialog();
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(t("auth.sessionExpired"), expect.anything()));
  });
});

// ── NCMEC drafts ─────────────────────────────────────────────────────────────────────────────

async function pick(trigger: string, name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(trigger));
  const item = await screen.findByRole("option", { name });
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** Fills "Filed at" with 1 January of this (UTC) year, 09:30 the reviewer's time; returns that instant. */
async function fillFiledAt(): Promise<string> {
  const year = new Date().getUTCFullYear();
  await pick("legal-ncmec-filed-at-year", String(year));
  await pick("legal-ncmec-filed-at-month", "January");
  await pick("legal-ncmec-filed-at-day", "1");
  await pick("legal-ncmec-filed-at-hour", formatHour(9, locale));
  await pick("legal-ncmec-filed-at-minute", "30");
  return new Date(year, 0, 1, 9, 30).toISOString();
}

describe("NcmecCard", () => {
  it("shows a filed report's reference and filing time, with no filing form", () => {
    wrap(
      <NcmecCard
        report={report({ status: "filed", externalReportId: "CT-123", filedAt: "2026-10-22T00:00:00.000Z" })}
        loadDetail={vi.fn<(id: string) => Promise<NcmecReportDetailDto>>()}
        onFile={vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>()}
      />,
    );
    const card = screen.getByTestId("legal-ncmec");
    expect(card.getAttribute("data-status")).toBe("filed");
    expect(card.textContent).toContain("CT-123");
    expect(card.textContent).toContain(t("safety.legal.externalId"));
    expect(card.textContent).toContain(t("safety.legal.filedAt"));
    expect(screen.queryByTestId("legal-ncmec-file")).toBeNull();
  });

  it("opens the sealed snapshot only when asked", async () => {
    const loadDetail = vi.fn<(id: string) => Promise<NcmecReportDetailDto>>(async () => detail());
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={loadDetail}
        onFile={vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>()}
      />,
    );
    expect(loadDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("legal-ncmec-snapshot")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-ncmec-open"));
    });
    expect(loadDetail).toHaveBeenCalledWith(id(20));
    const snapshot = await screen.findByTestId("legal-ncmec-snapshot");
    expect(snapshot.textContent).toContain(`rivertide (${id(13)})`);
    expect(snapshot.textContent).toContain("river@example.invalid");
    expect(snapshot.textContent).toContain(`192.0.2.1${t("common.listSeparator")}192.0.2.2`);
    expect(snapshot.textContent).toContain(`broadcast ${id(11)}`);
    expect(snapshot.textContent).toContain(
      t("safety.legal.matchValue", { distance: 4, provider: "pdq", version: "v7" }),
    );
    expect(screen.queryByTestId("legal-ncmec-open")).toBeNull();
  });

  it("shows a snapshot with no hash match and no channel", async () => {
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={async () =>
          detail({ match: null, subject: { type: "upload", id: id(15), channelId: null, channelSlug: null } })
        }
        onFile={vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-ncmec-open"));
    });
    const snapshot = await screen.findByTestId("legal-ncmec-snapshot");
    expect(snapshot.textContent).not.toContain(t("safety.legal.match"));
    expect(snapshot.textContent).toContain(`upload ${id(15)}`);
  });

  it("toasts a snapshot that fails to open and lets the reviewer retry", async () => {
    const loadDetail = vi.fn<(id: string) => Promise<NcmecReportDetailDto>>(async () => {
      throw new Error("sealed");
    });
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={loadDetail}
        onFile={vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-ncmec-open"));
    });
    expect(toasts.error).toHaveBeenCalledWith(t("safety.legal.ncmecFailed"));
    expect(button("legal-ncmec-open").disabled).toBe(false);
  });

  it("is busy while the snapshot loads", async () => {
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={() => never()}
        onFile={vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-ncmec-open"));
    });
    expect(button("legal-ncmec-open").disabled).toBe(true);
    expect(button("legal-ncmec-open").getAttribute("aria-busy")).toBe("true");
  });

  it("files a draft only with a reference and a whole date, as an ISO instant", async () => {
    const onFile = vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>(async () => undefined);
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={vi.fn<(id: string) => Promise<NcmecReportDetailDto>>()}
        onFile={onFile}
      />,
    );
    expect(button("legal-ncmec-file").disabled).toBe(true);
    fireEvent.change(screen.getByTestId("legal-ncmec-report-id"), { target: { value: "  CT-999  " } });
    expect(button("legal-ncmec-file").disabled).toBe(true);
    const iso = await fillFiledAt();
    await waitFor(() => expect(button("legal-ncmec-file").disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button("legal-ncmec-file"));
    });
    expect(onFile).toHaveBeenCalledWith("CT-999", iso);
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(t("safety.legal.filed")));
  });

  it("does not file without a reference even with a date", async () => {
    const onFile = vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>(async () => undefined);
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={vi.fn<(id: string) => Promise<NcmecReportDetailDto>>()}
        onFile={onFile}
      />,
    );
    await fillFiledAt();
    fireEvent.change(screen.getByTestId("legal-ncmec-report-id"), { target: { value: "   " } });
    expect(button("legal-ncmec-file").disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(button("legal-ncmec-file").closest("form") as HTMLFormElement);
    });
    expect(onFile).not.toHaveBeenCalled();
  });

  it("toasts a failed filing and re-enables the button", async () => {
    const onFile = vi.fn<(externalReportId: string, filedAt: string) => Promise<void>>(async () => {
      throw new Error("down");
    });
    wrap(
      <NcmecCard
        report={report()}
        loadDetail={vi.fn<(id: string) => Promise<NcmecReportDetailDto>>()}
        onFile={onFile}
      />,
    );
    fireEvent.change(screen.getByTestId("legal-ncmec-report-id"), { target: { value: "CT-1" } });
    await fillFiledAt();
    await act(async () => {
      fireEvent.click(button("legal-ncmec-file"));
    });
    expect(toasts.error).toHaveBeenCalledWith(t("safety.legal.fileFailed"));
    await waitFor(() => expect(button("legal-ncmec-file").disabled).toBe(false));
  });
});

// ── The queue ────────────────────────────────────────────────────────────────────────────────

function fakeClient(over: Partial<LegalClient> = {}) {
  return {
    cases: vi.fn<LegalClient["cases"]>(async () => page<LegalCaseDto>([])),
    confirmCase: vi.fn<LegalClient["confirmCase"]>(async () => legalCase({ status: "confirmed" })),
    dismiss: vi.fn<LegalClient["dismiss"]>(async () => ({
      case: legalCase({ status: "dismissal_pending" }),
      mediaRestored: false as const,
    })),
    evidence: vi.fn<LegalClient["evidence"]>(async () => ({ contentType: "image/png", dataBase64: "aGVsbG8=" })),
    reports: vi.fn<LegalClient["reports"]>(async () => page<NcmecReportDto>([])),
    report: vi.fn<LegalClient["report"]>(async () => detail()),
    file: vi.fn<LegalClient["file"]>(async () => report({ status: "filed" })),
    holds: vi.fn<LegalClient["holds"]>(async () => page<LegalHoldDto>([])),
    ...over,
  };
}

const loadMoreButtons = () => screen.queryAllByRole("button", { name: t("safety.modq.loadMore") });

describe("LegalQueue", () => {
  it("shows a skeleton for each list until its first page arrives", () => {
    const client = fakeClient({ cases: () => never(), reports: () => never(), holds: () => never() });
    wrap(<LegalQueue meId={ME} client={client} />);
    expect(skeletons()).toHaveLength(3);
  });

  it("shows each list's empty state", async () => {
    wrap(<LegalQueue meId={ME} client={fakeClient()} />);
    expect(await screen.findByText(t("safety.legal.casesEmpty"))).toBeTruthy();
    expect(await screen.findByText(t("safety.legal.ncmecEmpty"))).toBeTruthy();
    expect(await screen.findByText(t("safety.legal.holdsEmpty"))).toBeTruthy();
    expect(loadMoreButtons()).toHaveLength(0);
  });

  it("says when a list fails to load, instead of a skeleton", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("down");
    };
    wrap(<LegalQueue meId={ME} client={fakeClient({ cases: fail, reports: fail, holds: fail })} />);
    await waitFor(() => expect(screen.getAllByText(t("safety.legal.loadFailed"))).toHaveLength(3));
    expect(skeletons()).toHaveLength(0);
    expect(screen.getByText(t("safety.legal.casesEmpty"))).toBeTruthy();
  });

  it("loads more cases, and toasts when the next page fails", async () => {
    const cases = vi.fn<LegalClient["cases"]>(async (cursor) =>
      cursor === undefined ? page([legalCase({ id: id(50) })], "c1") : page([legalCase({ id: id(51) })], "c2"),
    );
    wrap(<LegalQueue meId={ME} client={fakeClient({ cases })} />);
    await waitFor(() => expect(screen.getAllByTestId("legal-case")).toHaveLength(1));
    await act(async () => {
      fireEvent.click(loadMoreButtons()[0] as HTMLElement);
    });
    await waitFor(() => expect(screen.getAllByTestId("legal-case")).toHaveLength(2));
    expect(cases).toHaveBeenLastCalledWith("c1");
    cases.mockRejectedValueOnce(new Error("down"));
    await act(async () => {
      fireEvent.click(loadMoreButtons()[0] as HTMLElement);
    });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(t("safety.legal.loadMoreFailed")));
    expect(cases).toHaveBeenLastCalledWith("c2");
  });

  it("offers more drafts and holds when their lists have another page", async () => {
    const client = fakeClient({
      reports: async () => page([report()], "r1"),
      holds: async () => page([hold()], "h1"),
    });
    wrap(<LegalQueue meId={ME} client={client} />);
    await waitFor(() => expect(loadMoreButtons()).toHaveLength(2));
    expect(screen.getByTestId("legal-ncmec")).toBeTruthy();
    expect(screen.getByTestId("legal-hold")).toBeTruthy();
  });

  it("confirms a case through the client and reloads cases and drafts", async () => {
    const client = fakeClient({ cases: vi.fn<LegalClient["cases"]>(async () => page([legalCase()])) });
    wrap(<LegalQueue meId={ME} client={client} />);
    await screen.findByTestId("legal-case");
    typeNote("Match confirmed");
    fireEvent.click(button("legal-confirm"));
    await confirmDialog();
    expect(client.confirmCase).toHaveBeenCalledWith(id(10), "Match confirmed");
    await waitFor(() => expect(client.cases).toHaveBeenCalledTimes(2));
    expect(client.reports).toHaveBeenCalledTimes(2);
    expect(client.holds).toHaveBeenCalledTimes(1);
  });

  it("dismisses a case through the client and reports its new status", async () => {
    const client = fakeClient({
      cases: vi.fn<LegalClient["cases"]>(async () =>
        page([legalCase({ status: "dismissal_pending", firstReviewer: { id: OTHER, username: "one" } })]),
      ),
      dismiss: vi.fn<LegalClient["dismiss"]>(async () => ({
        case: legalCase({ status: "dismissed" }),
        mediaRestored: false as const,
      })),
    });
    wrap(<LegalQueue meId={ME} client={client} />);
    await screen.findByTestId("legal-case");
    typeNote("Agreed");
    fireEvent.click(button("legal-dismiss"));
    await confirmDialog();
    expect(client.dismiss).toHaveBeenCalledWith(id(10), "Agreed");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(t("safety.legal.dismissed")));
    expect(client.cases).toHaveBeenCalledTimes(2);
    expect(client.reports).toHaveBeenCalledTimes(2);
  });

  it("loads evidence and drafts' snapshots through the client", async () => {
    const client = fakeClient({
      cases: async () => page([legalCase({ evidence: [evidence()] })]),
      reports: async () => page([report({ status: "filed" })]),
    });
    wrap(<LegalQueue meId={ME} client={client} />);
    const view = await screen.findByTestId("legal-evidence-view");
    await act(async () => {
      fireEvent.click(view);
    });
    expect(client.evidence).toHaveBeenCalledWith(id(1));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("legal-ncmec-open"));
    });
    expect(client.report).toHaveBeenCalledWith(id(20));
  });

  it("files a draft through the client and reloads drafts and holds", async () => {
    const client = fakeClient({ reports: vi.fn<LegalClient["reports"]>(async () => page([report()])) });
    wrap(<LegalQueue meId={ME} client={client} />);
    const card = await screen.findByTestId("legal-ncmec");
    fireEvent.change(within(card).getByTestId("legal-ncmec-report-id"), { target: { value: "CT-7" } });
    const iso = await fillFiledAt();
    await act(async () => {
      fireEvent.click(button("legal-ncmec-file"));
    });
    expect(client.file).toHaveBeenCalledWith({ id: id(20), externalReportId: "CT-7", filedAt: iso });
    await waitFor(() => expect(client.reports).toHaveBeenCalledTimes(2));
    expect(client.holds).toHaveBeenCalledTimes(2);
    expect(client.cases).toHaveBeenCalledTimes(1);
  });
});
