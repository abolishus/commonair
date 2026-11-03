// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * N3-import's web (ADR 0031; docs/testing/b7-selectors.md "Twitch import"): the unavailable state,
 * connect, the preview's choices (channel details, emotes with their tier or skip reason, the
 * schedule carried, the mature suggestion), the art assertion required for emotes, progress and
 * result, and the panel paste-in helper's live preview and save, at 320 px in dark and light. Plus
 * the pure helpers.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { EMOTE_ASSERTION_VERSION } from "@commonair/twitch";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  TwitchImportPage,
  TwitchImportView,
  type TwitchImportClient,
  type TwitchImportViewProps,
} from "../src/components/twitch-import/import-page.tsx";
import {
  canStart,
  defaultChoices,
  parseOutcome,
  previewFields,
  reasonKey,
  tierKey,
  toggleEmote,
  type TwitchImportDto,
  type TwitchImportStatusDto,
} from "../src/components/twitch-import/lib.ts";
import { PanelsPaste, PanelsPasteView, type PanelsClient } from "../src/components/twitch-import/panels-paste.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(() => cleanup());

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
const checkbox = (c: ParentNode) => c.querySelector<HTMLElement>('[role="checkbox"]');
const dialog = (id: string) =>
  waitFor(() => {
    const d = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!d) throw new Error(`no dialog ${id}`);
    return d;
  });

const EXPIRES = new Date(Date.now() + 50 * 60_000).toISOString();
const preview = (over: Partial<TwitchImportDto> = {}, channel: Record<string, unknown> = {}): TwitchImportDto => ({
  id: "01900000-0000-7000-8000-0000000000aa",
  source: "twitch",
  status: "previewed",
  preview: {
    channel: {
      state: "ready",
      twitchLogin: "pixelgardener",
      title: "Planting sprites",
      description: "Cozy streams",
      tags: ["pixelart", "cozy"],
      language: "en",
      category: "Pixel Art Gardening",
      matureSuggested: true,
      schedule: [{ startsAt: "2026-11-03T18:00:00Z", endsAt: null, title: "Seed swap", category: null }],
      emotes: [
        { code: "pgWave", tier: 1 },
        { code: "pgHi", tier: 0 },
        { code: "pgBits", tier: null },
      ],
      expiresAt: EXPIRES,
      ...channel,
    },
    items: [
      { kind: "channel", ref: "channel", label: "Planting sprites", outcome: null, reason: null },
      { kind: "emote", ref: "pgWave", label: "pgWave", outcome: null, reason: null },
      { kind: "emote", ref: "pgHi", label: "pgHi", outcome: null, reason: null },
      { kind: "emote", ref: "pgBits", label: "pgBits", outcome: "skipped", reason: "bits_emote" },
      { kind: "schedule", ref: "schedule", label: "1", outcome: "skipped", reason: "carried_not_applied" },
    ],
  },
  result: null,
  assertedAt: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  ...over,
});
const status = (over: Partial<TwitchImportStatusDto> = {}): TwitchImportStatusDto => ({
  available: true,
  connected: true,
  twitchLogin: "pixelgardener",
  latest: preview(),
  ...over,
});

function view(over: Partial<TwitchImportViewProps> = {}, theme: "dark" | "light" = "dark") {
  const fns = {
    onConnect: vi.fn<TwitchImportViewProps["onConnect"]>(),
    onToggleChannel: vi.fn<TwitchImportViewProps["onToggleChannel"]>(),
    onToggleField: vi.fn<TwitchImportViewProps["onToggleField"]>(),
    onToggleEmote: vi.fn<TwitchImportViewProps["onToggleEmote"]>(),
    onAssert: vi.fn<TwitchImportViewProps["onAssert"]>(),
    onStart: vi.fn<TwitchImportViewProps["onStart"]>(),
  };
  const s = over.status === undefined ? status() : over.status;
  const props: TwitchImportViewProps = {
    status: s,
    loadFailed: false,
    outcome: null,
    choices: s?.latest ? defaultChoices(s.latest.preview.items) : { channel: false, emotes: [] },
    asserted: false,
    connecting: false,
    starting: false,
    ...fns,
    ...over,
  };
  return { ...wrap(<TwitchImportView {...props} />, theme), fns };
}

describe("the unavailable state", () => {
  it("explains, with no connect button and no Twitch branding beyond the name", () => {
    for (const theme of ["dark", "light"] as const) {
      const { container } = view({ status: status({ available: false, connected: false, latest: null }) }, theme);
      expect(q(container, "import-page")).not.toBeNull();
      const u = q(container, "import-unavailable")!;
      expect(u.textContent).toContain(t("twitchImport.unavailable.title"));
      expect(q(container, "import-connect")).toBeNull();
      expect(q(container, "import-panels-paste")).toBeNull();
      expect(container.querySelector("img")).toBeNull();
      cleanup();
    }
  });

  it("while loading: a skeleton, not the unavailable state", () => {
    const { container } = view({ status: null });
    expect(q(container, "import-unavailable")).toBeNull();
    expect(container.querySelector('[data-slot="skeleton-group"], [aria-busy="true"], [role="status"]')).not.toBeNull();
  });
});

describe("connect", () => {
  it("not connected yet: the connect button", () => {
    const { container, fns } = view({ status: status({ connected: false, twitchLogin: null, latest: null }) });
    fireEvent.click(q(container, "import-connect")!);
    expect(fns.onConnect).toHaveBeenCalledOnce();
    expect(q(container, "import-preview")).toBeNull();
  });

  it("shows the authorization's outcome", () => {
    const { container } = view({ outcome: "mismatch", status: status({ latest: null, connected: false }) });
    expect(container.textContent).toContain(t("twitchImport.outcome.mismatch"));
  });

  it("an expired preview asks to connect again", () => {
    const { container } = view({ status: status({ connected: false, latest: preview({}, { state: "expired" }) }) });
    expect(q(container, "import-preview")).toBeNull();
    expect(container.textContent).toContain(t("twitchImport.preview.expired"));
    expect(q(container, "import-connect")?.textContent).toBe(t("twitchImport.connect.again"));
  });
});

describe("the preview", () => {
  it("the fields, the emotes with tier and skip reason, the schedule carried, the mature suggestion", () => {
    for (const theme of ["dark", "light"] as const) {
      const { container } = view({}, theme);
      const p = q(container, "import-preview")!;
      expect(p.dataset.importId).toBe(preview().id);
      expect(p.dataset.expiresAt).toBe(EXPIRES);
      const field = q(container, "import-field")!;
      expect([field.dataset.field, field.dataset.state]).toEqual(["channel", "on"]);
      expect(field.textContent).toContain("Planting sprites");
      expect(field.textContent).toContain("Pixel Art Gardening");
      expect(field.textContent).toContain("pixelart, cozy");
      expect(qa(container, "import-emote").map((e) => [e.dataset.code, e.dataset.tier, e.dataset.skipReason])).toEqual([
        ["pgWave", "1", ""],
        ["pgHi", "0", ""],
        ["pgBits", "", "bits_emote"],
      ]);
      expect(p.textContent).toContain(t("twitchImport.reason.bitsEmote"));
      expect(p.textContent).toContain(t("twitchImport.emotes.tierFollower"));
      const sched = q(container, "import-schedule")!;
      expect(sched.dataset.count).toBe("1");
      expect(sched.textContent).toContain(t("twitchImport.schedule.carried"));
      expect(q(container, "import-mature")).not.toBeNull();
      cleanup();
    }
  });

  it("no mature suggestion, no schedule, no emotes", () => {
    const dto = preview({}, { matureSuggested: false, schedule: [], emotes: [] });
    dto.preview.items = dto.preview.items.filter((i) => i.kind === "channel");
    const { container } = view({ status: status({ latest: dto }) });
    expect(q(container, "import-mature")).toBeNull();
    expect(q(container, "import-schedule")).toBeNull();
    expect(container.textContent).toContain(t("twitchImport.emotes.none"));
    expect(q(container, "import-assertion")).toBeNull();
  });

  it("choices: the channel and offered emotes toggle; skipped emotes are disabled", () => {
    const { container, fns } = view();
    fireEvent.click(checkbox(q(container, "import-field")!)!);
    expect(fns.onToggleChannel).toHaveBeenCalledOnce();
    const [wave, , bits] = qa(container, "import-emote");
    fireEvent.click(checkbox(wave!)!);
    expect(fns.onToggleEmote).toHaveBeenCalledWith("pgWave");
    expect(
      checkbox(bits!)?.getAttribute("aria-disabled") ?? checkbox(bits!)?.hasAttribute("data-disabled"),
    ).toBeTruthy();
    fireEvent.click(checkbox(bits!)!);
    expect(fns.onToggleEmote).not.toHaveBeenCalledWith("pgBits");
  });

  it("emotes chosen: start waits for the assertion, which carries its wording version", () => {
    const { container, fns } = view();
    const a = q(container, "import-assertion")!;
    expect(a.dataset.version).toBe(EMOTE_ASSERTION_VERSION);
    expect((q(container, "import-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(a);
    expect(fns.onAssert).toHaveBeenCalledWith(true);
    cleanup();
    const ok = view({ asserted: true });
    fireEvent.click(q(ok.container, "import-start")!);
    expect(ok.fns.onStart).toHaveBeenCalledOnce();
  });

  it("no emotes chosen: no assertion needed; nothing chosen: no start", () => {
    const none = view({ choices: { channel: true, emotes: [] } });
    expect(q(none.container, "import-assertion")).toBeNull();
    expect((q(none.container, "import-start") as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    const nothing = view({ choices: { channel: false, emotes: [] } });
    expect((q(nothing.container, "import-start") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("progress and result", () => {
  it("running: progress with its status, no connect button", () => {
    const { container } = view({ status: status({ connected: false, latest: preview({ status: "running" }) }) });
    expect(q(container, "import-progress")?.dataset.status).toBe("running");
    expect(q(container, "import-connect")).toBeNull();
    expect(qa(container, "import-result-item")).toHaveLength(0);
  });

  it("done: every item with its outcome and reason; connect again", () => {
    const result = [
      {
        kind: "channel" as const,
        ref: "channel",
        label: "Planting sprites",
        outcome: "imported" as const,
        reason: null,
      },
      { kind: "emote" as const, ref: "pgWave", label: "pgWave", outcome: "imported" as const, reason: null },
      { kind: "emote" as const, ref: "pgBad", label: "pgBad", outcome: "rejected" as const, reason: "upload_rejected" },
      { kind: "emote" as const, ref: "pgHi", label: "pgHi", outcome: "skipped" as const, reason: "code_taken" },
      {
        kind: "schedule" as const,
        ref: "schedule",
        label: "3",
        outcome: "skipped" as const,
        reason: "carried_not_applied",
      },
    ];
    const { container } = view({ status: status({ connected: false, latest: preview({ status: "done", result }) }) });
    expect(q(container, "import-progress")?.dataset.status).toBe("done");
    expect(
      qa(container, "import-result-item").map((i) => [
        i.dataset.kind,
        i.dataset.ref,
        i.dataset.outcome,
        i.dataset.reason,
      ]),
    ).toEqual(result.map((r) => [r.kind, r.ref, r.outcome, r.reason ?? ""]));
    expect(container.textContent).toContain(t("twitchImport.reason.uploadRejected"));
    expect(container.textContent).toContain(t("twitchImport.schedule.count", { count: 3 }));
    expect(q(container, "import-connect")?.textContent).toBe(t("twitchImport.connect.again"));
  });
});

describe("the container", () => {
  function fakeClient(states: TwitchImportStatusDto[]) {
    let i = 0;
    const client: TwitchImportClient = {
      status: vi.fn<TwitchImportClient["status"]>(async () => states[Math.min(i++, states.length - 1)]!),
      connect: vi.fn<TwitchImportClient["connect"]>(async () => ({
        authorizeUrl: "https://id.example.test/oauth2/authorize?scope=",
      })),
      start: vi.fn<TwitchImportClient["start"]>(async (input) => preview({ id: input.id, status: "queued" })),
    };
    return client;
  }
  const panels: PanelsClient = { save: vi.fn<PanelsClient["save"]>(async () => []) };

  it("connect navigates to the authorize URL", async () => {
    const client = fakeClient([status({ connected: false, latest: null })]);
    const navigate = vi.fn<(url: string) => void>();
    const { container } = wrap(
      <TwitchImportPage channel="ada" outcome={null} client={client} panelsClient={panels} navigate={navigate} />,
    );
    await waitFor(() => expect(q(container, "import-connect")).not.toBeNull());
    fireEvent.click(q(container, "import-connect")!);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://id.example.test/oauth2/authorize?scope="));
    expect(client.connect).toHaveBeenCalledWith({ channel: "ada" });
  });

  it("start sends the choices and the assertion; panels never come from Twitch", async () => {
    const client = fakeClient([status()]);
    const { container } = wrap(
      <TwitchImportPage channel="ada" outcome="connected" client={client} panelsClient={panels} />,
    );
    await waitFor(() => expect(q(container, "import-preview")).not.toBeNull());
    // Leave pgHi out, then assert.
    fireEvent.click(checkbox(qa(container, "import-emote")[1]!)!);
    fireEvent.click(q(container, "import-assertion")!);
    await waitFor(() => expect((q(container, "import-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(q(container, "import-start")!);
    await waitFor(() =>
      expect(client.start).toHaveBeenCalledWith({
        channel: "ada",
        id: preview().id,
        choices: { channel: true, panels: false, emotes: ["pgWave"] },
        assertEmoteRights: true,
      }),
    );
    await waitFor(() => expect(q(container, "import-progress")?.dataset.status).toBe("queued"));
  });
});

describe("the panel paste-in helper", () => {
  it("previews live and saves through setPanels after a confirmation", async () => {
    const save = vi.fn<PanelsClient["save"]>(async () => []);
    const { container } = wrap(<PanelsPaste channel="ada" client={{ save }} />);
    const area = q(container, "import-panels-paste") as HTMLTextAreaElement;
    expect(q(container, "import-panels-preview")?.dataset.count).toBe("0");
    expect((q(container, "import-panels-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(area, {
      target: { value: "# About\nHi <script>alert(1)</script>there\n\n## Links\nhttps://shop.example/x\n" },
    });
    const pv = q(container, "import-panels-preview")!;
    expect(pv.dataset.count).toBe("2");
    expect(pv.textContent).not.toContain("alert");
    expect(pv.textContent).toContain("About");
    expect(pv.textContent).toContain(t("twitchImport.panels.link", { url: "https://shop.example/x" }));
    fireEvent.click(q(container, "import-panels-save")!);
    const d = await dialog("import-panels-confirm");
    fireEvent.click(q(d, "confirm-dialog-confirm")!);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        channel: "ada",
        panels: [
          { title: "About", body: "Hi there", imageKey: null, linkUrl: null },
          { title: "Links", body: "", imageKey: null, linkUrl: "https://shop.example/x" },
        ],
      }),
    );
    await waitFor(() => expect((q(container, "import-panels-paste") as HTMLTextAreaElement).value).toBe(""));
  });

  it("warns when the paste was capped", () => {
    const text = Array.from({ length: 22 }, (_, i) => `# P${i}\nbody`).join("\n\n");
    const { container } = wrap(
      <PanelsPasteView text={text} saving={false} onText={() => {}} onSave={async () => {}} />,
    );
    expect(q(container, "import-panels-preview")?.dataset.count).toBe("20");
    expect(container.textContent).toContain(t("twitchImport.panels.capped", { max: 20, dropped: 2 }));
  });
});

describe("helpers", () => {
  it("previewFields reads defensively", () => {
    const f = previewFields(preview());
    expect(f).toMatchObject({ state: "ready", title: "Planting sprites", matureSuggested: true, expiresAt: EXPIRES });
    expect(f.tiers.get("pgWave")).toBe(1);
    expect(f.tiers.get("pgBits")).toBeNull();
    const empty = previewFields({ preview: { channel: { schedule: [{ nope: 1 }], tags: [1, "a"] }, items: [] } });
    expect(empty).toMatchObject({
      state: "pending",
      title: "",
      tags: ["a"],
      schedule: [],
      category: null,
      expiresAt: null,
    });
  });

  it("choices, start rules, outcomes, reasons, tiers", () => {
    const c = defaultChoices(preview().preview.items);
    expect(c).toEqual({ channel: true, emotes: ["pgWave", "pgHi"] });
    expect(toggleEmote(c, "pgHi").emotes).toEqual(["pgWave"]);
    expect(toggleEmote(toggleEmote(c, "pgHi"), "pgHi").emotes).toEqual(["pgWave", "pgHi"]);
    expect(canStart(c, false)).toBe(false);
    expect(canStart(c, true)).toBe(true);
    expect(canStart({ channel: true, emotes: [] }, false)).toBe(true);
    expect(canStart({ channel: false, emotes: [] }, true)).toBe(false);
    expect(parseOutcome("connected")).toBe("connected");
    expect(parseOutcome("<script>")).toBeNull();
    expect(parseOutcome(undefined)).toBeNull();
    expect(reasonKey("missing_file")).toBe("twitchImport.reason.imageUnavailable");
    expect(reasonKey("something_new")).toBe("twitchImport.reason.other");
    expect(reasonKey(null)).toBeNull();
    expect(tierKey(0).key).toBe("twitchImport.emotes.tierFollower");
    expect(t(tierKey(2).key, tierKey(2).vars)).toBe("Tier 2");
  });
});
