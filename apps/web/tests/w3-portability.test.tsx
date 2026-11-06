// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * W3-portability's web (ADR 0037; docs/testing/b7-selectors.md "Portability"): the move page
 * (create, copy once, revoke behind a confirmation, "moved to" behind a confirmation, the
 * subscriptions note), the import preview's choices and standing badge, the result, the landing
 * page's states, the grants section and the moved notice, at 320 px in dark and light. Plus the
 * pure helpers.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { grantRows, GrantsView } from "../src/components/portability/grants.tsx";
import {
  ImportCard,
  ImportView,
  type ImportClient,
  type ImportViewProps,
} from "../src/components/portability/import-card.tsx";
import { MoveLandingView, type MoveLandingViewProps } from "../src/components/portability/landing.tsx";
import {
  defaultChoices,
  expiresAtFor,
  IMPORT_POLL_MS,
  importErrorReason,
  isChosen,
  isValidMovedTo,
  linkState,
  reasonKey,
  sortLinks,
  standingBadge,
  toggleChoice,
  type ImportDto,
  type ImportItemDto,
  type MoveLinkDto,
} from "../src/components/portability/lib.ts";
import { MovedNotice } from "../src/components/portability/moved-notice.tsx";
import { MovePanel, type MovePanelProps } from "../src/components/portability/move-panel.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", () => ({
  // Rendered as a span carrying where it would go (path and search), for href assertions.
  Link: ({
    children,
    className,
    to,
    search,
    params: _params,
    ...rest
  }: {
    children?: React.ReactNode;
    className?: string;
    to?: string;
    search?: Record<string, string>;
    params?: unknown;
  }) => (
    <span className={className} data-to={`${to ?? ""}?${new URLSearchParams(search ?? {}).toString()}`} {...rest}>
      {children}
    </span>
  ),
}));

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (m: string) => toasts.success.push(m),
    error: (m: string) => toasts.error.push(m),
  },
}));

beforeEach(() => {
  toasts.success.length = 0;
  toasts.error.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const link = (n: number, over: Partial<MoveLinkDto> = {}): MoveLinkDto => ({
  id: `01900000-0000-7000-8000-00000000000${n}`,
  createdAt: new Date(NOW - n * 3_600_000).toISOString(),
  revokedAt: null,
  expiresAt: null,
  conversions: n,
  ...over,
});

function wrap(node: React.ReactNode, theme: "dark" | "light" = "dark") {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <div className={theme === "dark" ? "dark w-80" : "w-80"} data-theme={theme}>
          {node}
        </div>
      </TooltipProvider>
    </LocaleProvider>,
  );
}
const q = (c: ParentNode, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: ParentNode, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const dialog = (id: string) =>
  waitFor(() => {
    const d = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!d) throw new Error(`no dialog ${id}`);
    return d;
  });

function panel(over: Partial<MovePanelProps> = {}, theme: "dark" | "light" = "dark") {
  const fns = {
    onCreate: vi.fn<MovePanelProps["onCreate"]>(async () => {}),
    onCopy: vi.fn<MovePanelProps["onCopy"]>(async () => {}),
    onRevoke: vi.fn<MovePanelProps["onRevoke"]>(async () => {}),
    onSetMovedTo: vi.fn<MovePanelProps["onSetMovedTo"]>(async () => {}),
    onClearMovedTo: vi.fn<MovePanelProps["onClearMovedTo"]>(async () => {}),
    onExport: vi.fn<MovePanelProps["onExport"]>(async () => {}),
  };
  const props: MovePanelProps = {
    links: [link(1), link(2, { revokedAt: new Date(NOW).toISOString() })],
    created: null,
    movedTo: null,
    loadFailed: false,
    nowMs: NOW,
    ...fns,
    ...over,
  };
  return { ...wrap(<MovePanel {...props} />, theme), fns };
}

describe("the move page", () => {
  it("lists links with their state and conversions; create passes the expiry", async () => {
    const { container, fns } = panel();
    expect(q(container, "move-page")).not.toBeNull();
    const rows = qa(container, "move-link");
    expect(rows.map((r) => [r.dataset.state, r.dataset.conversions])).toEqual([
      ["active", "1"],
      ["revoked", "2"],
    ]);
    // Only an active link can be revoked.
    expect(qa(container, "move-link-revoke")).toHaveLength(1);
    expect(q(container, "move-link-expiry")?.dataset.value).toBe("never");
    fireEvent.click(q(container, "move-link-create")!);
    await waitFor(() => expect(fns.onCreate).toHaveBeenCalledWith("never"));
    expect(q(container, "move-link-new")).toBeNull();
  });

  it("shows a new link once, with a copy button", () => {
    const url = "https://tv.example/m/ada/abcdefghijklmnopqrstuv";
    const { container, fns } = panel({ created: { id: link(1).id, url } });
    expect(q(container, "move-link-new")?.dataset.url).toBe(url);
    fireEvent.click(q(container, "move-link-copy")!);
    expect(fns.onCopy).toHaveBeenCalledWith(url);
  });

  it("revoke asks first", async () => {
    const { container, fns } = panel();
    fireEvent.click(q(container, "move-link-revoke")!);
    const d = await dialog("move-link-revoke-confirm");
    expect(fns.onRevoke).not.toHaveBeenCalled();
    fireEvent.click(q(d, "confirm-dialog-confirm")!);
    await waitFor(() => expect(fns.onRevoke).toHaveBeenCalledWith(link(1).id));
  });

  it("an empty list shows an empty state", () => {
    const { container } = panel({ links: [] });
    expect(qa(container, "move-link")).toHaveLength(0);
    expect(container.textContent).toContain(t("portability.links.empty"));
  });

  it("moved to: only an https address enables save; it asks first; clear and the subscriptions note", async () => {
    const { container, fns } = panel({ movedTo: { url: "https://old.example/x", at: new Date(NOW).toISOString() } });
    expect(q(container, "move-subscriptions-note")?.textContent).toBe(t("portability.moved.subscriptions"));
    // The card's hint size, not a larger body size (F35).
    expect(q(container, "move-subscriptions-note")?.dataset.slot).toBe("field-description");
    expect(q(container, "move-to-current")?.dataset.url).toBe("https://old.example/x");
    const input = q(container, "move-to-url") as HTMLInputElement;
    const save = q(container, "move-to-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "http://new.example" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "https://new.example/me" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const d = await dialog("move-to-confirm");
    expect(d.textContent).toContain("https://new.example/me");
    fireEvent.click(q(d, "confirm-dialog-confirm")!);
    await waitFor(() => expect(fns.onSetMovedTo).toHaveBeenCalledWith("https://new.example/me"));
    fireEvent.click(q(container, "move-to-clear")!);
    await waitFor(() => expect(document.querySelectorAll('[data-testid="confirm-dialog-confirm"]').length).toBe(1));
    fireEvent.click(document.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    await waitFor(() => expect(fns.onClearMovedTo).toHaveBeenCalledOnce());
  });

  it("requests the bundle export", async () => {
    const { container, fns } = panel();
    fireEvent.click(q(container, "bundle-export")!);
    await waitFor(() => expect(fns.onExport).toHaveBeenCalledOnce());
  });

  it("picking an expiry changes the select and is what create sends", async () => {
    const { container, fns } = panel();
    fireEvent.click(q(container, "move-link-expiry")!);
    const option = await screen.findByRole("option", { name: t("portability.links.expiry.days30") });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(q(container, "move-link-expiry")?.dataset.value).toBe("30"));
    fireEvent.click(q(container, "move-link-create")!);
    await waitFor(() => expect(fns.onCreate).toHaveBeenCalledWith("30"));
  });

  it("create is busy until its call settles, then usable again", async () => {
    let done: () => void = () => undefined;
    const { container } = panel({ onCreate: () => new Promise<void>((r) => (done = r)) });
    const create = q(container, "move-link-create") as HTMLButtonElement;
    fireEvent.click(create);
    await waitFor(() => expect(create.disabled).toBe(true));
    expect(create.getAttribute("aria-busy")).toBe("true");
    await act(async () => done());
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(create.getAttribute("aria-busy")).toBeNull();
  });

  it("an invalid moved-to address is marked only once the field was left, with the message", () => {
    const { container } = panel();
    const input = q(container, "move-to-url") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not a url" } });
    // Still typing: no error yet.
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).not.toContain(t("portability.moved.invalid"));
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain(t("portability.moved.invalid"));
    fireEvent.change(input, { target: { value: "https://new.example/me" } });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).not.toContain(t("portability.moved.invalid"));
    // Emptied after leaving: invalid for saving, but no message to nag with.
    fireEvent.change(input, { target: { value: "" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).not.toContain(t("portability.moved.invalid"));
  });

  it("a failed load says so above the cards", () => {
    const { container } = panel({ loadFailed: true });
    expect(container.textContent).toContain(t("portability.loadFailed"));
  });

  for (const theme of ["dark", "light"] as const)
    it(`fits a 320 px column (${theme})`, () => {
      const { container } = panel(
        { created: { id: link(1).id, url: `https://tv.example/m/a/${"x".repeat(22)}` }, movedTo: null },
        theme,
      );
      expect(container.innerHTML).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d|\bw-(96|112|128)\b/);
      expect(q(container, "move-page")?.className).toContain("min-w-0");
      expect(container.querySelector(`[data-theme="${theme}"]`)).not.toBeNull();
    });
});

const item = (kind: ImportItemDto["kind"], ref: string, over: Partial<ImportItemDto> = {}): ImportItemDto => ({
  kind,
  ref,
  label: ref,
  outcome: null,
  reason: null,
  ...over,
});
const previewDto = (over: Partial<ImportDto> = {}): ImportDto => ({
  id: "01900000-0000-7000-8000-0000000000f1",
  source: "commonair",
  status: "previewed",
  standingVerified: true,
  standingIssuer: "https://old.example",
  preview: {
    channel: { state: "ready", title: "Night owls" },
    items: [
      item("channel", "channel", { label: "Night owls" }),
      item("panel", "1", { label: "About" }),
      item("emote", "wave"),
      item("emote", "clash", { outcome: "skipped", reason: "code_taken" }),
      item("schedule", "schedule", { label: "2", outcome: "skipped", reason: "carried_not_applied" }),
    ],
  },
  result: null,
  assertedAt: null,
  createdAt: new Date(NOW).toISOString(),
  finishedAt: null,
  ...over,
});

function importView(over: Partial<ImportViewProps> = {}) {
  const fns = {
    onFile: vi.fn<ImportViewProps["onFile"]>(),
    onToggle: vi.fn<ImportViewProps["onToggle"]>(),
    onAssert: vi.fn<ImportViewProps["onAssert"]>(),
    onStart: vi.fn<ImportViewProps["onStart"]>(),
    onReset: vi.fn<ImportViewProps["onReset"]>(),
  };
  const dto = previewDto();
  const props: ImportViewProps = {
    phase: { kind: "preview", dto },
    choices: defaultChoices(dto.preview.items),
    asserted: false,
    ...fns,
    ...over,
  };
  return { ...wrap(<ImportView {...props} />), fns };
}

describe("the import", () => {
  it("idle: a file picker", () => {
    const { container } = importView({ phase: { kind: "idle" } });
    expect((q(container, "bundle-import-file") as HTMLInputElement).type).toBe("file");
    expect(q(container, "bundle-import-preview")).toBeNull();
  });

  it("preview: the standing badge, items on by default, known skips off and disabled", () => {
    const { container, fns } = importView();
    const p = q(container, "bundle-import-preview")!;
    expect(p.dataset.importId).toBe(previewDto().id);
    expect(q(container, "bundle-import-standing")?.dataset.state).toBe("verified");
    const items = qa(container, "bundle-import-item").map((i) => [
      i.dataset.kind,
      i.dataset.ref,
      q(i, "bundle-import-item-toggle")?.dataset.state,
    ]);
    expect(items).toEqual([
      ["channel", "channel", "on"],
      ["panel", "1", "on"],
      ["emote", "wave", "on"],
      ["emote", "clash", "off"],
      ["schedule", "schedule", "off"],
    ]);
    expect(p.textContent).toContain(t("portability.reason.codeTaken"));
    expect(p.textContent).toContain(t("portability.reason.carriedNotApplied"));
    // Emotes are chosen: start waits for the rights assertion.
    expect((q(container, "bundle-import-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(q(container, "bundle-import-item-toggle")!);
    expect(fns.onToggle).toHaveBeenCalledWith(previewDto().preview.items[0]);
  });

  it("start is enabled once the assertion is given, or when no emote is chosen", () => {
    const dto = previewDto();
    const asserted = importView({ asserted: true });
    fireEvent.click(q(asserted.container, "bundle-import-start")!);
    expect(asserted.fns.onStart).toHaveBeenCalledOnce();
    cleanup();
    const noEmotes = importView({ choices: { ...defaultChoices(dto.preview.items), emotes: [] } });
    expect((q(noEmotes.container, "bundle-import-start") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an unverified statement says so", () => {
    const { container } = importView({ phase: { kind: "preview", dto: previewDto({ standingVerified: false }) } });
    expect(q(container, "bundle-import-standing")?.dataset.state).toBe("unverified");
    expect(container.textContent).toContain(t("portability.import.standing.unverifiedHint"));
  });

  it("a bundle refused by its standing shows the refused badge and the reason", () => {
    const { container } = importView({ phase: { kind: "refused", reason: "standing_suspended" } });
    expect(q(container, "bundle-import-standing")?.dataset.state).toBe("refused");
    expect(container.textContent).toContain(t("portability.reason.standingSuspended"));
    cleanup();
    const bad = importView({ phase: { kind: "refused", reason: "bundle_hash_mismatch" } });
    expect(q(bad.container, "bundle-import-standing")).toBeNull();
    expect(bad.container.textContent).toContain(t("portability.reason.badBundle"));
  });

  it("the result lists every item's outcome and reason", () => {
    const dto = previewDto({
      status: "done",
      result: [
        item("channel", "channel", { outcome: "imported" }),
        item("emote", "wave", { outcome: "imported" }),
        item("emote", "clash", { outcome: "skipped", reason: "code_taken" }),
        item("emote", "bad", { outcome: "rejected", reason: "upload_rejected" }),
      ],
    });
    const { container } = importView({ phase: { kind: "applying", dto } });
    expect(q(container, "bundle-import-result")?.dataset.status).toBe("done");
    expect(
      qa(container, "bundle-import-result-item").map((i) => [i.dataset.ref, i.dataset.outcome, i.dataset.reason]),
    ).toEqual([
      ["channel", "imported", ""],
      ["wave", "imported", ""],
      ["clash", "skipped", "code_taken"],
      ["bad", "rejected", "upload_rejected"],
    ]);
  });

  it("the card uploads, previews and starts with the chosen items", async () => {
    const dto = previewDto();
    const upload = vi.fn<ImportClient["upload"]>(async () => ({
      key: "incoming/portability/x/y.zip",
      uploadUrl: "https://s3.test/put",
      headers: {},
    }));
    const preview = vi.fn<ImportClient["preview"]>(async () => dto);
    const start = vi.fn<ImportClient["start"]>(async () => ({ ...dto, status: "queued" as const }));
    const client: ImportClient = {
      upload,
      put: vi.fn<ImportClient["put"]>(async () => ({ ok: true })),
      preview,
      start,
      get: vi.fn<ImportClient["get"]>(async () => ({ ...dto, status: "done" as const, result: [] })),
    };
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], "bundle.zip", { type: "application/zip" });
    fireEvent.change(q(container, "bundle-import-file")!, { target: { files: [file] } });
    await waitFor(() => expect(q(container, "bundle-import-preview")).not.toBeNull());
    expect(upload).toHaveBeenCalledWith({ channel: "ada", sizeBytes: 4 });
    expect(preview).toHaveBeenCalledWith({ channel: "ada", key: "incoming/portability/x/y.zip" });
    // Turn the emote off: no assertion is needed then.
    const wave = qa(container, "bundle-import-item").find((i) => i.dataset.ref === "wave")!;
    fireEvent.click(q(wave, "bundle-import-item-toggle")!);
    await waitFor(() => expect((q(container, "bundle-import-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(q(container, "bundle-import-start")!);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        channel: "ada",
        id: dto.id,
        choices: { channel: true, panels: true, emotes: [] },
        assertEmoteRights: false,
      }),
    );
    await waitFor(() => expect(q(container, "bundle-import-result")?.dataset.status).toBe("queued"));
  });

  it("a refused preview from the API shows its reason", async () => {
    const client: ImportClient = {
      upload: vi.fn<ImportClient["upload"]>(async () => ({ key: "k", uploadUrl: "https://s3.test/put", headers: {} })),
      put: vi.fn<ImportClient["put"]>(async () => ({ ok: true })),
      preview: vi.fn<ImportClient["preview"]>(async () => {
        throw Object.assign(new Error("refused"), { code: "BAD_REQUEST", data: { reason: "standing_legal_hold" } });
      }),
      start: vi.fn<ImportClient["start"]>(),
      get: vi.fn<ImportClient["get"]>(),
    };
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    const file = new File([new Uint8Array([1])], "b.zip", { type: "application/zip" });
    fireEvent.change(q(container, "bundle-import-file")!, { target: { files: [file] } });
    await waitFor(() => expect(q(container, "bundle-import-standing")?.dataset.state).toBe("refused"));
    expect(container.textContent).toContain(t("portability.reason.standingLegalHold"));
  });
});

function fakeImportClient(over: Partial<ImportClient> = {}) {
  const dto = previewDto();
  const upload = vi.fn<ImportClient["upload"]>(async () => ({
    key: "k",
    uploadUrl: "https://s3.test/put",
    headers: {},
  }));
  const client: ImportClient = {
    upload,
    put: vi.fn<ImportClient["put"]>(async () => ({ ok: true })),
    preview: vi.fn<ImportClient["preview"]>(async () => dto),
    start: vi.fn<ImportClient["start"]>(async () => ({ ...dto, status: "running" as const })),
    get: vi.fn<ImportClient["get"]>(async () => dto),
    ...over,
  };
  return client;
}
const zip = (bytes = 4) => new File([new Uint8Array(bytes)], "bundle.zip", { type: "application/zip" });
function pick(container: HTMLElement, file: File) {
  fireEvent.change(q(container, "bundle-import-file")!, { target: { files: [file] } });
}
/** Runs `ms` of fake intervals and lets the answers they asked for land. */
const poll = (ms = IMPORT_POLL_MS) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("the import view's states", () => {
  it("uploading: the picker is disabled and the button says it is reading", () => {
    const { container } = importView({ phase: { kind: "uploading" } });
    expect((q(container, "bundle-import-file") as HTMLInputElement).disabled).toBe(true);
    const button = screen.getByRole("button", { name: t("portability.import.reading") }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("the choose button opens the hidden picker", () => {
    const { container } = importView({ phase: { kind: "idle" } });
    const input = q(container, "bundle-import-file") as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: t("portability.import.choose") }));
    expect(click).toHaveBeenCalledOnce();
  });

  it("an emptied picker (cancelled) reports no file", () => {
    const { container, fns } = importView({ phase: { kind: "idle" } });
    fireEvent.change(q(container, "bundle-import-file")!, { target: { files: [] } });
    expect(fns.onFile).not.toHaveBeenCalled();
  });

  it("verified shows the issuer; schedule items read as a count; an empty label is untitled", () => {
    const dto = previewDto({
      preview: {
        channel: { state: "ready", title: "Night owls" },
        items: [item("panel", "9", { label: "" }), item("schedule", "schedule", { label: "3" })],
      },
    });
    const { container } = importView({ phase: { kind: "preview", dto }, choices: defaultChoices(dto.preview.items) });
    expect(container.textContent).toContain(t("portability.import.standing.issuer", { issuer: "https://old.example" }));
    expect(container.textContent).not.toContain(t("portability.import.standing.unverifiedHint"));
    expect(container.textContent).toContain(t("portability.import.untitled"));
    expect(container.textContent).toContain(t("portability.import.scheduleCount", { count: 3 }));
    // No emote chosen: no rights assertion to give.
    expect(q(container, "bundle-import-assert")).toBeNull();
  });

  it("a pending preview says it is still reading and cannot start; nothing chosen cannot start either", () => {
    const pending = previewDto({ preview: { channel: { state: "pending", title: null }, items: [] } });
    const a = importView({ phase: { kind: "preview", dto: pending } });
    expect(a.container.textContent).toContain(t("portability.import.pending"));
    expect(qa(a.container, "bundle-import-item")).toHaveLength(0);
    expect((q(a.container, "bundle-import-start") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const b = importView({ choices: { channel: false, panels: false, emotes: [] } });
    expect((q(b.container, "bundle-import-start") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the rights checkbox reports its state; cancel resets", () => {
    const { container, fns } = importView();
    fireEvent.click(q(container, "bundle-import-assert")!);
    expect(fns.onAssert).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: t("portability.import.cancel") }));
    expect(fns.onReset).toHaveBeenCalledOnce();
  });

  it("running: says so, with no result list and no way out yet; failed says so and offers another", () => {
    const running = importView({ phase: { kind: "applying", dto: previewDto({ status: "running" }) } });
    expect(q(running.container, "bundle-import-result")?.textContent).toContain(t("portability.import.running"));
    expect(qa(running.container, "bundle-import-result-item")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: t("portability.import.another") })).toBeNull();
    cleanup();
    const failed = importView({
      phase: { kind: "applying", dto: previewDto({ status: "failed", result: null }) },
    });
    expect(failed.container.textContent).toContain(t("portability.import.failed"));
    fireEvent.click(screen.getByRole("button", { name: t("portability.import.another") }));
    expect(failed.fns.onReset).toHaveBeenCalledOnce();
  });
});

describe("the import card", () => {
  it("an empty or oversized file is refused before any upload", async () => {
    const upload = vi.fn<ImportClient["upload"]>();
    const client = fakeImportClient({ upload });
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    pick(container, new File([], "empty.zip", { type: "application/zip" }));
    await waitFor(() => expect(container.textContent).toContain(t(reasonKey("bundle_archive_too_large")!)));
    const big = zip(1);
    Object.defineProperty(big, "size", { value: PORTABILITY_LIMITS.maxArchiveBytes + 1 });
    pick(container, big);
    await waitFor(() => expect(container.textContent).toContain(t(reasonKey("bundle_archive_too_large")!)));
    expect(upload).not.toHaveBeenCalled();
    // A size refusal is not a standing refusal: no badge.
    expect(q(container, "bundle-import-standing")).toBeNull();
  });

  it("a failed upload goes back to the picker with a toast; an expired session asks to sign in", async () => {
    const preview = vi.fn<ImportClient["preview"]>();
    const client = fakeImportClient({ put: vi.fn<ImportClient["put"]>(async () => ({ ok: false })), preview });
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    pick(container, zip());
    await waitFor(() => expect(toasts.error).toEqual([t("portability.import.uploadFailed")]));
    expect(preview).not.toHaveBeenCalled();
    expect(q(container, "bundle-import-file")).not.toBeNull();
    expect((q(container, "bundle-import-file") as HTMLInputElement).disabled).toBe(false);
    cleanup();
    toasts.error.length = 0;
    const put = vi.fn<ImportClient["put"]>();
    const expired = fakeImportClient({
      put,
      upload: vi.fn<ImportClient["upload"]>(async () => {
        throw Object.assign(new Error("gone"), { code: "UNAUTHORIZED" });
      }),
    });
    const second = wrap(<ImportCard channel="ada" client={expired} />);
    pick(second.container, zip());
    await waitFor(() => expect(toasts.error).toEqual([t("auth.sessionExpired")]));
    expect(put).not.toHaveBeenCalled();
  });

  it("start refused for the rights assertion says so; another failure says start failed; the preview stays", async () => {
    const start = vi
      .fn<ImportClient["start"]>()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { code: "PRECONDITION_FAILED" }))
      .mockRejectedValueOnce(new Error("down"));
    const client = fakeImportClient({ start });
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    pick(container, zip());
    await waitFor(() => expect(q(container, "bundle-import-assert")).not.toBeNull());
    fireEvent.click(q(container, "bundle-import-assert")!);
    await waitFor(() => expect((q(container, "bundle-import-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(q(container, "bundle-import-start")!);
    await waitFor(() => expect(toasts.error).toEqual([t("portability.import.assertNeeded")]));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ assertEmoteRights: true }));
    fireEvent.click(q(container, "bundle-import-start")!);
    await waitFor(() =>
      expect(toasts.error).toEqual([t("portability.import.assertNeeded"), t("portability.import.startFailed")]),
    );
    expect(q(container, "bundle-import-preview")).not.toBeNull();
    expect(toasts.success).toEqual([]);
  });

  it("follows a running import until it is done, toasts the start, and resets for another", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dto = previewDto();
    const get = vi
      .fn<ImportClient["get"]>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ ...dto, status: "running" })
      .mockResolvedValue({ ...dto, status: "done", result: [item("channel", "channel", { outcome: "imported" })] });
    const client = fakeImportClient({ get });
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    pick(container, zip());
    await poll(0);
    expect(q(container, "bundle-import-preview")).not.toBeNull();
    // A ready preview is not followed.
    await poll(IMPORT_POLL_MS * 2);
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(q(container, "bundle-import-assert")!);
    fireEvent.click(q(container, "bundle-import-start")!);
    await poll(0);
    expect(toasts.success).toEqual([t("portability.import.started")]);
    expect(q(container, "bundle-import-result")?.dataset.status).toBe("running");
    // A failed poll is ignored; the next ones bring it to done.
    await poll();
    expect(q(container, "bundle-import-result")?.dataset.status).toBe("running");
    await poll();
    await poll();
    expect(q(container, "bundle-import-result")?.dataset.status).toBe("done");
    expect(get).toHaveBeenCalledWith({ channel: "ada", id: dto.id });
    const calls = get.mock.calls.length;
    await poll(IMPORT_POLL_MS * 3);
    expect(get.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByRole("button", { name: t("portability.import.another") }));
    expect(q(container, "bundle-import-file")).not.toBeNull();
  });

  it("follows a pending preview until it is ready, or until its standing refuses it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = previewDto({ preview: { channel: { state: "pending", title: null }, items: [] } });
    const ready = previewDto();
    const client = fakeImportClient({
      preview: vi.fn<ImportClient["preview"]>(async () => pending),
      get: vi.fn<ImportClient["get"]>(async () => ready),
    });
    const { container } = wrap(<ImportCard channel="ada" client={client} />);
    pick(container, zip());
    await poll(0);
    expect(container.textContent).toContain(t("portability.import.pending"));
    await poll();
    expect(qa(container, "bundle-import-item")).toHaveLength(ready.preview.items.length);
    expect(container.textContent).not.toContain(t("portability.import.pending"));
    cleanup();

    const refused = previewDto({
      status: "failed",
      preview: { channel: { state: "refused", title: null }, items: [] },
      result: [item("channel", "channel", { outcome: "rejected", reason: "standing_suspended" })],
    });
    const second = fakeImportClient({
      preview: vi.fn<ImportClient["preview"]>(async () => pending),
      get: vi.fn<ImportClient["get"]>(async () => refused),
    });
    const view = wrap(<ImportCard channel="ada" client={second} />);
    pick(view.container, zip());
    await poll(0);
    await poll();
    expect(q(view.container, "bundle-import-standing")?.dataset.state).toBe("refused");
    expect(view.container.textContent).toContain(t("portability.reason.standingSuspended"));
    cleanup();

    // A refusal without a reason still refuses, in general words.
    const bare = fakeImportClient({
      preview: vi.fn<ImportClient["preview"]>(async () => pending),
      get: vi.fn<ImportClient["get"]>(async () => ({ ...refused, result: null })),
    });
    const third = wrap(<ImportCard channel="ada" client={bare} />);
    pick(third.container, zip());
    await poll(0);
    await poll();
    expect(third.container.textContent).toContain(t(reasonKey("refused") ?? "portability.reason.other"));
    expect(q(third.container, "bundle-import-preview")).toBeNull();
  });
});

function landing(over: Partial<MoveLandingViewProps> = {}) {
  const onFollow = vi.fn<MoveLandingViewProps["onFollow"]>();
  const props: MoveLandingViewProps = {
    state: "active",
    channel: { slug: "ada", displayName: "Ada", avatarUrl: null, title: "Night owls", followerCount: 12 },
    signedIn: true,
    returnTo: "/m/ada/AAAAAAAAAAAAAAAAAAAAAA",
    following: false,
    pending: false,
    loadFailed: false,
    onFollow,
    ...over,
  };
  return { ...wrap(<MoveLandingView {...props} />), onFollow };
}

describe("the landing page", () => {
  it("active: the channel card and a follow button", () => {
    const { container, onFollow } = landing();
    expect(q(container, "move-landing")?.dataset.state).toBe("active");
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).toContain("Night owls");
    fireEvent.click(q(container, "move-landing-follow")!);
    expect(onFollow).toHaveBeenCalledOnce();
  });

  it("signed out: sign-in comes back to this link, so the follow is still attributed", () => {
    const { container } = landing({ signedIn: false });
    const a = q(container, "move-landing-follow");
    const href = new URL(a?.dataset.to ?? "", "http://x");
    expect(href.pathname).toBe("/signin");
    expect(href.searchParams.get("returnTo")).toBe("/m/ada/AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("following: the button says so and does nothing", () => {
    const { container } = landing({ following: true });
    const b = q(container, "move-landing-follow") as HTMLButtonElement;
    expect(b.dataset.following).toBe("true");
    expect(b.disabled).toBe(true);
  });

  it.each([
    ["revoked", "revoked", "portability.landing.gone"],
    ["expired", "expired", "portability.landing.expired"],
    ["unknown", "revoked", "portability.landing.gone"],
  ] as const)("%s: an empty state", (state, shown, key) => {
    const known = { slug: "ada", displayName: "Ada", avatarUrl: null, title: "", followerCount: 1 };
    const { container } = landing({ state, channel: state === "unknown" ? null : known });
    expect(q(container, "move-landing")?.dataset.state).toBe(shown);
    expect(q(container, "move-landing-gone")?.textContent).toContain(t(key));
    expect(q(container, "move-landing-follow")).toBeNull();
    // A known channel is still one click away.
    expect(container.textContent?.includes(t("portability.landing.visit", { channel: "Ada" }))).toBe(
      state !== "unknown",
    );
  });
});

describe("grants and the notice", () => {
  it("one row per followed channel, a switch per row", () => {
    const rows = grantRows(
      [
        { slug: "bea", displayName: "Bea", avatarUrl: null },
        { slug: "ada", displayName: "Ada", avatarUrl: null },
      ],
      [{ slug: "ada", displayName: "Ada", avatarUrl: null }],
    );
    const onToggle = vi.fn<(slug: string, on: boolean) => void>();
    const { container } = wrap(<GrantsView rows={rows} loadFailed={false} busy={new Set()} onToggle={onToggle} />);
    expect(q(container, "portability-grants")).not.toBeNull();
    expect(qa(container, "portability-grant").map((r) => [r.dataset.channel, r.dataset.state])).toEqual([
      ["ada", "on"],
      ["bea", "off"],
    ]);
    fireEvent.click(qa(container, "portability-grant-toggle")[1]!);
    expect(onToggle).toHaveBeenCalledWith("bea", true);
  });

  it("no follows: an empty state", () => {
    const { container } = wrap(
      <GrantsView
        rows={[]}
        loadFailed={false}
        busy={new Set()}
        onToggle={vi.fn<(slug: string, on: boolean) => void>()}
      />,
    );
    expect(container.textContent).toContain(t("portability.grants.empty"));
  });

  it("the moved notice: the address, opened without a referrer, and nothing when not moved", () => {
    const { container } = wrap(
      <MovedNotice
        channelName="Ada"
        movedTo={{ url: "https://video.example.org/ada", at: new Date(NOW).toISOString() }}
      />,
    );
    const n = q(container, "moved-notice")!;
    expect(n.dataset.url).toBe("https://video.example.org/ada");
    const a = n.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://video.example.org/ada");
    expect(a.getAttribute("rel")).toContain("noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(n.textContent).toContain(t("portability.notice.subscriptions"));
    cleanup();
    const none = wrap(<MovedNotice channelName="Ada" movedTo={null} />);
    expect(q(none.container, "moved-notice")).toBeNull();
  });
});

describe("helpers", () => {
  it("link state, ordering and expiry", () => {
    expect(linkState(link(1), NOW)).toBe("active");
    expect(linkState(link(1, { expiresAt: new Date(NOW).toISOString() }), NOW)).toBe("expired");
    expect(
      linkState(link(1, { revokedAt: new Date(NOW).toISOString(), expiresAt: new Date(0).toISOString() }), NOW),
    ).toBe("revoked");
    const sorted = sortLinks([link(3, { revokedAt: new Date(NOW).toISOString() }), link(2), link(1)], NOW);
    expect(sorted.map((l) => l.conversions)).toEqual([1, 2, 3]);
    expect(expiresAtFor("never", NOW)).toBeNull();
    expect(expiresAtFor("7", NOW)).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
  });

  it("the moved-to check matches the API's", () => {
    expect(isValidMovedTo("https://new.example/me")).toBe(true);
    expect(isValidMovedTo("  https://new.example/me  ")).toBe(true);
    for (const bad of ["", "http://x.example", "https://u:p@x.example", "nope", `https://e.org/${"a".repeat(500)}`])
      expect(isValidMovedTo(bad)).toBe(false);
  });

  it("choices: defaults, toggling, panels as one", () => {
    const items = previewDto().preview.items;
    const c = defaultChoices(items);
    expect(c).toEqual({ channel: true, panels: true, emotes: ["wave"] });
    expect(isChosen(c, items[3]!)).toBe(false);
    const off = toggleChoice(toggleChoice(c, items[2]!), items[1]!);
    expect(off).toEqual({ channel: true, panels: false, emotes: [] });
    expect(toggleChoice(off, items[4]!)).toBe(off);
  });

  it("standing badge, error reasons and reason messages", () => {
    expect(standingBadge({ standingVerified: true, status: "previewed" }, false)).toBe("verified");
    expect(standingBadge({ standingVerified: false, status: "previewed" }, false)).toBe("unverified");
    expect(standingBadge({ standingVerified: null, status: "previewed" }, true)).toBe("refused");
    expect(importErrorReason({ data: { reason: "standing_suspended" } })).toBe("standing_suspended");
    expect(importErrorReason(new Error("x"))).toBeNull();
    expect(reasonKey("bundle_unsafe_path")).toBe("portability.reason.badBundle");
    expect(reasonKey("code_taken")).toBe("portability.reason.codeTaken");
    expect(reasonKey("nothing_to_apply")).toBe("portability.reason.nothingToApply");
    expect(reasonKey("something_new")).toBe("portability.reason.other");
    expect(reasonKey(null)).toBeNull();
  });
});
