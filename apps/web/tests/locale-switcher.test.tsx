// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The language switchers (N2-switcher): Settings → Preferences and the footer menu. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  boot: { me: null } as { me: unknown; locale?: string; localeFromUser?: boolean },
  get: vi.fn<() => Promise<{ locale: string | null }>>(),
  update: vi.fn<(input: { locale?: string | null }) => Promise<unknown>>(),
  applyLocale: vi.fn<(tag: string) => Promise<void>>(),
  rememberLocale: vi.fn<(tag: string, opts: { preferencesAllowed: boolean }) => void>(),
  preferencesAllowed: vi.fn<() => boolean>(),
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = { me: { get: () => fake.get(), update: (input: { locale?: string | null }) => fake.update(input) } };
  return { ...actual, api: () => client };
});

vi.mock("../src/i18n/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/i18n/client.ts")>();
  return {
    ...actual,
    applyLocale: (tag: string) => fake.applyLocale(tag),
    rememberLocale: (tag: string, opts: { preferencesAllowed: boolean }) => fake.rememberLocale(tag, opts),
  };
});

vi.mock("../src/lib/consent.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/consent.ts")>();
  return { ...actual, preferencesAllowed: () => fake.preferencesAllowed() };
});

import { FooterLocaleSwitcher } from "../src/components/locale/footer-locale-switcher.tsx";
import { switchableLocales } from "../src/components/locale/language-label.tsx";
import { LanguageSection } from "../src/components/locale/preferences-page.tsx";
import { en } from "../src/i18n/en.ts";
import { SUPPORTED_LOCALES, locale, uiMessages } from "../src/i18n/index.ts";

const ME = { id: "u1", username: "rivertide", displayName: "Rivertide", channelSlug: null, role: "user" };

/** Render `node` as the root route's page, with `fake.boot` as the root loader's data (`me`). */
async function mount(node: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({
      loader: () => fake.boot,
      component: () => (
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>{node}</TooltipProvider>
        </LocaleProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(document.querySelector("[data-testid]")).not.toBeNull());
  return router;
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = byId(id);
  if (!el) throw new Error(`no ${id}`);
  return el;
};

/** Open a Base UI select or menu and choose an item (a mouse click counts only when pressed on it). */
async function pick(trigger: string, option: string): Promise<void> {
  fireEvent.click(must(trigger));
  await waitFor(() => expect(byId(option)).not.toBeNull());
  const item = must(option);
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item);
}

let clock = Date.parse("2026-10-31T12:00:00.000Z");

beforeEach(() => {
  // Each test a minute later, so a save carried across a remount never leaks into the next test.
  clock += 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  fake.boot = { me: null };
  fake.get.mockResolvedValue({ locale: null });
  fake.update.mockResolvedValue({});
  fake.applyLocale.mockResolvedValue(undefined);
  fake.preferencesAllowed.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fake.get.mockReset();
  fake.update.mockReset();
  fake.applyLocale.mockReset();
  fake.rememberLocale.mockReset();
  fake.preferencesAllowed.mockReset();
});

describe("switchableLocales", () => {
  it("is every supported locale except en-XA", () => {
    expect(SUPPORTED_LOCALES).toContain("en-XA");
    expect(switchableLocales()).toEqual(SUPPORTED_LOCALES.filter((tag) => tag !== "en-XA"));
    expect(switchableLocales()).toEqual(expect.arrayContaining(["en", "es"]));
  });
});

describe("LanguageSection", () => {
  it("lists Automatic and every locale but en-XA, each label in its own language with lang", async () => {
    await mount(<LanguageSection initial={null} />);
    expect(byId("preferences-language")).not.toBeNull();
    await pick("locale-select", "locale-option-auto");
    // Choosing the current value does nothing.
    expect(fake.update).not.toHaveBeenCalled();
    fireEvent.click(must("locale-select"));
    await waitFor(() => expect(byId("locale-option-es")).not.toBeNull());
    expect(byId("locale-option-en-XA")).toBeNull();
    expect(must("locale-option-auto").textContent).toContain(en["preferences.language.auto"]);
    expect(must("locale-option-auto").textContent).toContain(en["preferences.language.autoHint"]);
    const es = must("locale-option-es");
    expect(es.querySelector('[lang="es"]')?.textContent).toBe("Español");
    expect(es.textContent).toContain("Spanish");
    const english = must("locale-option-en");
    expect(english.querySelector('[lang="en"]')?.textContent).toBe("English");
    // Shown in English already: no second name.
    expect(english.textContent).toBe("English");
  });

  it("the select is labelled and described", async () => {
    await mount(<LanguageSection initial={null} />);
    const trigger = screen.getByRole("combobox", { name: en["preferences.language.label"] });
    expect(trigger.getAttribute("data-testid")).toBe("locale-select");
    const described = document.getElementById(trigger.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(en["preferences.language.description"]);
    expect(must("locale-save-status").getAttribute("aria-live")).toBe("polite");
    expect(must("locale-save-status").dataset.state).toBe("idle");
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
  });

  it("shows the saved choice from me.get: null is auto, a tag is that tag", async () => {
    let answer: (v: { locale: string | null }) => void = () => undefined;
    fake.get.mockImplementation(() => new Promise((r) => (answer = r)));
    await mount(<LanguageSection initial={null} />);
    // The stand-in until me.get answers.
    expect(must("locale-select").dataset.value).toBe("auto");
    await act(async () => answer({ locale: "es" }));
    expect(must("locale-select").dataset.value).toBe("es");
    expect(must("locale-select").querySelector('[lang="es"]')?.textContent).toBe("Español");
    cleanup();

    fake.get.mockImplementation(() => new Promise((r) => (answer = r)));
    await mount(<LanguageSection initial="es" />);
    expect(must("locale-select").dataset.value).toBe("es");
    await act(async () => answer({ locale: null }));
    expect(must("locale-select").dataset.value).toBe("auto");
    expect(must("locale-select").textContent).toContain(en["preferences.language.auto"]);
  });

  it("choosing a language saves it, then applies it, and stays saving until the remount", async () => {
    await mount(<LanguageSection initial={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-es");
    await waitFor(() => expect(fake.applyLocale).toHaveBeenCalledWith("es"));
    expect(fake.update).toHaveBeenCalledWith({ locale: "es" });
    expect(fake.update.mock.invocationCallOrder[0]).toBeLessThan(fake.applyLocale.mock.invocationCallOrder[0] ?? 0);
    expect(must("locale-select").dataset.value).toBe("es");
    // No "Saved" in the old language: the remounted page announces it once, in the new one.
    await act(async () => undefined);
    expect(must("locale-save-status").dataset.state).toBe("saving");
    expect(must("locale-save-status").textContent).toBe(en["preferences.language.saving"]);
    expect(must("locale-select").hasAttribute("data-disabled")).toBe(true);
  });

  it("when the catalog fails to load, it reloads the root loader and settles on Saved", async () => {
    fake.applyLocale.mockRejectedValue(new Error("chunk"));
    const router = await mount(<LanguageSection initial={null} />);
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-es");
    await waitFor(() => expect(must("locale-save-status").dataset.state).toBe("saved"));
    expect(invalidate).toHaveBeenCalled();
    expect(must("locale-select").hasAttribute("data-disabled")).toBe(false);
    cleanup();
    // Nothing carried: the next visit is quiet.
    await mount(<LanguageSection initial="es" />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    expect(must("locale-save-status").dataset.state).toBe("idle");
  });

  it("a save carried for a remount expires after ten seconds", async () => {
    await mount(<LanguageSection initial={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-es");
    await waitFor(() => expect(fake.applyLocale).toHaveBeenCalled());
    cleanup();
    vi.setSystemTime(Date.now() + 10_001);
    fake.get.mockImplementation(() => new Promise(() => undefined));
    await mount(<LanguageSection initial={null} />);
    expect(must("locale-select").dataset.value).toBe("auto");
    await act(async () => new Promise((r) => setTimeout(r, 150)));
    expect(must("locale-save-status").dataset.state).toBe("idle");
  });

  it("the page remounted by the switch keeps the choice and announces Saved after mount", async () => {
    await mount(<LanguageSection initial={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-es");
    await waitFor(() => expect(fake.applyLocale).toHaveBeenCalled());
    cleanup();
    // The root loader has not answered yet: me.get still says auto, the stand-in is null.
    let answer: (v: { locale: string | null }) => void = () => undefined;
    fake.get.mockImplementation(() => new Promise((r) => (answer = r)));
    await mount(<LanguageSection initial={null} />);
    expect(must("locale-select").dataset.value).toBe("es");
    await waitFor(() => expect(must("locale-save-status").dataset.state).toBe("saved"));
    await act(async () => answer({ locale: "es" }));
    expect(must("locale-select").dataset.value).toBe("es");
    cleanup();
    // Taken once: the next visit is quiet.
    fake.get.mockResolvedValue({ locale: "es" });
    await mount(<LanguageSection initial="es" />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    expect(must("locale-save-status").dataset.state).toBe("idle");
  });

  it("choosing Automatic saves null and reloads the root loader instead of applying a tag", async () => {
    fake.get.mockResolvedValue({ locale: "es" });
    const router = await mount(<LanguageSection initial="es" />);
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-auto");
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(fake.update).toHaveBeenCalledWith({ locale: null });
    expect(fake.applyLocale).not.toHaveBeenCalled();
    expect(must("locale-select").dataset.value).toBe("auto");
    // The loader data names no locale, so nothing will switch: settle here.
    expect(must("locale-save-status").dataset.state).toBe("saved");
  });

  it("Automatic resolving to the language shown announces Saved here and carries nothing", async () => {
    fake.boot = { me: ME, locale: "en", localeFromUser: false };
    fake.get.mockResolvedValue({ locale: "en" });
    const router = await mount(<LanguageSection initial="en" />);
    vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-auto");
    await waitFor(() => expect(must("locale-save-status").dataset.state).toBe("saved"));
    expect(must("locale-select").hasAttribute("data-disabled")).toBe(false);
    cleanup();
    // Back within ten seconds: quiet, and the value comes from initial, not a stale carry.
    fake.get.mockImplementation(() => new Promise(() => undefined));
    await mount(<LanguageSection initial="en" />);
    expect(must("locale-select").dataset.value).toBe("en");
    await act(async () => new Promise((r) => setTimeout(r, 150)));
    expect(must("locale-save-status").dataset.state).toBe("idle");
  });

  it("Automatic resolving to another language leaves Saved to the remounted page", async () => {
    fake.boot = { me: ME, locale: "es", localeFromUser: false };
    fake.get.mockResolvedValue({ locale: "en" });
    const router = await mount(<LanguageSection initial="en" />);
    vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-auto");
    await waitFor(() => expect(fake.update).toHaveBeenCalledWith({ locale: null }));
    await act(async () => undefined);
    expect(must("locale-save-status").dataset.state).toBe("saving");
    cleanup();
    fake.get.mockImplementation(() => new Promise(() => undefined));
    await mount(<LanguageSection initial={null} />);
    expect(must("locale-select").dataset.value).toBe("auto");
    await waitFor(() => expect(must("locale-save-status").dataset.state).toBe("saved"));
  });

  it("a choice made before me.get answers wins over its answer", async () => {
    let answer: (v: { locale: string | null }) => void = () => undefined;
    fake.get.mockImplementation(() => new Promise((r) => (answer = r)));
    await mount(<LanguageSection initial={null} />);
    await pick("locale-select", "locale-option-es");
    await waitFor(() => expect(fake.applyLocale).toHaveBeenCalledWith("es"));
    await act(async () => answer({ locale: null }));
    expect(must("locale-select").dataset.value).toBe("es");
  });

  it("an API error restores the previous value and toasts", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    fake.update.mockRejectedValue(new Error("boom"));
    await mount(<LanguageSection initial={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await pick("locale-select", "locale-option-es");
    await waitFor(() => expect(error).toHaveBeenCalledWith(en["localeSwitcher.saveFailed"]));
    expect(must("locale-select").dataset.value).toBe("auto");
    expect(must("locale-save-status").dataset.state).toBe("error");
    expect(fake.applyLocale).not.toHaveBeenCalled();
  });
});

describe("FooterLocaleSwitcher", () => {
  it("shows the language icon and the current language, named for screen readers", async () => {
    await mount(<FooterLocaleSwitcher>{en["preferences.footerLanguage"]}</FooterLocaleSwitcher>);
    const trigger = must("footer-locale-switcher");
    expect(trigger.dataset.locale).toBe("en");
    expect(trigger.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger.querySelector('[lang="en"]')?.textContent).toBe("English");
    expect(screen.getByRole("button", { name: /Language\s*English/ })).toBe(trigger);
  });

  it("lists every locale but en-XA, no Automatic, each label with lang", async () => {
    await mount(<FooterLocaleSwitcher />);
    fireEvent.click(must("footer-locale-switcher"));
    await waitFor(() => expect(byId("footer-locale-option-es")).not.toBeNull());
    expect(byId("footer-locale-option-en-XA")).toBeNull();
    expect(byId("footer-locale-option-auto")).toBeNull();
    expect(must("footer-locale-option-es").querySelector('[lang="es"]')?.textContent).toBe("Español");
    expect(must("footer-locale-option-en").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelectorAll('[data-testid^="footer-locale-option-"]')).toHaveLength(
      switchableLocales().length,
    );
  });

  it("signed out without Preferences consent keeps the choice in the tab, then applies it", async () => {
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(fake.rememberLocale).toHaveBeenCalledWith("es", { preferencesAllowed: false }));
    expect(fake.applyLocale).toHaveBeenCalledWith("es");
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("signed out with Preferences consent writes the cookie", async () => {
    fake.preferencesAllowed.mockReturnValue(true);
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(fake.applyLocale).toHaveBeenCalledWith("es"));
    await waitFor(() => expect(fake.rememberLocale).toHaveBeenCalledWith("es", { preferencesAllowed: true }));
    // Kept only once the switch worked.
    expect(fake.applyLocale.mock.invocationCallOrder[0]).toBeLessThan(
      fake.rememberLocale.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("signed out, a catalog that fails to load toasts, keeps nothing and re-enables the trigger", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    fake.applyLocale.mockRejectedValue(new Error("chunk"));
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(error).toHaveBeenCalledWith(en["localeSwitcher.saveFailed"]));
    expect(fake.rememberLocale).not.toHaveBeenCalled();
    await waitFor(() => expect(must("footer-locale-switcher").hasAttribute("disabled")).toBe(false));
  });

  it("signed in, a catalog that fails to load reloads the root and says a reload applies it", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    fake.boot = { me: ME };
    fake.applyLocale.mockRejectedValue(new Error("chunk"));
    const router = await mount(<FooterLocaleSwitcher />);
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(error).toHaveBeenCalledWith(en["localeSwitcher.appliesOnReload"]));
    expect(fake.update).toHaveBeenCalledWith({ locale: "es" });
    expect(invalidate).toHaveBeenCalled();
    expect(fake.rememberLocale).not.toHaveBeenCalled();
    expect(must("footer-locale-switcher").hasAttribute("disabled")).toBe(false);
  });

  it("signed in with Preferences consent passes the consent on", async () => {
    fake.boot = { me: ME };
    fake.preferencesAllowed.mockReturnValue(true);
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(fake.rememberLocale).toHaveBeenCalledWith("es", { preferencesAllowed: true }));
    expect(fake.update).toHaveBeenCalledWith({ locale: "es" });
  });

  it("signed in saves users.locale first, then remembers and applies", async () => {
    fake.boot = { me: ME };
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(fake.rememberLocale).toHaveBeenCalled());
    expect(fake.update).toHaveBeenCalledWith({ locale: "es" });
    expect(fake.update.mock.invocationCallOrder[0]).toBeLessThan(fake.applyLocale.mock.invocationCallOrder[0] ?? 0);
    expect(fake.applyLocale.mock.invocationCallOrder[0]).toBeLessThan(
      fake.rememberLocale.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("signed in, a failed save toasts and switches nothing", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => 1);
    fake.boot = { me: ME };
    fake.update.mockRejectedValue(new Error("boom"));
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-es");
    await waitFor(() => expect(error).toHaveBeenCalledWith(en["localeSwitcher.saveFailed"]));
    expect(fake.rememberLocale).not.toHaveBeenCalled();
    expect(fake.applyLocale).not.toHaveBeenCalled();
    expect(must("footer-locale-switcher").hasAttribute("disabled")).toBe(false);
  });

  it("choosing the language already shown does nothing", async () => {
    await mount(<FooterLocaleSwitcher />);
    await pick("footer-locale-switcher", "footer-locale-option-en");
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.rememberLocale).not.toHaveBeenCalled();
    expect(fake.applyLocale).not.toHaveBeenCalled();
  });

  it("is reachable with the keyboard", async () => {
    await mount(<FooterLocaleSwitcher />);
    const trigger = must("footer-locale-switcher");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(byId("footer-locale-option-es")).not.toBeNull());
  });
});
