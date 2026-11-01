// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The studio `/captions` page (ADR 0011): the mask list, the patch, and the page against a fake API. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { captionsDraft, captionsPatch, parseMaskWords, spokenLanguages } from "../src/player/captions-studio.ts";
import { CaptionsStudio } from "../src/routes/_studio/captions.tsx";

afterEach(() => cleanup());

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
  function fakeApi() {
    const updateMediaSettings = vi.fn<(input: { captions?: { maskWords?: string[] } }) => Promise<unknown>>(
      async (input) => ({
        captions: { enabled: true, spokenLanguage: null, maskWords: input.captions?.maskWords ?? [] },
        captionsInstanceDefault: false,
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
            cues: [
              { index: 0, startMs: 0, endMs: 1500, text: "helo" },
              { index: 1, startMs: 2000, endMs: 3000, text: "world" },
            ],
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
});
