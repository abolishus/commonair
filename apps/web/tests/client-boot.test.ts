// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The client entry's boot wiring (`src/client.tsx`): the locale loads first, then the hydration
 * guard decides, and the entry does what it says (hydrate, reload once, hydrate anyway, or nothing
 * on a stale document). `hydrateRoot`, the locale boot and `StartClient` are replaced, so each
 * test evaluates the entry module fresh against the document as the test arranged it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BOOT_RELOAD_KEY } from "../src/hydration-guard.ts";

const mocks = vi.hoisted(() => ({
  hydrateRoot: vi.fn<(container: unknown, children: unknown) => void>(),
  bootClientLocale: vi.fn<(tag: string) => Promise<void>>(),
}));

vi.mock("react-dom/client", () => ({ hydrateRoot: mocks.hydrateRoot }));
vi.mock("@tanstack/react-start/client", () => ({ StartClient: () => null }));
vi.mock("../src/i18n/client.ts", () => ({ bootClientLocale: mocks.bootClientLocale }));

let reload: ReturnType<typeof vi.fn<() => void>>;
let warn: ReturnType<typeof vi.spyOn>;

/** Evaluate the entry, let the locale settle (resolved or rejected), and flush the hydrate step. */
async function boot(locale: "ok" | "fail" = "ok"): Promise<void> {
  mocks.bootClientLocale.mockImplementation(() =>
    locale === "ok" ? Promise.resolve() : Promise.reject(new Error("catalog failed")),
  );
  vi.resetModules();
  await import("../src/client.tsx");
  await vi.waitFor(() => expect(mocks.bootClientLocale).toHaveBeenCalled());
  // `.then(hydrate, hydrate)` runs on a later microtask than the import resolves.
  await new Promise((r) => setTimeout(r, 0));
}

const bootAttr = () => document.documentElement.dataset.boot;

beforeEach(() => {
  mocks.hydrateRoot.mockReset();
  mocks.bootClientLocale.mockReset();
  reload = vi.fn<() => void>();
  Object.defineProperty(window.location, "reload", { configurable: true, value: reload });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  window.sessionStorage.clear();
  delete document.documentElement.dataset.boot;
  document.documentElement.lang = "es";
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(window, "$_TSR");
});

afterEach(() => {
  warn.mockRestore();
  Reflect.deleteProperty(window, "$_TSR");
});

describe("client entry", () => {
  it("loads the server's locale, then hydrates the document with no data-boot mark", async () => {
    Reflect.set(window, "$_TSR", { buffer: [] });
    await boot();
    expect(mocks.bootClientLocale).toHaveBeenCalledWith("es");
    expect(mocks.hydrateRoot).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateRoot.mock.calls[0]?.[0]).toBe(document);
    expect(bootAttr()).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(BOOT_RELOAD_KEY)).toBeNull();
  });

  it("still hydrates when the catalog fails to load", async () => {
    Reflect.set(window, "$_TSR", { buffer: [] });
    await boot("fail");
    expect(mocks.hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it("reloads once for a missing bootstrap, marks the document, and does not hydrate", async () => {
    await boot();
    expect(bootAttr()).toBe("reload");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateRoot).not.toHaveBeenCalled();
    expect(Number(window.sessionStorage.getItem(BOOT_RELOAD_KEY))).toBeGreaterThan(0);
  });

  it("after that reload, a second miss hydrates anyway instead of reloading again", async () => {
    await boot();
    expect(reload).toHaveBeenCalledTimes(1);
    delete document.documentElement.dataset.boot;
    await boot();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(bootAttr()).toBe("missing");
    expect(mocks.hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it("never reloads without sessionStorage to remember the reload in", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      await boot();
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
      else Reflect.deleteProperty(window, "sessionStorage");
    }
    expect(reload).not.toHaveBeenCalled();
    expect(bootAttr()).toBe("missing");
    expect(mocks.hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it("never reloads a URL with a one-time parameter (OAuth callback, magic link)", async () => {
    for (const search of ["?code=abc&state=xyz", "?token=t", "?nonce=n"]) {
      mocks.hydrateRoot.mockReset();
      window.sessionStorage.clear();
      window.history.replaceState(null, "", `/auth/callback${search}`);
      await boot();
      expect(reload, search).not.toHaveBeenCalled();
      expect(bootAttr(), search).toBe("missing");
      expect(mocks.hydrateRoot, search).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(BOOT_RELOAD_KEY), search).toBeNull();
    }
  });

  it("does nothing when the window moved on to another document before the locale loaded", async () => {
    let finish: () => void = () => undefined;
    mocks.bootClientLocale.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    vi.resetModules();
    await import("../src/client.tsx");
    const entryHtml = document.documentElement;
    const other = document.implementation.createHTMLDocument("next");
    const original = Object.getOwnPropertyDescriptor(window, "document");
    Object.defineProperty(window, "document", { configurable: true, get: () => other });
    try {
      finish();
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      if (original) Object.defineProperty(window, "document", original);
      else Reflect.deleteProperty(window, "document");
    }
    expect(mocks.hydrateRoot).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(entryHtml.dataset.boot).toBeUndefined();
    expect(other.documentElement.dataset.boot).toBeUndefined();
    expect(window.sessionStorage.getItem(BOOT_RELOAD_KEY)).toBeNull();
  });
});
