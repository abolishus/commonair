// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The studio `/captions` page (ADR 0011): the mask list, the patch, and the page against a fake API. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { captionsDraft, captionsPatch, parseMaskWords, spokenLanguages } from "../src/player/captions-studio.ts";
import { CaptionsStudio, Route } from "../src/routes/_studio/captions.tsx";

const toasts = vi.hoisted(() => ({ success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));
// The page route reads the signed-in user and the browser API client; both are swapped per test.
const session = vi.hoisted(() => ({
  me: null as null | { username: string; channelSlug: string | null },
  api: null as unknown,
}));
vi.mock("../src/lib/bootstrap.ts", () => ({
  getSessionUser: async () => session.me,
  useBootstrap: () => ({ me: session.me }),
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api.ts")>()),
  api: () => session.api,
}));

afterEach(() => {
  cleanup();
  toasts.success.mockReset();
  toasts.error.mockReset();
  session.me = null;
  session.api = null;
});

describe("mask list", () => {
  it("one pattern per line, blanks and repeats dropped", () => {
    expect(parseMaskWords("darn\n\n  heck  \ndarn\nh[e3]ck")).toEqual({
      words: ["darn", "heck", "h[e3]ck"],
      error: null,
    });
  });

  it("the first bad line is reported by number", () => {
    expect(parseMaskWords("ok\n(unclosed\nfine").error).toEqual({ line: 2, reason: "pattern" });
    expect(parseMaskWords(`a\n${"x".repeat(201)}`).error).toEqual({ line: 2, reason: "length" });
    const many = Array.from({ length: 101 }, (_, i) => `w${i}`).join("\n");
    expect(parseMaskWords(many).error).toEqual({ line: 101, reason: "count" });
  });
});

describe("settings patch", () => {
  const base = { enabled: null, spokenLanguage: null, maskWords: ["a"] };
  it("a channel that follows the default keeps following it until the switch moves", () => {
    const d = captionsDraft(base, true, "en");
    expect(d).toEqual({ enabled: true, own: false, language: "en", maskText: "a" });
    expect(captionsPatch(d, ["a"], "en")).toEqual({ enabled: null, spokenLanguage: null, maskWords: ["a"] });
    expect(captionsPatch({ ...d, own: true, enabled: false }, [], "en").enabled).toBe(false);
  });

  it("the spoken language is stored only when it is not the channel's", () => {
    const d = captionsDraft({ ...base, spokenLanguage: "es" }, false, "en");
    expect(d.language).toBe("es");
    expect(captionsPatch(d, [], "en").spokenLanguage).toBe("es");
    expect(captionsPatch({ ...d, language: "en" }, [], "en").spokenLanguage).toBeNull();
  });

  it("offers the channel's language even when the list lacks it", () => {
    expect(spokenLanguages("en")).toContain("en");
    expect(spokenLanguages("eu")).toContain("eu");
    expect(spokenLanguages("pt-BR")).not.toContain("pt-BR");
  });
});

describe("CaptionsStudio", () => {
  type Cue = { index: number; startMs: number; endMs: number; text: string };
  function fakeApi(
    cues: Cue[] = [
      { index: 0, startMs: 0, endMs: 1500, text: "helo" },
      { index: 1, startMs: 2000, endMs: 3000, text: "world" },
    ],
  ) {
    const updateMediaSettings = vi.fn<(input: { captions?: { maskWords?: string[] } }) => Promise<unknown>>(
      async (input) => ({
        captions: { enabled: true, spokenLanguage: null, maskWords: input.captions?.maskWords ?? [] },
        captionsInstanceDefault: false,
        captionsState: "off",
        dvr: { enabled: true, windowSeconds: 1800 },
        dvrMaxWindowSeconds: 7200,
      }),
    );
    const update = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({}));
    const client = {
      channels: {
        mediaSettings: async () => ({
          captions: { enabled: null, spokenLanguage: null, maskWords: ["darn"] },
          captionsInstanceDefault: false,
          captionsState: "queued",
          dvr: { enabled: true, windowSeconds: 1800 },
          dvrMaxWindowSeconds: 7200,
        }),
        get: async () => ({ language: "en" }),
        updateMediaSettings,
      },
      vods: {
        list: async () => ({
          items: [
            { id: "v1", title: "First", captions: [{ language: "en", label: "English", url: "u" }] },
            { id: "v2", title: "No captions", captions: [] },
          ],
          nextCursor: null,
        }),
        captions: {
          get: async () => ({
            vodId: "v1",
            language: "en",
            status: "ready",
            cues,
            editedAt: null,
          }),
          update,
        },
      },
    };
    return { client, updateMediaSettings, update };
  }
  const Wrap = ({ children }: { children: React.ReactNode }) => (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{children}</TooltipProvider>
    </LocaleProvider>
  );

  it("shows the default it follows, the track state, the privacy note and the cue editor", async () => {
    const { client, update } = fakeApi();
    render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
    const enabled = await screen.findByTestId("captions-enabled");
    expect(enabled.dataset.state).toBe("off");
    expect(enabled.dataset.default).toBe("off");
    expect(screen.getByTestId("captions-track-state").dataset.state).toBe("queued");
    expect(screen.getByTestId("captions-language").dataset.value).toBe("en");
    expect((screen.getByTestId("captions-mask-words") as HTMLTextAreaElement).value).toBe("darn");
    expect(screen.getByTestId("captions-privacy-note").textContent).toMatch(/Draft/);

    const editor = await screen.findByTestId("captions-vod-editor");
    expect(editor.dataset.vodId).toBe("v1");
    const cues = await screen.findAllByTestId("captions-cue");
    expect(cues.map((c) => [c.dataset.startMs, c.dataset.endMs])).toEqual([
      ["0", "1500"],
      ["2000", "3000"],
    ]);
    const save = screen.getByTestId("captions-cue-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "hello" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ id: "v1", language: "en", cues: [{ index: 0, text: "hello" }] }),
    );
  });

  it("an invalid pattern errors inline on its line and saves nothing", async () => {
    const { client, updateMediaSettings } = fakeApi();
    render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
    const mask = await screen.findByTestId("captions-mask-words");
    fireEvent.change(mask, { target: { value: "ok\n(bad" } });
    fireEvent.click(screen.getByTestId("captions-save"));
    const err = await screen.findByTestId("captions-mask-error");
    expect(err.dataset.line).toBe("2");
    expect(updateMediaSettings).not.toHaveBeenCalled();
    fireEvent.change(mask, { target: { value: "ok\nfine" } });
    fireEvent.click(screen.getByTestId("captions-save"));
    await waitFor(() =>
      expect(updateMediaSettings).toHaveBeenCalledWith({
        channel: "alice",
        captions: { enabled: null, spokenLanguage: null, maskWords: ["ok", "fine"] },
      }),
    );
  });

  describe("cue editor paging and search (F36)", () => {
    const MIN = 60_000;
    // Three five-minute windows with cues (0-5, 5-10, 20-25 min); 10-20 min is silent.
    const longCues: Cue[] = [
      { index: 0, startMs: 0, endMs: 2000, text: "welcome everyone" },
      { index: 1, startMs: 4 * MIN, endMs: 4 * MIN + 2000, text: "first topic" },
      { index: 2, startMs: 5 * MIN, endMs: 5 * MIN + 2000, text: "second topic" },
      { index: 3, startMs: 9 * MIN, endMs: 9 * MIN + 2000, text: "a question" },
      { index: 4, startMs: 21 * MIN, endMs: 21 * MIN + 2000, text: "goodbye everyone" },
    ];
    const starts = () => screen.getAllByTestId("captions-cue").map((c) => c.dataset.startMs);
    const pageOf = () => {
      const p = screen.getByTestId("captions-cue-page");
      return [p.dataset.page, p.dataset.pages];
    };
    const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
    const search = (q: string) => fireEvent.change(screen.getByTestId("captions-cue-search"), { target: { value: q } });

    it("a short VOD is one page with no pager", async () => {
      const { client } = fakeApi();
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      expect(screen.queryByTestId("captions-cue-pager")).toBeNull();
    });

    it("pages by five minutes, skipping silent stretches, with Earlier and Later at the ends", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      // The first cue (the one the captions scenario corrects) is on the first page.
      expect(starts()).toEqual(["0", String(4 * MIN)]);
      expect(pageOf()).toEqual(["1", "3"]);
      expect(button("captions-cue-prev").disabled).toBe(true);
      expect(screen.getByTestId("captions-cue-page").textContent).toBe("00:00 to 04:02 · part 1 of 3");
      fireEvent.click(button("captions-cue-next"));
      expect(starts()).toEqual([String(5 * MIN), String(9 * MIN)]);
      fireEvent.click(button("captions-cue-next"));
      expect(starts()).toEqual([String(21 * MIN)]);
      expect(pageOf()).toEqual(["3", "3"]);
      expect(button("captions-cue-next").disabled).toBe(true);
      fireEvent.click(button("captions-cue-prev"));
      expect(pageOf()).toEqual(["2", "3"]);
    });

    it("edits on other pages survive paging and are saved together", async () => {
      const { client, update } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "welcome, everyone" } });
      fireEvent.click(button("captions-cue-next"));
      fireEvent.click(button("captions-cue-next"));
      fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "goodbye, everyone" } });
      expect(screen.getByTestId("captions-cue-unsaved").textContent).toBe("2 unsaved corrections");
      fireEvent.click(button("captions-cue-prev"));
      fireEvent.click(button("captions-cue-prev"));
      expect((screen.getAllByTestId("captions-cue-text")[0] as HTMLInputElement).value).toBe("welcome, everyone");
      fireEvent.click(button("captions-cue-save"));
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith({
          id: "v1",
          language: "en",
          cues: [
            { index: 0, text: "welcome, everyone" },
            { index: 4, text: "goodbye, everyone" },
          ],
        }),
      );
    });

    it("search filters cues by text across pages, and back to page 1", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      fireEvent.click(button("captions-cue-next"));
      search("TOPIC");
      // "first topic" (0-5 min) and "second topic" (5-10 min) are two windows.
      expect(pageOf()).toEqual(["1", "2"]);
      expect(starts()).toEqual([String(4 * MIN)]);
      search("everyone");
      expect(pageOf()).toEqual(["1", "2"]);
      search("goodbye");
      expect(starts()).toEqual([String(21 * MIN)]);
      expect(screen.queryByTestId("captions-cue-pager")).toBeNull();
    });

    it("a cue being corrected stays in its search, and its edit stays when the search clears", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      search("question");
      fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "an answer" } });
      expect(starts()).toEqual([String(9 * MIN)]);
      search("answer");
      expect(starts()).toEqual([String(9 * MIN)]);
      search("");
      fireEvent.click(button("captions-cue-next"));
      expect((screen.getAllByTestId("captions-cue-text")[1] as HTMLInputElement).value).toBe("an answer");
    });

    it("a track with no cues says so, with no search and no no-match state", async () => {
      const { client } = fakeApi([]);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      const empty = await screen.findByTestId("captions-cue-empty");
      expect(empty.textContent).toContain("This track has no captions");
      expect(screen.queryByTestId("captions-cue-search")).toBeNull();
      expect(screen.queryByTestId("captions-cue-no-match")).toBeNull();
      expect(screen.queryByTestId("captions-cue-pager")).toBeNull();
      expect(button("captions-cue-save").disabled).toBe(true);
    });

    it("a cue edited under a search stays in it while the edit stops matching, until the search changes", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      search("question");
      fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "an answer" } });
      search("answer");
      // Matches only through its draft; typing on keeps it.
      fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "a reply" } });
      expect(starts()).toEqual([String(9 * MIN)]);
      search("answe");
      expect(screen.queryAllByTestId("captions-cue")).toHaveLength(0);
    });

    it("a second pager below the list moves focus back to the top of the new page", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      const bottom = screen.getByTestId("captions-cue-pager-bottom");
      const later = within(bottom).getByRole("button", { name: "Later" });
      fireEvent.click(later);
      expect(pageOf()).toEqual(["2", "3"]);
      expect(document.activeElement).toBe(screen.getByTestId("captions-cue-page"));
    });

    it("a search with no match says so and keeps Save", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      await screen.findAllByTestId("captions-cue");
      search("zebra");
      expect(screen.queryAllByTestId("captions-cue")).toHaveLength(0);
      expect(screen.getByTestId("captions-cue-no-match").textContent).toContain("No caption says “zebra”");
      expect(screen.queryByTestId("captions-cue-pager")).toBeNull();
      expect(screen.getByTestId("captions-cue-save")).toBeTruthy();
    });

    it("Clear search on the no-match state brings every cue back", async () => {
      const { client } = fakeApi(longCues);
      render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
      const before = (await screen.findAllByTestId("captions-cue")).length;
      search("zebra");
      fireEvent.click(screen.getByTestId("captions-cue-clear-search"));
      expect(screen.queryByTestId("captions-cue-no-match")).toBeNull();
      expect(screen.getAllByTestId("captions-cue")).toHaveLength(before);
      expect((screen.getByTestId("captions-cue-search") as HTMLInputElement).value).toBe("");
    });
  });
});

describe("CaptionsStudio states and failures", () => {
  type Cue = { index: number; startMs: number; endMs: number; text: string };
  type Settings = {
    captions: { enabled: boolean | null; spokenLanguage: string | null; maskWords: string[] };
    captionsInstanceDefault: boolean;
    captionsState?: string;
  };
  const settingsOf = (over: Partial<Settings> = {}): Settings => ({
    captions: { enabled: null, spokenLanguage: null, maskWords: [] },
    captionsInstanceDefault: false,
    captionsState: "off",
    ...over,
  });
  const vod = (id: string, title: string, captioned = true) => ({
    id,
    title,
    captions: captioned ? [{ language: "en", label: "English", url: "u" }] : [],
  });
  const cues: Cue[] = [
    { index: 0, startMs: 0, endMs: 1500, text: "helo" },
    { index: 1, startMs: 2000, endMs: 3000, text: "world" },
  ];
  type Over = {
    settings: () => Promise<Settings>;
    update: (input: { channel: string; captions: Settings["captions"] }) => Promise<Settings>;
    vods: () => Promise<{ items: ReturnType<typeof vod>[]; nextCursor: null }>;
    track: (input: { id: string; language: string }) => Promise<unknown>;
    save: (input: unknown) => Promise<unknown>;
  };
  function studio(over: Partial<Over> = {}) {
    const m = {
      mediaSettings: vi.fn<Over["settings"]>(over.settings ?? (async () => settingsOf())),
      updateMediaSettings: vi.fn<Over["update"]>(
        over.update ?? (async (input) => settingsOf({ captions: input.captions, captionsState: "off" })),
      ),
      vodsList: vi.fn<Over["vods"]>(over.vods ?? (async () => ({ items: [vod("v1", "First")], nextCursor: null }))),
      trackGet: vi.fn<Over["track"]>(
        over.track ??
          (async (input) => ({
            vodId: input.id,
            language: input.language,
            status: "ready",
            cues,
            editedAt: null,
          })),
      ),
      trackUpdate: vi.fn<Over["save"]>(over.save ?? (async () => ({}))),
    };
    const client = {
      channels: {
        mediaSettings: m.mediaSettings,
        get: async () => ({ language: "en" }),
        updateMediaSettings: m.updateMediaSettings,
      },
      vods: { list: m.vodsList, captions: { get: m.trackGet, update: m.trackUpdate } },
    };
    return { m, client };
  }
  const Wrap = ({ children }: { children: React.ReactNode }) => (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{children}</TooltipProvider>
    </LocaleProvider>
  );
  const show = (client: unknown) =>
    render(<CaptionsStudio channel="alice" client={client as never} />, { wrapper: Wrap });
  const apiError = (code: string) => Object.assign(new Error(code), { code });
  async function pick(trigger: HTMLElement, name: string | RegExp): Promise<void> {
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name });
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(option, { button: 0 });
    fireEvent.click(option);
  }

  it("a failed settings load offers a retry that loads again", async () => {
    let fail = true;
    const { m, client } = studio({
      settings: async () => {
        if (fail) throw apiError("INTERNAL_SERVER_ERROR");
        return settingsOf();
      },
    });
    show(client);
    expect((await screen.findByTestId("captions-load-error")).textContent).toContain(en["captions.studio.loadFailed"]);
    expect(screen.queryByTestId("captions-enabled")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByTestId("captions-retry"));
    expect(await screen.findByTestId("captions-enabled")).toBeTruthy();
    expect(m.mediaSettings).toHaveBeenCalledTimes(2);
  });

  it("shows a skeleton until the settings arrive", async () => {
    let answer: (s: Settings) => void = () => {};
    const { client } = studio({
      settings: () =>
        new Promise<Settings>((r) => {
          answer = r;
        }),
    });
    const { container } = show(client);
    expect(container.querySelector('[data-slot="skeleton-group"]')).toBeTruthy();
    expect(screen.queryByTestId("captions-enabled")).toBeNull();
    answer(settingsOf());
    expect(await screen.findByTestId("captions-enabled")).toBeTruthy();
  });

  it.each([
    ["active", en["captions.studio.track.active"], false],
    ["queued", en["captions.studio.track.queued"], true],
    ["off", en["captions.studio.track.off"], false],
    // An older server leaves the state out: read as off.
    [undefined, en["captions.studio.track.off"], false],
  ] as const)("track state %s reads %s", async (state, label, hint) => {
    const settings = settingsOf();
    if (state === undefined) delete settings.captionsState;
    else settings.captionsState = state;
    const { client } = studio({ settings: async () => settings });
    show(client);
    const badge = await screen.findByTestId("captions-track-state");
    expect(badge.dataset.state).toBe(state ?? "off");
    expect(badge.textContent).toBe(label);
    expect(screen.queryByText(en["captions.studio.track.queuedHint"]) !== null).toBe(hint);
  });

  it("describes the default it follows, and the channel's own choice once it has one", async () => {
    const { client } = studio({ settings: async () => settingsOf({ captionsInstanceDefault: true }) });
    show(client);
    const enabled = await screen.findByTestId("captions-enabled");
    expect([enabled.dataset.state, enabled.dataset.default]).toEqual(["on", "on"]);
    expect(screen.getByText(en["captions.studio.enabledDefaultOn"])).toBeTruthy();
    fireEvent.click(enabled);
    await waitFor(() => expect(screen.getByTestId("captions-enabled").dataset.state).toBe("off"));
    expect(screen.getByText(en["captions.studio.enabledOwn"])).toBeTruthy();
    cleanup();

    const own = studio({
      settings: async () => settingsOf({ captions: { enabled: false, spokenLanguage: null, maskWords: [] } }),
    });
    show(own.client);
    await screen.findByTestId("captions-enabled");
    expect(screen.getByText(en["captions.studio.enabledOwn"])).toBeTruthy();
  });

  it("saves the switch and the spoken language picked from the list, then confirms and reloads", async () => {
    const { m, client } = studio();
    show(client);
    fireEvent.click(await screen.findByTestId("captions-enabled"));
    const language = screen.getByTestId("captions-language");
    await pick(language, /^Español/);
    await waitFor(() => expect(screen.getByTestId("captions-language").dataset.value).toBe("es"));
    fireEvent.click(screen.getByTestId("captions-save"));
    await waitFor(() =>
      expect(m.updateMediaSettings).toHaveBeenCalledWith({
        channel: "alice",
        captions: { enabled: true, spokenLanguage: "es", maskWords: [] },
      }),
    );
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(en["captions.studio.saved"]));
    await waitFor(() => expect(m.mediaSettings).toHaveBeenCalledTimes(2));
  });

  it("disables Save while saving, so a second submit sends nothing", async () => {
    let finish: () => void = () => {};
    const { m, client } = studio({
      update: (input) =>
        new Promise<Settings>((r) => {
          finish = () => r(settingsOf({ captions: input.captions }));
        }),
    });
    show(client);
    const save = (await screen.findByTestId("captions-save")) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    fireEvent.submit(save.closest("form")!);
    expect(m.updateMediaSettings).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it("a pattern the server finds too slow errors inline with no line number", async () => {
    const { client } = studio({
      update: async () => {
        throw apiError("PRECONDITION_FAILED");
      },
    });
    show(client);
    fireEvent.change(await screen.findByTestId("captions-mask-words"), { target: { value: "(a+)+b" } });
    fireEvent.click(screen.getByTestId("captions-save"));
    const err = await screen.findByTestId("captions-mask-error");
    expect(err.dataset.line).toBe("");
    expect(err.textContent).toBe(en["captions.studio.mask.errorServer"]);
    expect(screen.getByTestId("captions-mask-words").getAttribute("aria-invalid")).toBe("true");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("any other save failure toasts and clears no draft", async () => {
    const { client } = studio({
      update: async () => {
        throw apiError("INTERNAL_SERVER_ERROR");
      },
    });
    show(client);
    fireEvent.change(await screen.findByTestId("captions-mask-words"), { target: { value: "darn" } });
    fireEvent.click(screen.getByTestId("captions-save"));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["captions.studio.saveFailed"]));
    expect(screen.queryByTestId("captions-mask-error")).toBeNull();
    expect((screen.getByTestId("captions-mask-words") as HTMLTextAreaElement).value).toBe("darn");
  });

  it("names the line of a too-long or past-the-limit pattern", async () => {
    const { client } = studio();
    show(client);
    const mask = await screen.findByTestId("captions-mask-words");
    fireEvent.change(mask, { target: { value: `ok\n${"x".repeat(201)}` } });
    fireEvent.click(screen.getByTestId("captions-save"));
    expect((await screen.findByTestId("captions-mask-error")).textContent).toBe(
      "Line 2 is longer than 200 characters.",
    );
  });

  it("no captioned VOD: an empty state whose action focuses the captions switch", async () => {
    const { client } = studio({ vods: async () => ({ items: [vod("v9", "Silent", false)], nextCursor: null }) });
    show(client);
    expect(await screen.findByText(en["captions.studio.vod.emptyTitle"])).toBeTruthy();
    expect(screen.queryByTestId("captions-vod-editor")).toBeNull();
    fireEvent.click(screen.getByText(en["studio.empty.turnOnCaptions"]));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("captions-enabled")));
  });

  it("a failed VOD list keeps the settings and offers a retry", async () => {
    let fail = true;
    const { m, client } = studio({
      vods: async () => {
        if (fail) throw apiError("INTERNAL_SERVER_ERROR");
        return { items: [vod("v1", "First")], nextCursor: null };
      },
    });
    show(client);
    const error = await screen.findByTestId("captions-vod-load-error");
    expect(error.textContent).toContain(en["captions.studio.vod.loadFailed"]);
    expect(screen.getByTestId("captions-enabled")).toBeTruthy();
    fail = false;
    fireEvent.click(within(error).getByText(en["common.retry"]));
    expect(await screen.findByTestId("captions-vod-editor")).toBeTruthy();
    expect(m.vodsList).toHaveBeenCalledWith({ channel: "alice", limit: 50 });
  });

  it("a failed track offers a retry; picking another VOD loads its track", async () => {
    const { m, client } = studio({
      vods: async () => ({ items: [vod("v1", "First"), vod("v2", "Second")], nextCursor: null }),
      track: async (input) => {
        if (input.id === "v1" && m.trackGet.mock.calls.length === 1) throw apiError("INTERNAL_SERVER_ERROR");
        return { vodId: input.id, language: input.language, status: "ready", cues, editedAt: null };
      },
    });
    show(client);
    const error = await screen.findByTestId("captions-vod-load-error");
    fireEvent.click(within(error).getByText(en["common.retry"]));
    expect((await screen.findByTestId("captions-vod-editor")).dataset.vodId).toBe("v1");
    const trigger = screen.getByRole("combobox", { name: en["captions.studio.vod.pick"] });
    expect(trigger.textContent).toContain("First");
    await pick(trigger, "Second");
    await waitFor(() => expect(screen.getByTestId("captions-vod-editor").dataset.vodId).toBe("v2"));
    expect(m.trackGet).toHaveBeenLastCalledWith({ id: "v2", language: "en" });
  });

  it("shows a skeleton while the track loads", async () => {
    const { client } = studio({ track: () => new Promise(() => {}) });
    const { container } = show(client);
    await screen.findByRole("combobox", { name: en["captions.studio.vod.pick"] });
    expect(screen.queryByTestId("captions-vod-editor")).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton-group"]').length).toBe(1);
  });

  it("labels cues past the hour with hours", async () => {
    const H = 3_600_000;
    const { client } = studio({
      track: async (input) => ({
        vodId: input.id,
        language: "en",
        status: "ready",
        cues: [{ index: 0, startMs: H + 61_000, endMs: H + 62_500, text: "late" }],
        editedAt: null,
      }),
    });
    show(client);
    const cue = await screen.findByTestId("captions-cue");
    expect(cue.textContent).toContain("1:01:01 to 1:01:02");
    expect(screen.getByLabelText("Caption at 1:01:01")).toBeTruthy();
  });

  it("saved corrections confirm, clear the unsaved count and reload the track", async () => {
    const { m, client } = studio();
    show(client);
    await screen.findAllByTestId("captions-cue");
    fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "hello" } });
    expect(screen.getByTestId("captions-cue-unsaved").textContent).toBe("1 unsaved correction");
    // Typing back the original is no change.
    fireEvent.change(screen.getAllByTestId("captions-cue-text")[1]!, { target: { value: "world" } });
    expect(screen.getByTestId("captions-cue-unsaved").textContent).toBe("1 unsaved correction");
    fireEvent.click(screen.getByTestId("captions-cue-save"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(en["captions.studio.vod.saved"]));
    expect(m.trackUpdate).toHaveBeenCalledWith({ id: "v1", language: "en", cues: [{ index: 0, text: "hello" }] });
    await waitFor(() => expect(screen.queryByTestId("captions-cue-unsaved")).toBeNull());
    await waitFor(() => expect(m.trackGet).toHaveBeenCalledTimes(2));
  });

  it("a failed correction save toasts and keeps the drafts", async () => {
    const { m, client } = studio({
      save: async () => {
        throw apiError("INTERNAL_SERVER_ERROR");
      },
    });
    show(client);
    await screen.findAllByTestId("captions-cue");
    fireEvent.change(screen.getAllByTestId("captions-cue-text")[0]!, { target: { value: "hello" } });
    const save = screen.getByTestId("captions-cue-save") as HTMLButtonElement;
    fireEvent.click(save);
    // While it runs, Save is disabled.
    expect(save.disabled).toBe(true);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["captions.studio.vod.saveFailed"]));
    expect(m.trackUpdate).toHaveBeenCalledTimes(1);
    expect((screen.getAllByTestId("captions-cue-text")[0] as HTMLInputElement).value).toBe("hello");
    expect(save.disabled).toBe(false);
  });
});

describe("/captions route", () => {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/captions"] }),
  });
  // The route's component is code-split: load it before rendering, so it does not suspend.
  const Page = Route.options.component as React.ComponentType & { preload?: () => Promise<void> };
  const page = async () => {
    await Page.preload?.();
    return render(
      <RouterContextProvider router={router}>
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>
            <Page />
          </TooltipProvider>
        </LocaleProvider>
      </RouterContextProvider>,
    );
  };

  it("is titled Captions", () => {
    const head = (Route.options.head as () => { meta?: { title?: string }[] })();
    expect(head.meta?.find((m) => m.title !== undefined)?.title).toMatch(/^Captions/);
  });

  it("the guard sends a signed-out visitor to sign in, and lets a signed-in one through", async () => {
    const beforeLoad = Route.options.beforeLoad as () => Promise<unknown>;
    await expect(beforeLoad()).rejects.toMatchObject({ options: { to: "/signin" } });
    session.me = { username: "alice", channelSlug: null };
    await expect(beforeLoad()).resolves.toEqual({ me: session.me });
  });

  it("loads the studio for the user's channel slug, or the username without one", async () => {
    const mediaSettings = vi.fn<(i: { channel: string }) => Promise<unknown>>(async () => ({
      captions: { enabled: null, spokenLanguage: null, maskWords: [] },
      captionsInstanceDefault: false,
      captionsState: "off",
    }));
    session.api = {
      channels: { mediaSettings, get: async () => ({ language: "en" }), updateMediaSettings: vi.fn<() => void>() },
      vods: {
        list: async () => ({ items: [], nextCursor: null }),
        captions: { get: vi.fn<() => void>(), update: vi.fn<() => void>() },
      },
    };
    session.me = { username: "alice", channelSlug: "alice-tv" };
    await page();
    expect(await screen.findByTestId("captions-page")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(en["captions.studio.pageTitle"]);
    await waitFor(() => expect(mediaSettings).toHaveBeenCalledWith({ channel: "alice-tv" }));
    cleanup();
    session.me = { username: "bob", channelSlug: null };
    await page();
    await waitFor(() => expect(mediaSettings).toHaveBeenLastCalledWith({ channel: "bob" }));
  });

  it("a signed-out render redirects to sign in instead of the studio", async () => {
    await page();
    expect(screen.queryByTestId("captions-page")).toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
  });
});
