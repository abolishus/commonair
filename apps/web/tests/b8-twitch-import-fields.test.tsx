// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Batch 8 per-field Twitch import choices (N3-import request 5; docs/testing/b8-selectors.md,
 * `twitch-import-field`): a checkbox per channel field in the preview, each with the channel's
 * current value and the imported one; unticking a field sends `choices.fields`; the accessibility
 * rules axe would flag here, at 320 px in dark and light, in `en` and through the catalog.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
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
  CHANNEL_FIELDS,
  canStart,
  currentFields,
  defaultChoices,
  fieldOn,
  startChoices,
  toggleField,
  type CurrentFields,
  type TwitchImportDto,
  type TwitchImportStatusDto,
} from "../src/components/twitch-import/lib.ts";
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
const qa = (c: ParentNode, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const checkbox = (c: ParentNode) => c.querySelector<HTMLElement>('[role="checkbox"]');

const preview = (): TwitchImportDto => ({
  id: "01900000-0000-7000-8000-0000000000bb",
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
      schedule: [],
      emotes: [],
      expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
    },
    items: [{ kind: "channel", ref: "channel", label: "Planting sprites", outcome: null, reason: null }],
  },
  result: null,
  assertedAt: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
});
const status = (): TwitchImportStatusDto => ({
  available: true,
  connected: true,
  twitchLogin: "pixelgardener",
  latest: preview(),
});
const CURRENT: CurrentFields = {
  title: "My old title",
  category: null,
  tags: [],
  language: "fr",
  description: "",
  mature: false,
};

function view(over: Partial<TwitchImportViewProps> = {}, theme: "dark" | "light" = "dark") {
  const fns = {
    onConnect: vi.fn<TwitchImportViewProps["onConnect"]>(),
    onToggleChannel: vi.fn<TwitchImportViewProps["onToggleChannel"]>(),
    onToggleField: vi.fn<TwitchImportViewProps["onToggleField"]>(),
    onToggleEmote: vi.fn<TwitchImportViewProps["onToggleEmote"]>(),
    onAssert: vi.fn<TwitchImportViewProps["onAssert"]>(),
    onStart: vi.fn<TwitchImportViewProps["onStart"]>(),
  };
  const props: TwitchImportViewProps = {
    status: status(),
    loadFailed: false,
    outcome: null,
    choices: defaultChoices(preview().preview.items),
    asserted: false,
    connecting: false,
    starting: false,
    current: CURRENT,
    ...fns,
    ...over,
  };
  return { ...wrap(<TwitchImportView {...props} />, theme), fns };
}

/** The rules axe would flag on the field list: names for every checkbox, ids that resolve, no duplicates. */
function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("[role='checkbox']")) {
    const id = el.getAttribute("id");
    const labelled =
      el.hasAttribute("aria-label") ||
      el.hasAttribute("aria-labelledby") ||
      (id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null);
    if (!labelled) out.push(`checkbox-name: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of root.querySelectorAll("[aria-labelledby], [aria-describedby]"))
    for (const attr of ["aria-labelledby", "aria-describedby"])
      for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) out.push(`${attr} points at missing #${id}`);
  for (const list of root.querySelectorAll("ul"))
    for (const child of list.children) if (child.tagName !== "LI") out.push(`list: ${child.tagName} in ul`);
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

describe("per-field choices in the preview", () => {
  it("a checkbox per field, each with the current and the imported value", () => {
    for (const theme of ["dark", "light"] as const) {
      const { container } = view({}, theme);
      const rows = qa(container, "twitch-import-field");
      expect(rows.map((r) => [r.dataset.field, r.dataset.state])).toEqual(CHANNEL_FIELDS.map((f) => [f, "on"]));
      const row = (f: string) => rows.find((r) => r.dataset.field === f)!;
      const text = (f: string, which: "current" | "imported") =>
        row(f).querySelector<HTMLElement>(`[data-value="${which}"]`)?.textContent;
      expect(text("title", "current")).toBe(t("twitchImport.fields.current", { value: "My old title" }));
      expect(text("title", "imported")).toBe(t("twitchImport.fields.imported", { value: "Planting sprites" }));
      expect(text("tags", "imported")).toContain("pixelart, cozy");
      expect(text("tags", "current")).toContain(t("twitchImport.preview.none"));
      expect(text("mature", "current")).toContain(t("twitchImport.fields.no"));
      expect(text("mature", "imported")).toContain(t("twitchImport.fields.yes"));
      expect(text("language", "current")).toContain("fr");
      expect(a11yViolations(container)).toEqual([]);
      // Logical CSS only: nothing fixed wider than the 320 px column.
      expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d/);
      cleanup();
    }
  });

  it("toggling a field calls back with its name; an unticked field shows off", () => {
    const { container, fns } = view({ choices: toggleField(defaultChoices(preview().preview.items), "title") });
    const rows = qa(container, "twitch-import-field");
    expect(rows.find((r) => r.dataset.field === "title")?.dataset.state).toBe("off");
    fireEvent.click(checkbox(rows.find((r) => r.dataset.field === "tags")!)!);
    expect(fns.onToggleField).toHaveBeenCalledWith("tags");
  });

  it("with the channel unticked every field is off and disabled", () => {
    const { container, fns } = view({ choices: { channel: false, emotes: [] } });
    const rows = qa(container, "twitch-import-field");
    expect(rows.every((r) => r.dataset.state === "off")).toBe(true);
    fireEvent.click(checkbox(rows[0]!)!);
    expect(fns.onToggleField).not.toHaveBeenCalled();
  });

  it("without the current values the preview says they were not loaded", () => {
    const { container } = view({ current: null });
    const title = qa(container, "twitch-import-field").find((r) => r.dataset.field === "title")!;
    expect(title.querySelector('[data-value="current"]')?.textContent).toBe(
      t("twitchImport.fields.current", { value: t("twitchImport.fields.currentUnknown") }),
    );
  });
});

describe("the container", () => {
  it("reads the current values and sends only the chosen fields", async () => {
    const client: TwitchImportClient = {
      status: vi.fn<TwitchImportClient["status"]>(async () => status()),
      connect: vi.fn<TwitchImportClient["connect"]>(async () => ({ authorizeUrl: "https://id.example.test/" })),
      start: vi.fn<TwitchImportClient["start"]>(async (input) => ({ ...preview(), id: input.id, status: "queued" })),
      current: vi.fn<NonNullable<TwitchImportClient["current"]>>(async () => CURRENT),
    };
    const { container } = wrap(
      <TwitchImportPage channel="ada" outcome={null} client={client} panelsClient={{ save: async () => [] }} />,
    );
    await waitFor(() => expect(qa(container, "twitch-import-field")).toHaveLength(CHANNEL_FIELDS.length));
    await waitFor(() =>
      expect(container.textContent).toContain(t("twitchImport.fields.current", { value: "My old title" })),
    );
    expect(client.current).toHaveBeenCalledWith({ channel: "ada" });
    for (const f of ["title", "description"]) {
      const row = qa(container, "twitch-import-field").find((r) => r.dataset.field === f)!;
      fireEvent.click(checkbox(row)!);
    }
    fireEvent.click(container.querySelector<HTMLElement>('[data-testid="import-start"]')!);
    await waitFor(() =>
      expect(client.start).toHaveBeenCalledWith({
        channel: "ada",
        id: preview().id,
        choices: {
          channel: true,
          fields: { title: false, category: true, tags: true, language: true, description: false, mature: true },
          panels: false,
          emotes: [],
        },
        assertEmoteRights: false,
      }),
    );
  });
});

describe("helpers", () => {
  it("fields default on, toggle, and decide what start sends and allows", () => {
    const c = defaultChoices(preview().preview.items);
    expect(CHANNEL_FIELDS.every((f) => fieldOn(c, f))).toBe(true);
    // Nothing changed: no `fields` (every field, as before).
    expect(startChoices(c)).toEqual({ channel: true, panels: false, emotes: [] });
    const noTitle = toggleField(c, "title");
    expect(fieldOn(noTitle, "title")).toBe(false);
    expect(startChoices(noTitle).fields).toMatchObject({ title: false, tags: true });
    expect(fieldOn(toggleField(noTitle, "title"), "title")).toBe(true);
    // Every field off and no emotes: nothing to start.
    const none = CHANNEL_FIELDS.reduce((acc, f) => toggleField(acc, f), c);
    expect(canStart(none, false)).toBe(false);
    expect(canStart(c, false)).toBe(true);
  });

  it("currentFields reads channels.get", () => {
    expect(
      currentFields({
        title: "T",
        description: "D",
        category: { name: "Art" },
        tags: ["a"],
        language: "es",
        mature: true,
      }),
    ).toEqual({ title: "T", description: "D", category: "Art", tags: ["a"], language: "es", mature: true });
  });
});
