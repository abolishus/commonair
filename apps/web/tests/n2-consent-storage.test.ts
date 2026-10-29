// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Cookie consent in the browser: the consent cookie's format and attributes, `preferencesAllowed`,
 * the consent-gated Preferences writers (theme, locale, sidebar) and saving to `legal.consent`
 * (with a fake API client): what is sent, the cookie before the network, the pending/retry rules,
 * a stale policy version and the signed-in re-record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  policyVersion: "v2",
  get: vi.fn<(input: { kind: string }) => Promise<unknown>>(),
  consent: vi.fn<(input: unknown) => Promise<{ ok: true }>>(),
  rememberLocale: vi.fn<(tag: string, opts: { preferencesAllowed: boolean }) => void>(),
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    legal: {
      get: (input: { kind: string }) => fake.get(input),
      consent: (input: unknown) => fake.consent(input),
    },
  };
  return { ...actual, api: () => client };
});

vi.mock("../src/i18n/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/i18n/client.ts")>();
  return {
    ...actual,
    rememberLocale: (tag: string, opts: { preferencesAllowed: boolean }) => {
      fake.rememberLocale(tag, opts);
      actual.rememberLocale(tag, opts);
    },
  };
});

const consent = await import("../src/lib/consent.ts");
const theme = await import("../src/lib/theme.ts");
const { LOCALE_SESSION_KEY } = await import("../src/i18n/client.ts");
const {
  CONSENT_CATEGORIES,
  CONSENT_COOKIE,
  CONSENT_ID_COOKIE,
  CONSENT_RETRY_KEY,
  anonymousId,
  consentCookieString,
  consentPrompt,
  consentSnapshot,
  grantPreferences,
  initConsent,
  isConsentFreePath,
  parseConsent,
  preferencesAllowed,
  resetConsentForTests,
  saveConsent,
  serializeConsent,
  withdrawPreferences,
} = consent;

class RpcError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function policy(version = fake.policyVersion) {
  return {
    id: "doc-cookies",
    kind: "cookies" as const,
    version,
    title: "Cookie policy",
    body: "Text",
    isDraft: true,
    requiresAcceptance: false,
    publishedAt: "2026-10-29T00:00:00.000Z",
  };
}

function cookies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function clearCookies(): void {
  for (const name of Object.keys(cookies()))
    document.cookie = `${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function setConsentCookie(value: {
  version: string;
  preferences: boolean;
  recorded: "user" | "anonymous" | "pending";
}) {
  document.cookie = `${CONSENT_COOKIE}=${serializeConsent(value)}; path=/`;
}

/** happy-dom's control object (not in the DOM lib types). */
const happyDom = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fake.policyVersion = "v2";
  fake.get.mockReset().mockImplementation(async () => policy());
  fake.consent.mockReset().mockResolvedValue({ ok: true });
  fake.rememberLocale.mockReset();
  resetConsentForTests();
  clearCookies();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the consent cookie", () => {
  it("round-trips, including versions with dots and odd characters", () => {
    for (const value of [
      { version: "2026-10-29-i18n-draft", preferences: true, recorded: "user" as const },
      { version: "v1.2.3", preferences: false, recorded: "anonymous" as const },
      { version: "a b;c=d,é", preferences: true, recorded: "pending" as const },
      { version: "", preferences: false, recorded: "pending" as const },
    ]) {
      const serialized = serializeConsent(value);
      expect(serialized).toMatch(/^[A-Za-z0-9._~%-]+$/);
      expect(parseConsent(`other=1; ${CONSENT_COOKIE}=${serialized}; x=y`)).toEqual(value);
    }
  });

  it("is null for anything malformed", () => {
    for (const header of [
      undefined,
      null,
      "",
      "a=b",
      `${CONSENT_COOKIE}=`,
      `${CONSENT_COOKIE}=garbage`,
      `${CONSENT_COOKIE}=2.1.user.v1`,
      `${CONSENT_COOKIE}=1.2.user.v1`,
      `${CONSENT_COOKIE}=1.1.someone.v1`,
      `${CONSENT_COOKIE}=1.1.user`,
      `${CONSENT_COOKIE}=1.1.user.%E0%A4%A`,
      `${CONSENT_COOKIE}=1.1.user.${"x".repeat(65)}`,
    ])
      expect(parseConsent(header), String(header)).toBeNull();
  });

  it("lasts 365 days, samesite=lax, secure only on https, never HttpOnly", () => {
    const cookie = consentCookieString(CONSENT_COOKIE, "v");
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("max-age=31536000");
    expect(31_536_000 / 86_400).toBe(365);
    expect(cookie).toContain("samesite=lax");
    expect(cookie).not.toContain("secure");
    expect(cookie.toLowerCase()).not.toContain("httponly");
    happyDom().setURL("https://air.test/");
    try {
      expect(consentCookieString(CONSENT_COOKIE, "v")).toMatch(/; secure$/);
    } finally {
      happyDom().setURL("http://localhost:3000/");
    }
  });

  it("mirrors the server's CONSENT_CATEGORIES", () => {
    const source = readFileSync(join(import.meta.dirname, "../../../packages/db/src/legal/index.ts"), "utf8");
    const match = source.match(/export const CONSENT_CATEGORIES = \[([^\]]*)\] as const;/);
    expect(match).not.toBeNull();
    const server = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...CONSENT_CATEGORIES]).toEqual(server);
  });

  it("asks on overlay and embed paths never", () => {
    expect(isConsentFreePath("/overlay/alerts")).toBe(true);
    expect(isConsentFreePath("/embed/somechannel")).toBe(true);
    expect(isConsentFreePath("/")).toBe(false);
    expect(isConsentFreePath("/embedded")).toBe(false);
    expect(isConsentFreePath("/overlays")).toBe(false);
  });
});

describe("preferencesAllowed", () => {
  it("is false with no stored choice", () => {
    expect(preferencesAllowed()).toBe(false);
  });

  it("follows the stored choice", () => {
    setConsentCookie({ version: "v2", preferences: false, recorded: "user" });
    expect(preferencesAllowed()).toBe(false);
    setConsentCookie({ version: "v2", preferences: true, recorded: "user" });
    expect(preferencesAllowed()).toBe(true);
  });

  it("is false for a choice made under an older policy, once the tab knows the current one", async () => {
    setConsentCookie({ version: "v1", preferences: true, recorded: "anonymous" });
    expect(preferencesAllowed()).toBe(true);
    await initConsent({ signedIn: false });
    expect(consentSnapshot().policy?.version).toBe("v2");
    expect(preferencesAllowed()).toBe(false);
    expect(consentPrompt(consentSnapshot().stored, "v2")).toBe("policy-changed");
    expect(consentPrompt(null, "v2")).toBe("none");
    expect(consentPrompt({ version: "v2", preferences: false, recorded: "user" }, "v2")).toBeNull();
  });
});

describe("another tab's choice", () => {
  it("a withdrawal elsewhere applies here at once, and a grant too", async () => {
    setConsentCookie({ version: "v2", preferences: true, recorded: "user" });
    await initConsent({ signedIn: true });
    expect(preferencesAllowed()).toBe(true);

    // Tab A withdraws: it rewrites the shared cookie behind this tab's store.
    setConsentCookie({ version: "v2", preferences: false, recorded: "user" });
    expect(preferencesAllowed()).toBe(false);
    theme.storeTheme("light");
    expect(cookies()[theme.THEME_COOKIE]).toBeUndefined();
    expect(theme.tabTheme()).toBe("light");

    // Tab A grants again.
    setConsentCookie({ version: "v2", preferences: true, recorded: "user" });
    expect(preferencesAllowed()).toBe(true);
  });

  it("the store follows the cookie when the tab becomes visible", async () => {
    await initConsent({ signedIn: false });
    expect(consentSnapshot().stored).toBeNull();
    setConsentCookie({ version: "v2", preferences: false, recorded: "anonymous" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(consentSnapshot().stored).toEqual({ version: "v2", preferences: false, recorded: "anonymous" });
  });
});

describe("the anonymous id", () => {
  it("is 32 lowercase hex characters, created once", () => {
    const id = anonymousId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id.length).toBeGreaterThanOrEqual(16);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(cookies()[CONSENT_ID_COOKIE]).toBe(id);
    expect(anonymousId()).toBe(id);
  });

  it("is created only when a signed-out visitor saves", async () => {
    await initConsent({ signedIn: true });
    await saveConsent({ preferences: false });
    expect(cookies()[CONSENT_ID_COOKIE]).toBeUndefined();

    resetConsentForTests();
    clearCookies();
    await initConsent({ signedIn: false });
    expect(cookies()[CONSENT_ID_COOKIE]).toBeUndefined();
    await saveConsent({ preferences: false });
    expect(cookies()[CONSENT_ID_COOKIE]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("consent-gated Preferences writers", () => {
  it("storeTheme with consent writes the cookie", () => {
    setConsentCookie({ version: "v2", preferences: true, recorded: "user" });
    theme.storeTheme("light");
    expect(cookies()[theme.THEME_COOKIE]).toBe("light");
    expect(sessionStorage.getItem(theme.THEME_SESSION_KEY)).toBeNull();
  });

  it("storeTheme with consent drops an old tab-only theme, so it cannot override the cookie", () => {
    sessionStorage.setItem(theme.THEME_SESSION_KEY, "system");
    setConsentCookie({ version: "v2", preferences: true, recorded: "user" });
    theme.storeTheme("light");
    expect(cookies()[theme.THEME_COOKIE]).toBe("light");
    expect(theme.tabTheme()).toBeUndefined();
  });

  it("storeTheme without consent keeps the tab's theme and expires the cookie", () => {
    document.cookie = `${theme.THEME_COOKIE}=dark; path=/`;
    theme.storeTheme("light");
    expect(cookies()[theme.THEME_COOKIE]).toBeUndefined();
    expect(sessionStorage.getItem(theme.THEME_SESSION_KEY)).toBe("light");
    expect(theme.tabTheme()).toBe("light");

    setConsentCookie({ version: "v2", preferences: false, recorded: "user" });
    theme.storeTheme("system");
    expect(cookies()[theme.THEME_COOKIE]).toBeUndefined();
    expect(theme.tabTheme()).toBe("system");
  });

  it("grant moves the tab's theme and language into cookies", () => {
    sessionStorage.setItem(theme.THEME_SESSION_KEY, "light");
    sessionStorage.setItem(LOCALE_SESSION_KEY, "en-XA");
    grantPreferences();
    expect(cookies()[theme.THEME_COOKIE]).toBe("light");
    expect(sessionStorage.getItem(theme.THEME_SESSION_KEY)).toBeNull();
    expect(fake.rememberLocale).toHaveBeenCalledWith("en-XA", { preferencesAllowed: true });
    expect(cookies()["commonair-locale"]).toBe("en-XA");
    expect(sessionStorage.getItem(LOCALE_SESSION_KEY)).toBeNull();
  });

  it("grant with nothing tab-only writes nothing", () => {
    grantPreferences();
    expect(cookies()[theme.THEME_COOKIE]).toBeUndefined();
    expect(fake.rememberLocale).not.toHaveBeenCalled();
  });

  it("withdraw expires the theme, locale and sidebar cookies and keeps the tab's values", () => {
    document.cookie = `${theme.THEME_COOKIE}=light; path=/`;
    document.cookie = "commonair-locale=en-XA; path=/";
    document.cookie = "sidebar_state=false; path=/";
    withdrawPreferences();
    const after = cookies();
    expect(after[theme.THEME_COOKIE]).toBeUndefined();
    expect(after["commonair-locale"]).toBeUndefined();
    expect(after["sidebar_state"]).toBeUndefined();
    expect(sessionStorage.getItem(theme.THEME_SESSION_KEY)).toBe("light");
    expect(sessionStorage.getItem(LOCALE_SESSION_KEY)).toBe("en-XA");
  });

  it("withdraw keeps a tab-only language that is already there", () => {
    sessionStorage.setItem(LOCALE_SESSION_KEY, "en");
    document.cookie = "commonair-locale=en-XA; path=/";
    withdrawPreferences();
    expect(sessionStorage.getItem(LOCALE_SESSION_KEY)).toBe("en");
  });

  it("storage that throws breaks nothing", async () => {
    const throwing = () => {
      throw new Error("blocked");
    };
    const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: throwing });
    Object.defineProperty(document, "cookie", { configurable: true, get: throwing, set: throwing });
    try {
      expect(preferencesAllowed()).toBe(false);
      expect(() => theme.storeTheme("light")).not.toThrow();
      expect(theme.tabTheme()).toBeUndefined();
      expect(() => grantPreferences()).not.toThrow();
      expect(() => withdrawPreferences()).not.toThrow();
      await expect(initConsent({ signedIn: false })).resolves.toBeUndefined();
      await expect(saveConsent({ preferences: true })).resolves.toBeNull();
      expect(consentSnapshot().stored?.preferences).toBe(true);
      // Cookies blocked: this tab's in-memory choice stands in.
      expect(preferencesAllowed()).toBe(true);
    } finally {
      // Drop the own property: the prototype's accessor is back.
      Reflect.deleteProperty(document, "cookie");
      if (storage) Object.defineProperty(globalThis, "sessionStorage", storage);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});

describe("saving", () => {
  it("signed out: sends the anonymous id, essential always true, and marks it anonymous", async () => {
    await initConsent({ signedIn: false });
    await saveConsent({ preferences: false });
    expect(fake.consent).toHaveBeenCalledTimes(1);
    const body = fake.consent.mock.calls[0]?.[0];
    expect(body).toEqual({
      choices: { essential: true, preferences: false },
      policyVersion: "v2",
      anonymousId: cookies()[CONSENT_ID_COOKIE],
    });
    expect(parseConsent(document.cookie)).toEqual({ version: "v2", preferences: false, recorded: "anonymous" });
  });

  it("signed in: no anonymous id, marks it user", async () => {
    await initConsent({ signedIn: true });
    await saveConsent({ preferences: true });
    expect(fake.consent.mock.calls[0]?.[0]).toEqual({
      choices: { essential: true, preferences: true },
      policyVersion: "v2",
    });
    expect(parseConsent(document.cookie)?.recorded).toBe("user");
    expect(preferencesAllowed()).toBe(true);
  });

  it("writes the cookie before the request resolves", async () => {
    await initConsent({ signedIn: false });
    let resolve: (v: { ok: true }) => void = () => {};
    fake.consent.mockImplementation(() => new Promise((r) => (resolve = r)));
    const saving = saveConsent({ preferences: true });
    expect(parseConsent(document.cookie)).toEqual({ version: "v2", preferences: true, recorded: "pending" });
    expect(preferencesAllowed()).toBe(true);
    resolve({ ok: true });
    await saving;
    expect(parseConsent(document.cookie)?.recorded).toBe("anonymous");
  });

  it("fetches the cookie policy version once per tab", async () => {
    await initConsent({ signedIn: false });
    await saveConsent({ preferences: true });
    await saveConsent({ preferences: false });
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.get).toHaveBeenCalledWith({ kind: "cookies" });
  });

  it.each([
    ["RATE_LIMITED", "rate_limited"],
    ["network", "network"],
  ] as const)("%s leaves it pending, shows the notice, and retries once on a later load", async (failure, code) => {
    await initConsent({ signedIn: false });
    fake.consent.mockRejectedValueOnce(
      failure === "network" ? new TypeError("Failed to fetch") : new RpcError(failure),
    );
    await saveConsent({ preferences: true });
    expect(parseConsent(document.cookie)?.recorded).toBe("pending");
    expect(consentSnapshot().error).toBe(code);
    // The choice still applies on this device.
    expect(preferencesAllowed()).toBe(true);

    // Next page load in this tab: one silent retry, which fails again.
    resetConsentForTests();
    fake.consent.mockRejectedValueOnce(new RpcError("RATE_LIMITED"));
    await initConsent({ signedIn: false });
    expect(fake.consent).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(CONSENT_RETRY_KEY)).toBe("1");
    expect(consentSnapshot().error).toBeNull();
    expect(parseConsent(document.cookie)?.recorded).toBe("pending");

    // And no more in this tab.
    resetConsentForTests();
    await initConsent({ signedIn: false });
    await flush();
    expect(fake.consent).toHaveBeenCalledTimes(2);
  });

  it("a successful retry marks it recorded", async () => {
    setConsentCookie({ version: "v2", preferences: false, recorded: "pending" });
    await initConsent({ signedIn: false });
    expect(fake.consent).toHaveBeenCalledTimes(1);
    expect(fake.consent.mock.calls[0]?.[0]).toMatchObject({ choices: { essential: true, preferences: false } });
    expect(parseConsent(document.cookie)?.recorded).toBe("anonymous");
  });

  it("a stale policy version refetches and asks again", async () => {
    await initConsent({ signedIn: false });
    fake.policyVersion = "v3";
    fake.consent.mockRejectedValueOnce(new RpcError("BAD_REQUEST"));
    await saveConsent({ preferences: true });
    expect(fake.get).toHaveBeenCalledTimes(2);
    const state = consentSnapshot();
    expect(state.error).toBe("policy_changed");
    expect(state.policy?.version).toBe("v3");
    expect(consentPrompt(state.stored, state.policy?.version ?? null)).toBe("policy-changed");
    expect(preferencesAllowed()).toBe(false);
  });

  it("a signed-in visitor's anonymous record is recorded once as the user", async () => {
    document.cookie = `${CONSENT_ID_COOKIE}=${"a".repeat(32)}; path=/`;
    setConsentCookie({ version: "v2", preferences: true, recorded: "anonymous" });
    await initConsent({ signedIn: true });
    expect(fake.consent).toHaveBeenCalledTimes(1);
    expect(fake.consent.mock.calls[0]?.[0]).toEqual({
      choices: { essential: true, preferences: true },
      policyVersion: "v2",
    });
    expect(parseConsent(document.cookie)?.recorded).toBe("user");

    resetConsentForTests();
    await initConsent({ signedIn: true });
    expect(fake.consent).toHaveBeenCalledTimes(1);
  });

  it("a stored choice for an older policy is not re-recorded on load", async () => {
    setConsentCookie({ version: "v1", preferences: true, recorded: "pending" });
    await initConsent({ signedIn: false });
    expect(fake.consent).not.toHaveBeenCalled();
  });

  it("a stored 'no' expires Preferences cookies on load", async () => {
    setConsentCookie({ version: "v2", preferences: false, recorded: "user" });
    document.cookie = `${theme.THEME_COOKIE}=light; path=/`;
    await initConsent({ signedIn: false });
    expect(cookies()[theme.THEME_COOKIE]).toBeUndefined();
    expect(theme.tabTheme()).toBe("light");
  });

  it("an unreachable policy saves the choice locally, sends nothing, and asks afresh later", async () => {
    fake.get.mockRejectedValue(new TypeError("Failed to fetch"));
    await initConsent({ signedIn: false });
    await expect(saveConsent({ preferences: false })).resolves.toBe("unrecorded");
    expect(fake.consent).not.toHaveBeenCalled();
    expect(parseConsent(document.cookie)).toEqual({ version: "", preferences: false, recorded: "pending" });
    expect(consentSnapshot().error).toBe("unrecorded");
    // No banner while the policy is still unknown.
    expect(consentPrompt(consentSnapshot().stored, null)).toBeNull();

    // Next load, the policy is back: a first ask, not "the policy changed", and no request.
    resetConsentForTests();
    fake.get.mockReset().mockImplementation(async () => policy());
    await initConsent({ signedIn: false });
    expect(fake.consent).not.toHaveBeenCalled();
    expect(consentPrompt(consentSnapshot().stored, "v2")).toBe("none");
    expect(preferencesAllowed()).toBe(false);
  });

  it("a refusal that is not a policy change does not promise a retry", async () => {
    await initConsent({ signedIn: false });
    fake.consent.mockRejectedValueOnce(new RpcError("BAD_REQUEST"));
    await expect(saveConsent({ preferences: true })).resolves.toBe("rejected");
    expect(consentSnapshot().error).toBe("rejected");
    expect(parseConsent(document.cookie)).toMatchObject({ version: "v2", preferences: true, recorded: "pending" });
  });

  it("a repeated save while one is in flight sends one request", async () => {
    await initConsent({ signedIn: false });
    let resolve: (value: { ok: true }) => void = () => {};
    fake.consent.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = saveConsent({ preferences: true });
    const second = saveConsent({ preferences: true });
    await flush();
    resolve({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(fake.consent).toHaveBeenCalledTimes(1);
  });

  it("a different choice while one is in flight waits, then wins", async () => {
    await initConsent({ signedIn: false });
    let resolve: (value: { ok: true }) => void = () => {};
    fake.consent.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = saveConsent({ preferences: true });
    const second = saveConsent({ preferences: false });
    await flush();
    expect(fake.consent).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await Promise.all([first, second]);
    expect(fake.consent).toHaveBeenCalledTimes(2);
    expect(fake.consent.mock.calls[1]?.[0]).toMatchObject({ choices: { essential: true, preferences: false } });
    expect(parseConsent(document.cookie)).toMatchObject({ preferences: false, recorded: "anonymous" });
  });

  it("keeps signedIn current after the first init", async () => {
    await initConsent({ signedIn: false });
    await initConsent({ signedIn: true });
    expect(consentSnapshot().signedIn).toBe(true);
    await saveConsent({ preferences: true });
    expect(fake.consent.mock.calls[0]?.[0]).not.toHaveProperty("anonymousId");
  });
});
