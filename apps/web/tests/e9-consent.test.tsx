// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E9-consent pages with a fake API client (docs/testing/e9-selectors.md "Consent", "Device
 * activation", "Connections"; ADR 0027 §1-2): each `developer.oauth.request` outcome, approve and
 * deny through `decide`, the silent re-approval of an existing grant (only without
 * `force_verify`), the device code flow, the connections list with its confirmed revoke, the scope
 * message map, and accessibility basics.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPE_NAMES, type Scope } from "@commonair/contracts/scopes";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ORPCError } from "@orpc/client";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeQueryFrom,
  forcesVerify,
  requestInput,
  validateAuthorizeSearch,
} from "../src/components/oauth/authorize-query.ts";
import { ConsentPage, authorizeError, decideErrorText } from "../src/components/oauth/consent.tsx";
import { Connections } from "../src/components/oauth/connections.tsx";
import { DeviceActivation, usableUserCode } from "../src/components/oauth/device.tsx";
import { SCOPE_MESSAGES, SENSITIVE_SCOPES } from "../src/components/oauth/scope-messages.ts";
import {
  type DeviceConsentDto,
  type GrantDto,
  type Navigator,
  type OAuthClient,
  consentError,
  deviceError,
  formatUserCode,
} from "../src/components/oauth/shared.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({ success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));

afterEach(() => {
  cleanup();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const APP_ID = "0192f000-0000-7000-8000-0000000000a1";
const OWNER_ID = "0192f000-0000-7000-8000-0000000000b1";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const APP = {
  id: APP_ID,
  name: "Chat Helper",
  description: "Answers questions in chat.",
  clientId: "cid_helper",
  owner: { id: OWNER_ID, username: "devdana" },
};
const SCOPES: Scope[] = ["chat:read", "user:read:email"];
const REDIRECT = "http://127.0.0.1:4567/cb";
// A state the router's JSON parsing would mangle (quotes, leading zeros): must come back exactly.
const STATE = '"007" & é';

const queryString = (over: Record<string, string | null> = {}) => {
  const p = new URLSearchParams({
    client_id: APP.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  return `?${p.toString()}`;
};

const notFound = () => new ORPCError("NOT_FOUND", { message: "Unknown client (invalid_client)" });
const precondition = (requirement: string) => new ORPCError("PRECONDITION_FAILED", { data: { requirement } });

/** A fake procedure: any input, a promise back (the components only pass what the contract types). */
type Impl = (input?: unknown) => Promise<unknown>;
const fn = (impl: Impl) => vi.fn<Impl>(impl);
type Fn = ReturnType<typeof fn>;
interface Fake {
  client: OAuthClient;
  request: Fn;
  decide: Fn;
  activation: Fn;
  activate: Fn;
  list: Fn;
  revoke: Fn;
}

function fakeClient(over: Partial<Omit<Fake, "client">> = {}): Fake {
  const f = {
    request: over.request ?? fn(async () => ({ kind: "consent", app: APP, scopes: SCOPES, alreadyGranted: false })),
    decide: over.decide ?? fn(async () => ({ redirectTo: `${REDIRECT}?code=cac_1&state=x` })),
    activation: over.activation ?? fn(async () => deviceConsent()),
    activate: over.activate ?? fn(async () => ({ ok: true })),
    list: over.list ?? fn(async () => [grant()]),
    revoke: over.revoke ?? fn(async () => ({ ok: true })),
  };
  const client = {
    oauth: { request: f.request, decide: f.decide, activation: f.activation, activate: f.activate },
    grants: { list: f.list, revoke: f.revoke },
  } as unknown as OAuthClient;
  return { client, ...f };
}

const deviceConsent = (over: Partial<DeviceConsentDto> = {}): DeviceConsentDto => ({
  app: { ...APP, id: "0192f000-0000-7000-8000-0000000000a2", clientId: "cid_public", name: "Headless Bot" },
  scopes: ["chat:read", "chat:edit"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...over,
});

const grant = (over: Partial<GrantDto> = {}): GrantDto => ({
  app: APP,
  scopes: ["chat:read", "channel:read:subscriptions"],
  authorizedAt: "2026-10-28T10:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

const fakeNavigator = () => {
  const n = { assign: vi.fn<(url: string) => void>(), replace: vi.fn<(url: string) => void>() };
  return n satisfies Navigator;
};

function renderConsent(opts: { search?: string; fake?: Fake; onSwitchAccount?: () => Promise<void> } = {}) {
  const fake = opts.fake ?? fakeClient();
  const navigator = fakeNavigator();
  const onSwitchAccount = opts.onSwitchAccount ?? vi.fn<() => Promise<void>>(async () => undefined);
  wrap(
    <ConsentPage
      query={authorizeQueryFrom(opts.search ?? queryString())}
      client={fake.client}
      me={{ username: "streamsam" }}
      navigator={navigator}
      onSwitchAccount={onSwitchAccount}
    />,
  );
  return { fake, navigator, onSwitchAccount };
}

/** Every `data-testid` seen while the tests render, for the selector-coverage check. */
const seenIds = new Set<string>();
function collectIds() {
  for (const el of document.querySelectorAll("[data-testid]")) seenIds.add(el.getAttribute("data-testid") ?? "");
}

// ── scope copy ───────────────────────────────────────────────────────────────────────────────

describe("scope messages", () => {
  it("every scope has a title and a body in the catalog, under oauth.scope.<name>", () => {
    for (const scope of SCOPE_NAMES) {
      const m = SCOPE_MESSAGES[scope];
      expect(m, scope).toBeDefined();
      const base = `oauth.scope.${scope.replaceAll(":", ".")}`;
      expect(m.title).toBe(`${base}.title`);
      expect(m.body).toBe(`${base}.body`);
      expect(en[m.title], m.title).toBeTruthy();
      expect(en[m.body], m.body).toBeTruthy();
    }
    expect(Object.keys(SCOPE_MESSAGES).sort()).toEqual([...SCOPE_NAMES].sort());
  });

  it("the plain words are not the API reference text", async () => {
    const { SCOPES: reference } = await import("@commonair/contracts/scopes");
    for (const scope of SCOPE_NAMES) expect(en[SCOPE_MESSAGES[scope].body]).not.toBe(reference[scope]);
  });

  it("marks exactly the four sensitive scopes", () => {
    expect([...SENSITIVE_SCOPES].sort()).toEqual(
      ["channel:manage", "channel:manage:points", "moderator:manage:chat", "user:read:email"].sort(),
    );
  });

  it("every key of the namespace starts with oauth.", () => {
    const file = join(import.meta.dirname, "../src/i18n/locales/en/e9-consent.json");
    const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>);
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((k) => !k.startsWith("oauth."))).toEqual([]);
  });
});

// ── the authorize query ──────────────────────────────────────────────────────────────────────

describe("authorize query", () => {
  it("reads the raw query exactly, ignoring unknown parameters", () => {
    const q = authorizeQueryFrom(`${queryString()}&extra=1&force_verify=true`);
    expect(q).toEqual({
      client_id: APP.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "chat:read user:read:email",
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      force_verify: "true",
    });
    expect(forcesVerify(q)).toBe(true);
    expect(forcesVerify({ force_verify: "1" })).toBe(false);
  });

  it("validateSearch is an identity on the OAuth names, so the router never rewrites the URL", () => {
    expect(
      validateAuthorizeSearch({ client_id: "abc", state: 7, force_verify: true, scope: { x: 1 }, other: "x" }),
    ).toEqual({ client_id: "abc", state: 7, force_verify: true });
    expect(validateAuthorizeSearch({ redirect_uri: "x".repeat(5000) })).toEqual({});
    for (const s of [
      "?client_id=abc&state=123&force_verify=true",
      "?client_id=abc&state=1e3",
      "?client_id=abc&state=12345678901234567890123",
      "?client_id=abc&state=%22abc%22&force_verify=false",
      `?${queryString()}`,
    ]) {
      const parsed = defaultParseSearch(s);
      expect(defaultStringifySearch(validateAuthorizeSearch(parsed))).toBe(defaultStringifySearch(parsed));
    }
  });

  it("the raw query keeps values the router's parser would change", () => {
    const q = authorizeQueryFrom("?client_id=abc&state=%22abc%22&force_verify=true");
    expect(q.state).toBe('"abc"');
    expect(forcesVerify(q)).toBe(true);
    expect(authorizeQueryFrom("?state=12345678901234567890123").state).toBe("12345678901234567890123");
    expect(authorizeQueryFrom("?state=1e3").state).toBe("1e3");
    expect(authorizeQueryFrom("?state=007").state).toBe("007");
    expect(authorizeQueryFrom("?state=123").state).toBe("123");
    expect(authorizeQueryFrom(`?state=${"x".repeat(5000)}&client_id=c`)).toEqual({ client_id: "c" });
  });

  it("maps to the request input; no client id or redirect URI never reaches the API", () => {
    const q = authorizeQueryFrom(queryString());
    expect(requestInput(q)).toEqual({
      ok: true,
      input: {
        clientId: APP.clientId,
        redirectUri: REDIRECT,
        responseType: "code",
        scope: "chat:read user:read:email",
        state: STATE,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        forceVerify: false,
      },
    });
    expect(requestInput(authorizeQueryFrom(queryString({ client_id: null })))).toEqual({
      ok: false,
      error: "invalid_client",
    });
    expect(requestInput(authorizeQueryFrom(queryString({ redirect_uri: null })))).toEqual({
      ok: false,
      error: "invalid_redirect_uri",
    });
  });

  it("maps API errors to what the page shows", () => {
    expect(consentError(notFound())).toBe("invalid_client");
    expect(consentError(precondition("app_suspended"))).toBe("app_suspended");
    expect(consentError(precondition("invalid_redirect_uri"))).toBe("invalid_redirect_uri");
    expect(consentError(precondition("other"))).toBe("request_failed");
    expect(consentError(new Error("network"))).toBe("request_failed");
    expect(authorizeError(new ORPCError("BAD_REQUEST"))).toBe("invalid_request");
    expect(decideErrorText(precondition("app_suspended"))).toBe("oauth.consent.decideSuspended");
    expect(decideErrorText(notFound())).toBe("oauth.consent.decideInvalid");
    expect(decideErrorText(new Error("network"))).toBe("oauth.consent.decideFailed");
  });
});

// ── /oauth2/authorize ────────────────────────────────────────────────────────────────────────

describe("consent page", () => {
  it("shows the card: app, owner, one row per scope, sensitive marked; asks with the exact query", async () => {
    const { fake, navigator } = renderConsent();
    const card = await screen.findByTestId("oauth-consent");
    collectIds();
    expect(fake.request).toHaveBeenCalledWith({
      clientId: APP.clientId,
      redirectUri: REDIRECT,
      responseType: "code",
      scope: "chat:read user:read:email",
      state: STATE,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      forceVerify: false,
    });
    expect(card.getAttribute("data-client-id")).toBe(APP.clientId);
    expect(card.getAttribute("data-already-granted")).toBe("false");
    expect(within(card).getByRole("heading", { level: 1 }).textContent).toContain("Chat Helper");
    const owner = screen.getByTestId("oauth-consent-owner");
    expect(owner.textContent).toContain("devdana");
    expect(within(owner).getByRole("link").getAttribute("href")).toBe("/devdana");
    const rows = screen.getAllByTestId("oauth-consent-scope");
    expect(rows.map((r) => r.getAttribute("data-scope"))).toEqual(SCOPES);
    expect(rows[1]?.getAttribute("data-sensitive")).toBe("true");
    expect(within(rows[1] as HTMLElement).getByText(en["oauth.scope.sensitive"])).toBeTruthy();
    expect(screen.getByText(/Signed in as streamsam/)).toBeTruthy();
    // The query's state and redirect URI are never rendered.
    expect(document.body.textContent).not.toContain(STATE);
    expect(document.body.textContent).not.toContain(REDIRECT);
    expect(navigator.assign).not.toHaveBeenCalled();
    expect(navigator.replace).not.toHaveBeenCalled();
  });

  it("approve calls decide with the request and goes to redirectTo; both buttons wait meanwhile", async () => {
    let finish: (v: { redirectTo: string }) => void = () => undefined;
    const decide = fn(() => new Promise<{ redirectTo: string }>((resolve) => (finish = resolve)));
    const { navigator } = renderConsent({ fake: fakeClient({ decide }) });
    fireEvent.click(await screen.findByTestId("oauth-consent-approve"));
    expect(decide).toHaveBeenCalledWith({
      clientId: APP.clientId,
      redirectUri: REDIRECT,
      scope: "chat:read user:read:email",
      state: STATE,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      approve: true,
    });
    expect(screen.getByTestId("oauth-consent-approve")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("oauth-consent-deny")).toHaveProperty("disabled", true);
    await act(async () => finish({ redirectTo: `${REDIRECT}?code=cac_9&state=s` }));
    expect(navigator.assign).toHaveBeenCalledWith(`${REDIRECT}?code=cac_9&state=s`);
    expect(navigator.replace).not.toHaveBeenCalled();
  });

  it("deny calls decide with approve false and goes to redirectTo", async () => {
    const decide = fn(async () => ({ redirectTo: `${REDIRECT}?error=access_denied&state=s` }));
    const { navigator } = renderConsent({ fake: fakeClient({ decide }) });
    fireEvent.click(await screen.findByTestId("oauth-consent-deny"));
    await waitFor(() => expect(navigator.assign).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=s`));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ approve: false, state: STATE }));
  });

  it("a decide failure shows inline and the buttons come back", async () => {
    const decide = fn(async () => {
      throw precondition("app_suspended");
    });
    const { navigator } = renderConsent({ fake: fakeClient({ decide }) });
    fireEvent.click(await screen.findByTestId("oauth-consent-approve"));
    const alert = await screen.findByTestId("oauth-consent-decide-error");
    expect(alert.textContent).toBe(en["oauth.consent.decideSuspended"]);
    expect(screen.getByTestId("oauth-consent-approve")).toHaveProperty("disabled", false);
    expect(navigator.assign).not.toHaveBeenCalled();
  });

  it("a malformed request (BAD_REQUEST) says so, with its own copy", async () => {
    const request = fn(async () => {
      throw new ORPCError("BAD_REQUEST");
    });
    renderConsent({ fake: fakeClient({ request }) });
    const box = await screen.findByTestId("oauth-consent-error");
    expect(box.getAttribute("data-error")).toBe("invalid_request");
    expect(box.textContent).toContain(en["oauth.error.invalidRequest"]);
    expect(box.textContent).not.toContain(en["oauth.consent.decideInvalid"]);
  });

  it("a redirect answer goes straight back without a card", async () => {
    const request = fn(async () => ({ kind: "redirect", redirectTo: `${REDIRECT}?error=invalid_scope&state=s` }));
    const { navigator } = renderConsent({ fake: fakeClient({ request }) });
    await waitFor(() => expect(navigator.replace).toHaveBeenCalledWith(`${REDIRECT}?error=invalid_scope&state=s`));
    expect(screen.queryByTestId("oauth-consent")).toBeNull();
    expect(screen.queryByTestId("oauth-consent-error")).toBeNull();
  });

  it.each([
    ["invalid_client", notFound()],
    ["app_suspended", precondition("app_suspended")],
    ["invalid_redirect_uri", precondition("invalid_redirect_uri")],
  ])("shows %s instead of the card and never redirects", async (code, err) => {
    const request = fn(async () => {
      throw err;
    });
    const { navigator } = renderConsent({ fake: fakeClient({ request }) });
    const box = await screen.findByTestId("oauth-consent-error");
    collectIds();
    expect(box.getAttribute("data-error")).toBe(code);
    expect(screen.getByRole("link", { name: en["oauth.error.home"] }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("button", { name: en["oauth.error.retry"] })).toBeNull();
    expect(screen.queryByTestId("oauth-consent")).toBeNull();
    expect(navigator.assign).not.toHaveBeenCalled();
    expect(navigator.replace).not.toHaveBeenCalled();
  });

  it("without a client id or redirect URI, never asks the API", async () => {
    const fake = fakeClient();
    renderConsent({ fake, search: queryString({ client_id: null }) });
    expect((await screen.findByTestId("oauth-consent-error")).getAttribute("data-error")).toBe("invalid_client");
    cleanup();
    renderConsent({ fake, search: queryString({ redirect_uri: null }) });
    expect((await screen.findByTestId("oauth-consent-error")).getAttribute("data-error")).toBe("invalid_redirect_uri");
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("a failed check offers a retry that asks again", async () => {
    let calls = 0;
    const request = fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return { kind: "consent", app: APP, scopes: SCOPES, alreadyGranted: false };
    });
    renderConsent({ fake: fakeClient({ request }) });
    expect((await screen.findByTestId("oauth-consent-error")).getAttribute("data-error")).toBe("request_failed");
    fireEvent.click(screen.getByRole("button", { name: en["oauth.error.retry"] }));
    expect(await screen.findByTestId("oauth-consent")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("an existing grant without force_verify approves at once, the skeleton showing meanwhile", async () => {
    let finish: (v: { redirectTo: string }) => void = () => undefined;
    const decide = fn(() => new Promise<{ redirectTo: string }>((resolve) => (finish = resolve)));
    const request = fn(async () => ({ kind: "consent", app: APP, scopes: SCOPES, alreadyGranted: true }));
    const { navigator } = renderConsent({ fake: fakeClient({ request, decide }) });
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ approve: true, state: STATE })));
    expect(screen.getByTestId("oauth-consent-loading")).toBeTruthy();
    expect(screen.queryByTestId("oauth-consent")).toBeNull();
    await act(async () => finish({ redirectTo: `${REDIRECT}?code=cac_2&state=s` }));
    expect(navigator.replace).toHaveBeenCalledWith(`${REDIRECT}?code=cac_2&state=s`);
    expect(screen.queryByTestId("oauth-consent")).toBeNull();
  });

  it("with force_verify the card shows even for an existing grant", async () => {
    const request = fn(async () => ({ kind: "consent", app: APP, scopes: SCOPES, alreadyGranted: true }));
    const fake = fakeClient({ request });
    renderConsent({ fake, search: queryString({ force_verify: "true" }) });
    const card = await screen.findByTestId("oauth-consent");
    expect(card.getAttribute("data-already-granted")).toBe("true");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ forceVerify: true }));
    expect(fake.decide).not.toHaveBeenCalled();
  });

  it("a failed silent approval falls back to the card", async () => {
    const request = fn(async () => ({ kind: "consent", app: APP, scopes: SCOPES, alreadyGranted: true }));
    const decide = fn(async () => {
      throw new Error("network");
    });
    renderConsent({ fake: fakeClient({ request, decide }) });
    expect(await screen.findByTestId("oauth-consent")).toBeTruthy();
    expect(screen.getByTestId("oauth-consent-decide-error").textContent).toBe(en["oauth.consent.decideFailed"]);
  });

  it("'Not you?' switches account", async () => {
    const { onSwitchAccount } = renderConsent();
    fireEvent.click(await screen.findByRole("button", { name: en["oauth.consent.notYou"] }));
    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledTimes(1));
  });

  it("accessibility: focus on the heading, a labelled list, named buttons", async () => {
    renderConsent();
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(SCOPES.length);
    expect(list.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Authorize Chat Helper" })).toBe(
      screen.getByTestId("oauth-consent-approve"),
    );
    expect(screen.getByRole("button", { name: en["oauth.consent.deny"] })).toBe(
      screen.getByTestId("oauth-consent-deny"),
    );
  });
});

// ── /activate ────────────────────────────────────────────────────────────────────────────────

describe("device activation", () => {
  it("normalizes codes: any case, dash optional, exactly eight letters", () => {
    expect(usableUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(usableUserCode("BCDFGHJK")).toBe("BCDFGHJK");
    expect(usableUserCode(" bcdf ghjk ")).toBe("BCDFGHJK");
    expect(usableUserCode("BCDF-GHJ")).toBeNull();
    expect(usableUserCode("BCDF-GHJKL")).toBeNull();
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    expect(deviceError(notFound())).toBe("not_found");
    expect(deviceError(precondition("expired"))).toBe("expired");
    expect(deviceError(new Error("network"))).toBeNull();
  });

  it("prefills ?code=, looks it up in the body, approves → device-done approved", async () => {
    const fake = fakeClient();
    wrap(<DeviceActivation client={fake.client} initialCode="bcdfghjk" />);
    const input = screen.getByTestId("device-code") as HTMLInputElement;
    collectIds();
    expect(input.value).toBe("BCDF-GHJK");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("autocapitalize")).toBe("characters");
    expect(input.getAttribute("inputmode")).toBe("text");
    fireEvent.click(screen.getByTestId("device-submit"));
    const consent = await screen.findByTestId("device-consent");
    collectIds();
    expect(fake.activation).toHaveBeenCalledWith({ userCode: "BCDFGHJK" });
    expect(consent.getAttribute("data-client-id")).toBe("cid_public");
    expect(screen.getAllByTestId("oauth-consent-scope").map((r) => r.getAttribute("data-scope"))).toEqual([
      "chat:read",
      "chat:edit",
    ]);
    expect(screen.getByTestId("oauth-consent-owner").textContent).toContain("devdana");
    fireEvent.click(screen.getByTestId("device-approve"));
    const done = await screen.findByTestId("device-done");
    collectIds();
    expect(fake.activate).toHaveBeenCalledWith({ userCode: "BCDFGHJK", approve: true });
    expect(done.getAttribute("data-result")).toBe("approved");
    expect(done.textContent).toContain(en["oauth.device.approvedBody"]);
  });

  it("deny → device-done denied", async () => {
    const fake = fakeClient();
    wrap(<DeviceActivation client={fake.client} />);
    fireEvent.change(screen.getByTestId("device-code"), { target: { value: "bcdf-ghjk" } });
    fireEvent.click(screen.getByTestId("device-submit"));
    fireEvent.click(await screen.findByTestId("device-deny"));
    expect((await screen.findByTestId("device-done")).getAttribute("data-result")).toBe("denied");
    expect(fake.activate).toHaveBeenCalledWith({ userCode: "BCDFGHJK", approve: false });
  });

  it("an incomplete code is refused before any request", async () => {
    const fake = fakeClient();
    wrap(<DeviceActivation client={fake.client} />);
    fireEvent.change(screen.getByTestId("device-code"), { target: { value: "bcd" } });
    fireEvent.click(screen.getByTestId("device-submit"));
    expect(await screen.findByText(en["oauth.device.codeInvalid"])).toBeTruthy();
    expect(screen.getByTestId("device-code").getAttribute("aria-invalid")).toBe("true");
    expect(fake.activation).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", notFound()],
    ["expired", precondition("expired")],
  ])("a %s code shows device-error and keeps the form", async (code, err) => {
    const activation = fn(async () => {
      throw err;
    });
    wrap(<DeviceActivation client={fakeClient({ activation }).client} initialCode="BCDF-GHJK" />);
    fireEvent.click(screen.getByTestId("device-submit"));
    const box = await screen.findByTestId("device-error");
    collectIds();
    expect(box.getAttribute("data-error")).toBe(code);
    expect(screen.getByTestId("device-form")).toBeTruthy();
  });

  it("a code that expires between lookup and decision shows expired", async () => {
    const activate = fn(async () => {
      throw precondition("expired");
    });
    wrap(<DeviceActivation client={fakeClient({ activate }).client} initialCode="BCDF-GHJK" />);
    fireEvent.click(screen.getByTestId("device-submit"));
    fireEvent.click(await screen.findByTestId("device-approve"));
    expect((await screen.findByTestId("device-error")).getAttribute("data-error")).toBe("expired");
  });

  it("a failed lookup is retryable in place", async () => {
    const activation = fn(async () => {
      throw new Error("network");
    });
    wrap(<DeviceActivation client={fakeClient({ activation }).client} initialCode="BCDF-GHJK" />);
    fireEvent.click(screen.getByTestId("device-submit"));
    expect(await screen.findByText(en["oauth.device.lookupFailed"])).toBeTruthy();
    expect(screen.queryByTestId("device-error")).toBeNull();
    expect(screen.getByTestId("device-submit")).toHaveProperty("disabled", false);
  });
});

// ── /settings/connections ────────────────────────────────────────────────────────────────────

describe("connections", () => {
  it("lists each authorized app with owner, scopes in plain words and times", async () => {
    const fake = fakeClient({
      list: fn(async () => [
        grant(),
        grant({
          app: { ...APP, id: "0192f000-0000-7000-8000-0000000000a3", clientId: "cid_2", name: "Other" },
          lastUsedAt: "2026-10-29T09:00:00.000Z",
        }),
      ]),
    });
    wrap(<Connections client={fake.client} />);
    const rows = await screen.findAllByTestId("connection");
    collectIds();
    expect(screen.getByTestId("connections")).toBeTruthy();
    expect(rows).toHaveLength(2);
    expect(screen.getByText(/2 apps\./)).toBeTruthy();
    expect(rows[0]?.getAttribute("data-app-id")).toBe(APP_ID);
    expect(rows[0]?.getAttribute("data-client-id")).toBe(APP.clientId);
    expect(rows[0]?.getAttribute("data-scopes")).toBe("chat:read channel:read:subscriptions");
    const first = rows[0] as HTMLElement;
    expect(within(first).getByText(en["oauth.scope.chat.read.title"])).toBeTruthy();
    expect(within(first).getByText(en["oauth.connections.neverUsed"])).toBeTruthy();
    expect(within(first).getAllByRole("listitem")).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).queryByText(en["oauth.connections.neverUsed"])).toBeNull();
    expect(within(first).getByRole("button", { name: "Disconnect Chat Helper" })).toBe(
      within(first).getByTestId("connection-revoke"),
    );
  });

  it("revoke asks first, then removes the row and toasts", async () => {
    const fake = fakeClient();
    wrap(<Connections client={fake.client} />);
    fireEvent.click(await screen.findByTestId("connection-revoke"));
    const dialog = await screen.findByTestId("connection-revoke-dialog");
    expect(dialog.textContent).toContain("chat bots");
    expect(fake.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(fake.revoke).toHaveBeenCalledWith({ appId: APP_ID }));
    await waitFor(() => expect(screen.queryByTestId("connection")).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith("Chat Helper was disconnected.");
    expect(screen.getByTestId("connections-empty")).toBeTruthy();
  });

  it("a failed revoke keeps the row and toasts the error", async () => {
    const revoke = fn(async () => {
      throw new Error("network");
    });
    wrap(<Connections client={fakeClient({ revoke }).client} />);
    fireEvent.click(await screen.findByTestId("connection-revoke"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(en["oauth.connections.revokeFailed"]));
    expect(screen.getByTestId("connection")).toBeTruthy();
  });

  it("empty: connections-empty", async () => {
    wrap(<Connections client={fakeClient({ list: fn(async () => []) }).client} />);
    expect(await screen.findByTestId("connections-empty")).toBeTruthy();
    collectIds();
    expect(screen.queryByTestId("connection")).toBeNull();
  });

  it("loading shows skeletons; a failed load offers a retry", async () => {
    let calls = 0;
    let fail: (e: Error) => void = () => undefined;
    const list = fn(() => {
      calls += 1;
      if (calls === 1) return new Promise<GrantDto[]>((_, reject) => (fail = reject));
      return Promise.resolve([grant()]);
    });
    wrap(<Connections client={fakeClient({ list }).client} />);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    await act(async () => fail(new Error("network")));
    expect(await screen.findByTestId("connections-load-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("connections-retry"));
    expect(await screen.findByTestId("connection")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

// ── selectors ────────────────────────────────────────────────────────────────────────────────

describe("selectors", () => {
  it("every id of the Consent, Device activation and Connections sections was rendered", async () => {
    // States the earlier tests do not leave behind.
    const fake = fakeClient();
    wrap(<Connections client={fake.client} />);
    fireEvent.click(await screen.findByTestId("connection-revoke"));
    await screen.findByTestId("connection-revoke-dialog");
    collectIds();
    cleanup();
    renderConsent();
    await screen.findByTestId("oauth-consent");
    collectIds();
    cleanup();
    wrap(<DeviceActivation client={fake.client} initialCode="BCDF-GHJK" />);
    fireEvent.click(screen.getByTestId("device-submit"));
    await screen.findByTestId("device-consent");
    collectIds();

    const doc = readFileSync(join(import.meta.dirname, "../../../docs/testing/e9-selectors.md"), "utf8");
    const sections = ["### Consent", "### Device activation", "### Connections"].map((h) => {
      const start = doc.indexOf(h);
      const end = doc.indexOf("\n### ", start + h.length);
      return doc.slice(start, end);
    });
    const ids = new Set<string>();
    for (const section of sections)
      for (const m of section.matchAll(/`([a-z][a-z0-9-]+)`/g))
        if (m[1] && /-/.test(m[1]) && !m[1].startsWith("data-") && !m[1].includes("_")) ids.add(m[1]);
    // The account menu link is the contract step's (site chrome), not these pages'.
    ids.delete("account-connections-link");
    expect(ids.size).toBeGreaterThanOrEqual(15);
    expect([...ids].filter((id) => !seenIds.has(id))).toEqual([]);
  });
});
