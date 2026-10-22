// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** `/settings/privacy` compositions and the E6 formatters. */
import type * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test, vi } from "vite-plus/test";
import { EXPORT_COOLDOWN_SECONDS } from "@commonair/contracts/internal";
import {
  DeletionPanel,
  ExportPanel,
  deletionStatusTone,
  exportCooldownUntil,
  exportStatusTone,
} from "../../src/blocks/privacy/index.ts";
import { TooltipProvider } from "../../src/components/tooltip.tsx";
import { formatBytes, formatDuration } from "../../src/lib/format.ts";
import { deletionLabels, exportKinds, exportLabels, exportRows } from "../../stories/e6-fixtures.tsx";

const withTooltips = (node: React.ReactNode) => <TooltipProvider>{node}</TooltipProvider>;
const attr = (el: Element, name: string) => el.getAttribute(name);

describe("formatters", () => {
  test.each([
    [0, "0 byte"],
    [999, "999 byte"],
    [1000, "1 kB"],
    [1_536_000, "1.5 MB"],
    [2_000_000_000, "2 GB"],
    [-5, "0 byte"],
  ])("formatBytes(%i)", (bytes, text) => {
    expect(formatBytes(bytes, "en")).toBe(text);
  });

  test("formatBytes is locale-aware", () => {
    expect(formatBytes(1_536_000, "de")).toBe("1,5 MB");
  });

  test.each([
    [0, "0:00"],
    [9.9, "0:09"],
    [75, "1:15"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
    [-3, "0:00"],
  ])("formatDuration(%d)", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("exportCooldownUntil", () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const HOUR = 3_600_000;

  test("no exports, other kinds, failed or expired ones: no cooldown", () => {
    expect(exportCooldownUntil([], "account", now)).toBeNull();
    expect(
      exportCooldownUntil(
        [
          { kind: "channel", status: "ready", createdAt: iso(-HOUR) },
          { kind: "account", status: "failed", createdAt: iso(-HOUR) },
          { kind: "account", status: "expired", createdAt: iso(-HOUR) },
        ],
        "account",
        now,
      ),
    ).toBeNull();
  });

  test.each(["queued", "running", "ready"])("a %s export inside the window counts from its creation", (status) => {
    expect(exportCooldownUntil([{ kind: "account", status, createdAt: iso(-3 * HOUR) }], "account", now)).toBe(
      iso(-3 * HOUR + EXPORT_COOLDOWN_SECONDS * 1000),
    );
  });

  test("the newest export decides; the boundary is exclusive", () => {
    const jobs = [
      { kind: "account", status: "ready", createdAt: iso(-20 * HOUR) },
      { kind: "account", status: "ready", createdAt: iso(-2 * HOUR) },
    ];
    expect(exportCooldownUntil(jobs, "account", new Date(now))).toBe(iso(22 * HOUR));
    expect(
      exportCooldownUntil([{ kind: "account", status: "ready", createdAt: iso(-24 * HOUR) }], "account", now),
    ).toBeNull();
    expect(
      exportCooldownUntil([{ kind: "account", status: "ready", createdAt: "garbage" }], "account", now),
    ).toBeNull();
  });
});

describe("ExportPanel", () => {
  const renderPanel = (props: Partial<React.ComponentProps<typeof ExportPanel>> = {}) => {
    const onRequest = vi.fn<(kind: string) => void>();
    render(
      withTooltips(
        <ExportPanel
          kinds={exportKinds(null)}
          exports={exportRows}
          labels={exportLabels}
          onRequest={onRequest}
          {...props}
        />,
      ),
    );
    return { onRequest };
  };

  test("one request button per kind; clicking requests that kind", async () => {
    const { onRequest } = renderPanel();
    const buttons = screen.getAllByTestId("export-request");
    expect(buttons.map((b) => attr(b, "data-kind"))).toEqual(["account", "channel"]);
    await userEvent.setup().click(buttons[1] as HTMLElement);
    expect(onRequest).toHaveBeenCalledWith("channel");
  });

  test("during the cooldown the button is disabled and described by its reason", () => {
    renderPanel({ kinds: exportKinds("2026-10-23T09:00:00.000Z") });
    const [account, channel] = screen.getAllByTestId("export-request") as HTMLButtonElement[];
    expect(account?.disabled).toBe(true);
    expect(channel?.disabled).toBe(false);
    const reason = document.getElementById(attr(account as Element, "aria-describedby") ?? "");
    expect(reason?.textContent).toContain("available again");
    expect(attr(reason as Element, "data-cooldown-until")).toBe("2026-10-23T09:00:00.000Z");
  });

  test("rows carry id, kind and status; only a ready export with a URL has a download link", () => {
    renderPanel();
    const rows = screen.getAllByTestId("export-row");
    expect(rows.map((r) => [attr(r, "data-export-id"), attr(r, "data-kind"), attr(r, "data-status")])).toEqual([
      ["e1", "account", "ready"],
      ["e2", "channel", "running"],
    ]);
    const link = within(rows[0] as HTMLElement).getByTestId("export-download");
    expect(link.tagName).toBe("A");
    expect(attr(link, "href")).toBe("#download");
    expect(attr(link, "rel")).toContain("noreferrer");
    expect(within(rows[0] as HTMLElement).getByText("1.5 MB")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByTestId("export-download")).toBeNull();
  });

  test("an expired export with a stale URL shows no link", () => {
    renderPanel({ exports: [{ ...exportRows[0]!, status: "expired", statusLabel: "Expired" }] });
    expect(screen.queryByTestId("export-download")).toBeNull();
  });

  test("empty and loading", () => {
    const { onRequest } = renderPanel({ exports: [] });
    expect(screen.getByTestId("export-empty")).toBeTruthy();
    expect(onRequest).not.toHaveBeenCalled();
  });

  test("a failed request is reported", async () => {
    const onError = vi.fn<(error: unknown) => void>();
    const failure = new Error("RATE_LIMITED");
    renderPanel({ onRequest: () => Promise.reject(failure), onError });
    await userEvent.setup().click(screen.getAllByTestId("export-request")[0] as HTMLElement);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test("tones", () => {
    expect(["queued", "running", "ready", "failed", "expired"].map(exportStatusTone)).toEqual([
      "info",
      "info",
      "success",
      "danger",
      "neutral",
    ]);
  });
});

describe("DeletionPanel", () => {
  const scheduled = { status: "scheduled", statusLabel: "Scheduled", scheduledFor: "2026-11-21T12:00:00.000Z" };
  const renderPanel = (props: Partial<React.ComponentProps<typeof DeletionPanel>> = {}) => {
    const handlers = { onRequest: vi.fn<() => void>(), onCancel: vi.fn<() => void>() };
    render(
      <DeletionPanel request={null} labels={deletionLabels} locale="en" timeZone="UTC" {...handlers} {...props} />,
    );
    return handlers;
  };

  test("request opens a dialog that says what is kept, then calls onRequest", async () => {
    const { onRequest } = renderPanel();
    expect(screen.queryByTestId("deletion-status")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("deletion-request"));
    expect(onRequest).not.toHaveBeenCalled();
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Payments, the ledger, votes");
    await user.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(onRequest).toHaveBeenCalledOnce();
  });

  test("scheduled: status with its date and a cancel; no second request", async () => {
    const { onCancel } = renderPanel({ request: scheduled });
    const status = screen.getByTestId("deletion-status");
    expect(attr(status, "data-status")).toBe("scheduled");
    expect(attr(status, "data-scheduled-for")).toBe("2026-11-21T12:00:00.000Z");
    expect(status.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-21T12:00:00.000Z");
    expect(status.textContent).toContain("November 21, 2026");
    expect(screen.queryByTestId("deletion-request")).toBeNull();
    await userEvent.setup().click(within(status).getByTestId("deletion-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("canceled: no cancel, and the user may request again", () => {
    renderPanel({ request: { ...scheduled, status: "canceled", statusLabel: "Canceled" } });
    expect(attr(screen.getByTestId("deletion-status"), "data-status")).toBe("canceled");
    expect(screen.queryByTestId("deletion-cancel")).toBeNull();
    expect(screen.getByTestId("deletion-request")).toBeTruthy();
  });

  test("loading hides both actions", () => {
    renderPanel({ loading: true });
    expect(screen.queryByTestId("deletion-request")).toBeNull();
    expect(screen.queryByTestId("deletion-status")).toBeNull();
  });

  test("tones", () => {
    expect(["scheduled", "canceled", "completed"].map(deletionStatusTone)).toEqual(["warning", "neutral", "danger"]);
  });
});
