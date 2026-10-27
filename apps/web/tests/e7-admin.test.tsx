// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E7-admin pages: egress, incidents and integrity flags render every state and submit the right inputs. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  EgressClient,
  EgressReportDto,
  IncidentDto,
  IncidentsClient,
  IntegrityClient,
  IntegrityFlagDto,
  StatusSummaryDto,
} from "../src/components/admin/client.ts";
import { EgressPage } from "../src/components/admin/egress.tsx";
import {
  channelFilter,
  checkEgressRange,
  defaultEgressInputs,
  detailText,
  fromUtcInput,
  parseComponents,
  toUtcInput,
} from "../src/components/admin/forms.ts";
import { IncidentsPage, mergeIncidents } from "../src/components/admin/incidents.tsx";
import { IntegrityPage, flagFilters } from "../src/components/admin/integrity.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const tid = (id: string) => screen.getByTestId(id);
const NOW = new Date("2026-10-27T12:00:30.000Z");

describe("admin form helpers", () => {
  it("reads and writes datetime-local values as UTC", () => {
    expect(toUtcInput(new Date("2026-10-27T12:34:56.789Z"))).toBe("2026-10-27T12:34");
    expect(fromUtcInput("2026-10-27T12:34")).toBe("2026-10-27T12:34:00.000Z");
    expect(fromUtcInput("2026-10-27T12:34:10")).toBe("2026-10-27T12:34:10.000Z");
    expect(fromUtcInput("")).toBeNull();
    expect(fromUtcInput("2026-13-45T99:99")).toBeNull();
  });
  it("defaults to the last 24 hours, to the minute", () => {
    expect(defaultEgressInputs(NOW)).toEqual({ from: "2026-10-26T12:01", to: "2026-10-27T12:01" });
  });
  it("checks the range like the API", () => {
    expect(checkEgressRange("2026-10-01T00:00", "2026-11-01T00:00")).toEqual({
      ok: true,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
    expect(checkEgressRange("2026-10-01T00:00", "2026-11-01T00:01")).toEqual({ ok: false, error: "tooLong" });
    expect(checkEgressRange("2026-10-01T00:00", "2026-10-01T00:00")).toEqual({ ok: false, error: "order" });
    expect(checkEgressRange("", "2026-10-01T00:00")).toEqual({ ok: false, error: "invalid" });
  });
  it("parses components, the channel filter and detail values", () => {
    expect(parseComponents(" postgres\n\nvalkey,postgres \n")).toEqual(["postgres", "valkey"]);
    expect(channelFilter("")).toEqual({ ok: true, channel: undefined });
    expect(channelFilter(" Alice_1 ")).toEqual({ ok: true, channel: "alice_1" });
    expect(channelFilter("a b")).toEqual({ ok: false });
    expect(detailText(0.123456)).toBe("0.123");
    expect(detailText(["a", "b"])).toBe("a, b");
    expect(detailText(null)).toBe("–");
    expect(detailText([{ follows: 3 }])).toBe('[{"follows":3}]');
  });
  it("builds flag filters", () => {
    expect(flagFilters("all", "all", undefined)).toEqual({});
    expect(flagFilters("session", "pending_review", "alice")).toEqual({
      subjectType: "session",
      decision: "pending_review",
      channel: "alice",
    });
  });
});

// ── Egress ───────────────────────────────────────────────────────────────────────────────────

const report: EgressReportDto = {
  from: "2026-10-26T12:01:00.000Z",
  to: "2026-10-27T12:01:00.000Z",
  totals: { origin: 1_500_000, relay: 2_000, p2p: 0, cdn: 0 },
  byBroadcast: [
    {
      broadcastId: "0192f000-0000-7000-8000-00000000000b",
      channelSlug: "alice",
      bytes: { origin: 1_500_000, relay: 2_000, p2p: 0, cdn: 0 },
    },
  ],
};

describe("egress page", () => {
  it("loads the last 24 h and shows totals and rows", async () => {
    const reportFn = vi.fn<EgressClient["report"]>(async () => report);
    wrap(<EgressPage client={{ report: reportFn }} now={NOW} />);
    await screen.findByTestId("egress-row");
    expect(reportFn).toHaveBeenCalledWith({ from: "2026-10-26T12:01:00.000Z", to: "2026-10-27T12:01:00.000Z" });
    expect(tid("egress")).toBeTruthy();
    expect((tid("egress-from") as HTMLInputElement).type).toBe("datetime-local");
    const totals = screen.getAllByTestId("egress-total");
    expect(totals.map((e) => [e.dataset.source, e.dataset.bytes])).toEqual([
      ["origin", "1500000"],
      ["relay", "2000"],
      ["p2p", "0"],
      ["cdn", "0"],
    ]);
    const row = tid("egress-row");
    expect(row.dataset).toMatchObject({
      broadcastId: "0192f000-0000-7000-8000-00000000000b",
      channel: "alice",
      origin: "1500000",
      relay: "2000",
      p2p: "0",
      cdn: "0",
    });
    expect(screen.queryByTestId("egress-empty")).toBeNull();
  });

  it("submits the typed range as UTC and refuses a bad one", async () => {
    const reportFn = vi.fn<EgressClient["report"]>(async () => ({ ...report, byBroadcast: [] }));
    wrap(<EgressPage client={{ report: reportFn }} now={NOW} />);
    await screen.findByTestId("egress-empty");
    fireEvent.change(tid("egress-from"), { target: { value: "2026-10-01T00:00" } });
    fireEvent.change(tid("egress-to"), { target: { value: "2026-10-02T06:30" } });
    fireEvent.click(tid("egress-load"));
    await waitFor(() =>
      expect(reportFn).toHaveBeenLastCalledWith({
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-02T06:30:00.000Z",
      }),
    );
    const calls = reportFn.mock.calls.length;
    fireEvent.change(tid("egress-to"), { target: { value: "2026-12-01T00:00" } });
    fireEvent.click(tid("egress-load"));
    await screen.findByText("A report covers at most 31 days.");
    expect(reportFn.mock.calls.length).toBe(calls);
  });

  it("shows an error with retry", async () => {
    const reportFn = vi.fn<EgressClient["report"]>().mockRejectedValueOnce(new Error("down")).mockResolvedValue(report);
    wrap(<EgressPage client={{ report: reportFn }} now={NOW} />);
    const error = await screen.findByTestId("egress-error");
    fireEvent.click(error.querySelector("button") as HTMLButtonElement);
    await screen.findByTestId("egress-row");
    expect(reportFn).toHaveBeenCalledTimes(2);
  });
});

// ── Incidents ────────────────────────────────────────────────────────────────────────────────

const component = (id: string) => ({
  id,
  name: id,
  status: "operational" as const,
  latencyMs: 1,
  checkedAt: NOW.toISOString(),
});
const incident: IncidentDto = {
  id: "0192f000-0000-7000-8000-0000000000i1",
  title: "Chat delays",
  status: "investigating",
  components: ["chat"],
  body: "Looking into it",
  startedAt: "2026-10-27T11:00:00.000Z",
  resolvedAt: null,
};
const statusOf = (incidents: IncidentDto[]): StatusSummaryDto => ({
  status: "operational",
  components: ["postgres", "valkey", "chat"].map(component),
  incidents,
});

describe("incidents page", () => {
  it("shows the empty state, then opens a new incident with the right input", async () => {
    const write = vi.fn<IncidentsClient["write"]>(async () => ({ id: "0192f000-0000-7000-8000-0000000000i2" }));
    wrap(<IncidentsPage client={{ status: async () => statusOf([]), write }} />);
    await screen.findByTestId("incidents-empty");
    expect(tid("incidents")).toBeTruthy();
    fireEvent.click(tid("incident-new"));
    expect(tid("incident-form")).toBeTruthy();
    fireEvent.change(tid("incident-title"), { target: { value: "Database slow" } });
    fireEvent.click(tid("incident-status-identified"));
    fireEvent.change(tid("incident-components"), { target: { value: "postgres\nvalkey\n" } });
    fireEvent.change(tid("incident-body"), { target: { value: "Disk pressure" } });
    fireEvent.click(tid("incident-submit"));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        title: "Database slow",
        status: "identified",
        components: ["postgres", "valkey"],
        body: "Disk pressure",
      }),
    );
    // Shown at once, although the status page answer is cached.
    const row = await screen.findByTestId("incident-row");
    expect(row.dataset).toMatchObject({ incidentId: "0192f000-0000-7000-8000-0000000000i2", status: "identified" });
  });

  it("refuses unknown components before calling the API", async () => {
    const write = vi.fn<IncidentsClient["write"]>();
    wrap(<IncidentsPage client={{ status: async () => statusOf([]), write }} />);
    await screen.findByTestId("incidents-empty");
    fireEvent.click(tid("incident-new"));
    fireEvent.change(tid("incident-title"), { target: { value: "x" } });
    fireEvent.change(tid("incident-components"), { target: { value: "db" } });
    fireEvent.click(tid("incident-submit"));
    await screen.findByText("Unknown components: db");
    expect(write).not.toHaveBeenCalled();
  });

  it("edits an incident and confirms before resolving it", async () => {
    const write = vi.fn<IncidentsClient["write"]>(async () => ({ id: incident.id }));
    wrap(<IncidentsPage client={{ status: async () => statusOf([incident]), write }} />);
    const row = await screen.findByTestId("incident-row");
    expect(row.dataset).toMatchObject({ incidentId: incident.id, status: "investigating" });
    fireEvent.click(tid("incident-edit"));
    expect((tid("incident-title") as HTMLInputElement).value).toBe("Chat delays");
    expect((tid("incident-components") as HTMLTextAreaElement).value).toBe("chat");
    fireEvent.click(tid("incident-status-resolved"));
    fireEvent.click(tid("incident-submit"));
    const confirm = await screen.findByTestId("confirm-dialog-confirm");
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        id: incident.id,
        title: "Chat delays",
        status: "resolved",
        components: ["chat"],
        body: "Looking into it",
      }),
    );
    await waitFor(() => expect(tid("incident-row").dataset.status).toBe("resolved"));
  });

  it("shows an error with retry", async () => {
    const status = vi
      .fn<IncidentsClient["status"]>()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue(statusOf([]));
    wrap(<IncidentsPage client={{ status, write: vi.fn<IncidentsClient["write"]>() }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("incidents-empty")).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("merges written incidents over the loaded ones, newest first", () => {
    const newer = { ...incident, id: "n", startedAt: "2026-10-27T11:30:00.000Z" };
    const edited = { ...incident, status: "monitoring" as const };
    expect(
      mergeIncidents(
        [incident],
        new Map([
          [incident.id, edited],
          ["n", newer],
        ]),
      ),
    ).toEqual([newer, edited]);
  });
});

// ── Integrity ────────────────────────────────────────────────────────────────────────────────

const flag: IntegrityFlagDto = {
  id: "0192f000-0000-7000-8000-0000000000f1",
  subjectType: "session",
  subjectId: "0192f000-0000-7000-8000-0000000000s1",
  signal: "datacenter_ip",
  score: 0.6,
  details: { network: "hosting:example", asn: 64500 },
  decision: "pending_review",
  createdAt: "2026-10-27T11:00:00.000Z",
};

describe("integrity page", () => {
  it("lists pending flags with their data attributes and filters", async () => {
    const flags = vi.fn<IntegrityClient["flags"]>(async () => ({ items: [flag], nextCursor: null }));
    wrap(<IntegrityPage client={{ flags, decide: vi.fn<IntegrityClient["decide"]>() }} />);
    const item = await screen.findByTestId("integrityq-item");
    expect(flags).toHaveBeenCalledWith({ decision: "pending_review" }, undefined);
    expect(item.dataset).toMatchObject({
      flagId: flag.id,
      subjectType: "session",
      subjectId: flag.subjectId,
      signal: "datacenter_ip",
      score: "0.6",
      decision: "pending_review",
    });
    for (const id of [
      "integrityq",
      "integrityq-subject",
      "integrityq-subject-session",
      "integrityq-decision",
      "integrityq-decision-allowed",
      "integrityq-channel",
      "integrityq-decide",
      "integrityq-decide-excluded",
      "integrityq-decide-allowed",
      "integrityq-reason",
      "integrityq-submit",
    ])
      expect(tid(id)).toBeTruthy();
    expect(item.textContent).toContain("hosting:example");

    fireEvent.click(tid("integrityq-subject-relay"));
    await waitFor(() =>
      expect(flags).toHaveBeenLastCalledWith({ subjectType: "relay", decision: "pending_review" }, undefined),
    );
    fireEvent.click(tid("integrityq-decision-all"));
    fireEvent.change(tid("integrityq-channel"), { target: { value: "alice" } });
    await waitFor(() => expect(flags).toHaveBeenLastCalledWith({ subjectType: "relay", channel: "alice" }, undefined), {
      timeout: 2000,
    });
  });

  it("decides with a required reason and shows the new decision", async () => {
    const decide = vi.fn<IntegrityClient["decide"]>(async (input) => ({ ...flag, decision: input.decision }));
    wrap(<IntegrityPage client={{ flags: async () => ({ items: [flag], nextCursor: null }), decide }} />);
    await screen.findByTestId("integrityq-item");
    const submit = tid("integrityq-submit") as HTMLButtonElement;
    fireEvent.click(tid("integrityq-decide-allowed"));
    expect(submit.disabled).toBe(true);
    fireEvent.change(tid("integrityq-reason"), { target: { value: "  Office VPN  " } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith({ id: flag.id, decision: "allowed", reason: "Office VPN" }),
    );
    await waitFor(() => expect(tid("integrityq-item").dataset.decision).toBe("allowed"));
  });

  it("shows the empty state and the error state with retry", async () => {
    wrap(
      <IntegrityPage
        client={{ flags: async () => ({ items: [], nextCursor: null }), decide: vi.fn<IntegrityClient["decide"]>() }}
      />,
    );
    await screen.findByTestId("integrityq-empty");
    cleanup();
    const flags = vi
      .fn<IntegrityClient["flags"]>()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue({ items: [flag], nextCursor: null });
    wrap(<IntegrityPage client={{ flags, decide: vi.fn<IntegrityClient["decide"]>() }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("integrityq-item")).toBeTruthy();
    expect(flags).toHaveBeenCalledTimes(2);
  });
});
