// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vite-plus/test";
import type { BrowserFleet } from "../browser-viewer.ts";
import { WEB_LOCALE_COOKIE, WebSession, browserLocale, localeCookie } from "../web/session.ts";

const WEB = "http://web.example.test:3000/some/path";

function fakeFleet() {
  const context = {
    addCookies: vi.fn<(cookies: unknown[]) => Promise<void>>(async () => undefined),
    addInitScript: vi.fn<(script: unknown) => Promise<void>>(async () => undefined),
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const newContext = vi.fn<(opts: Record<string, unknown>) => Promise<typeof context>>(async () => context);
  const fleet = { browser: async () => ({ newContext }) } as unknown as BrowserFleet;
  return { fleet, context, newContext };
}

const open = (fleet: BrowserFleet, locale?: Parameters<typeof localeCookie>[1]) =>
  WebSession.open({ fleet, engine: "chromium", webUrl: WEB, probeScript: "", label: "t", locale });

describe("localeCookie", () => {
  test("is scoped to the web origin only (host-only, no domain)", () => {
    expect(localeCookie(WEB, "en-XA")).toEqual({
      name: WEB_LOCALE_COOKIE,
      value: "en-XA",
      url: "http://web.example.test:3000",
      sameSite: "Lax",
    });
    expect(localeCookie(WEB, "en-XA")).not.toHaveProperty("domain");
  });

  test("absent, empty or header-only means no cookie", () => {
    expect(localeCookie(WEB, undefined)).toBeNull();
    expect(localeCookie(WEB, "")).toBeNull();
    expect(localeCookie(WEB, { acceptLanguage: "es" })).toBeNull();
  });

  test("the object form sets the cookie too", () => {
    expect(localeCookie(WEB, { cookie: "es", acceptLanguage: "en" })?.value).toBe("es");
  });
});

describe("browserLocale", () => {
  test("defaults to en-US, as before; acceptLanguage overrides", () => {
    expect(browserLocale(undefined)).toBe("en-US");
    expect(browserLocale("en-XA")).toBe("en-US");
    expect(browserLocale({ acceptLanguage: "es" })).toBe("es");
  });
});

describe("WebSession.open", () => {
  test("without a locale: no cookie, en-US context, as before", async () => {
    const { fleet, context, newContext } = fakeFleet();
    await open(fleet);
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(newContext).toHaveBeenCalledWith({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  });

  test("with a locale: the cookie for the web origin before any page opens", async () => {
    const { fleet, context } = fakeFleet();
    await open(fleet, "en-XA");
    expect(context.addCookies).toHaveBeenCalledTimes(1);
    expect(context.addCookies).toHaveBeenCalledWith([
      { name: WEB_LOCALE_COOKIE, value: "en-XA", url: "http://web.example.test:3000", sameSite: "Lax" },
    ]);
  });

  test("with acceptLanguage only: the browser locale, no cookie", async () => {
    const { fleet, context, newContext } = fakeFleet();
    await open(fleet, { acceptLanguage: "es" });
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(newContext.mock.calls[0]?.[0]).toMatchObject({ locale: "es" });
  });
});
