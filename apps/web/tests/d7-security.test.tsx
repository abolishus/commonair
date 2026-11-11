// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d7-security (README D7.2): the session summary parser, the two-step set-up stepper and its
 * helpers, the WebAuthn JSON conversions, the /settings/security sections against a stubbed
 * better-auth, and the sign-in's code step (the password answers `twoFactorRedirect`).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { GET_SESSION_PATH } from "../src/components/security/api.ts";
import { securityErrorMessage } from "../src/components/security/errors.ts";
import { qrPath } from "../src/components/security/qr-code.tsx";
import { SecurityPage } from "../src/components/security/security-page.tsx";
import { deviceText, orderSessions, parseUserAgent } from "../src/components/security/session-summary.ts";
import {
  SETUP_STEPS,
  backupCodesFile,
  groupKey,
  isTotpCode,
  nextStep,
  normalizeBackupCode,
  normalizeCode,
  previousStep,
  stepNumber,
  totpSecret,
} from "../src/components/security/two-factor.ts";
import { TwoFactorSetup } from "../src/components/security/two-factor-setup.tsx";
import {
  authenticationJson,
  creationOptions,
  fromBase64Url,
  isCancelled,
  passkeysSupported,
  registrationJson,
  requestOptions,
  toBase64Url,
} from "../src/components/security/webauthn.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { AuthRequestError } from "../src/lib/auth.ts";
import { Route as SignInRoute } from "../src/routes/_app/signin.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const hrefOf = (url: RequestInfo | URL): string => (url instanceof Request ? url.url : url.toString());
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function wrap(node: React.ReactNode, at = "/") {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: [at] }) });
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <React.Suspense fallback={null}>{node}</React.Suspense>
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const SignIn = () => {
  const C = SignInRoute.options.component as React.ComponentType;
  return <C />;
};
beforeAll(async () => {
  const c = SignInRoute.options.component as { preload?: () => Promise<void> } | undefined;
  await c?.preload?.();
});

const UA = {
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:140.0) Gecko/20100101 Firefox/140.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
};

describe("the session summary parser", () => {
  it.each([
    [UA.firefoxMac, "Firefox", "macOS", "computer"],
    [UA.safariIphone, "Safari", "iPhone", "phone"],
    [UA.chromeWindows, "Chrome", "Windows", "computer"],
    [UA.edgeWindows, "Edge", "Windows", "computer"],
    [UA.androidTablet, "Chrome", "Android", "tablet"],
    [UA.androidPhone, "Chrome", "Android", "phone"],
    [UA.ipad, "Safari", "iPad", "tablet"],
  ])("%s", (ua, browser, os, kind) => {
    expect(parseUserAgent(ua)).toEqual({ browser, os, kind });
  });

  it("knows nothing about an unknown or missing agent", () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, kind: "computer" });
    expect(parseUserAgent("curl/8.0")).toEqual({ browser: null, os: null, kind: "computer" });
  });

  it("names the device in words, never the agent string", () => {
    expect(deviceText(parseUserAgent(UA.firefoxMac))).toBe("Firefox on macOS");
    expect(deviceText({ browser: "Firefox", os: null, kind: "computer" })).toBe("Firefox");
    expect(deviceText({ browser: null, os: "Linux", kind: "computer" })).toBe("A browser on Linux");
    expect(deviceText({ browser: null, os: null, kind: "computer" })).toBe("Unknown device");
  });

  it("orders this device first, then by last activity", () => {
    const rows = [
      { id: "a", updatedAt: "2026-11-01T00:00:00Z" },
      { id: "b", updatedAt: "2026-11-10T00:00:00Z" },
      { id: "c", updatedAt: "2026-11-05T00:00:00Z" },
    ];
    expect(orderSessions(rows, "a").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(orderSessions(rows, null).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(orderSessions([], "a")).toEqual([]);
  });
});

describe("the set-up stepper's steps", () => {
  it("runs password → scan → code → codes and stops there", () => {
    expect(SETUP_STEPS).toEqual(["password", "scan", "code", "codes"]);
    expect(nextStep("password")).toBe("scan");
    expect(nextStep("scan")).toBe("code");
    expect(nextStep("code")).toBe("codes");
    expect(nextStep("codes")).toBe("codes");
    expect(SETUP_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4]);
  });

  it("goes back only from the code to the QR code", () => {
    expect(previousStep("code")).toBe("scan");
    expect(previousStep("password")).toBeNull();
    expect(previousStep("scan")).toBeNull();
    expect(previousStep("codes")).toBeNull();
  });

  it("reads and groups the key, and normalizes typed codes", () => {
    const uri = "otpauth://totp/CommonAir:ada%40example.test?secret=JBSWY3DPEHPK3PXPJBSW&issuer=CommonAir&digits=6";
    expect(totpSecret(uri)).toBe("JBSWY3DPEHPK3PXPJBSW");
    expect(totpSecret("not a uri")).toBe("");
    expect(totpSecret("otpauth://totp/x")).toBe("");
    expect(groupKey("JBSWY3DPEHPK3PXPJBSW")).toBe("JBSW Y3DP EHPK 3PXP JBSW");
    expect(groupKey("ABCDE")).toBe("ABCD E");
    expect(groupKey("")).toBe("");
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("12345")).toBe(false);
    expect(isTotpCode("1234567")).toBe(false);
    expect(isTotpCode("12345a")).toBe(false);
    expect(normalizeBackupCode("  abcde-FGHIJ ")).toBe("abcde-FGHIJ");
  });

  it("writes the backup codes file with one code per line", () => {
    const text = backupCodesFile(["aaaaa-bbbbb", "ccccc-ddddd"], "CommonAir", "ada");
    expect(text.split("\n")).toEqual([
      "CommonAir backup codes for ada",
      "",
      "aaaaa-bbbbb",
      "ccccc-ddddd",
      "",
      t("d7Security.setup.fileHint"),
      "",
    ]);
  });

  it("draws a QR code locally", () => {
    const { size, d } = qrPath("otpauth://totp/x?secret=ABC");
    expect(size).toBeGreaterThan(20);
    expect(d).toMatch(/^M\d+ \d+h1v1h-1z/);
  });
});

describe("security error messages", () => {
  it("explains better-auth's codes", () => {
    expect(securityErrorMessage(new AuthRequestError(400, "INVALID_PASSWORD", "x"))).toBe(
      t("d7Security.error.password"),
    );
    expect(securityErrorMessage(new AuthRequestError(401, "INVALID_CODE", "x"))).toBe(t("d7Security.error.code"));
    expect(securityErrorMessage(new AuthRequestError(403, "SESSION_NOT_FRESH", "x"))).toBe(
      t("d7Security.error.notFresh"),
    );
    expect(securityErrorMessage(new AuthRequestError(429, null, "x"))).toBe(t("error.rateLimited"));
    expect(securityErrorMessage(new Error("boom"))).toBe(t("error.generic"));
  });
});

describe("WebAuthn conversions", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...new Uint8Array(fromBase64Url(encoded))]).toEqual([...bytes]);
    expect(toBase64Url(new ArrayBuffer(0))).toBe("");
  });

  it("decodes the options' binary fields", () => {
    const create = creationOptions({
      challenge: toBase64Url(new Uint8Array([1, 2, 3])),
      rp: { name: "CommonAir", id: "localhost" },
      user: { id: toBase64Url(new Uint8Array([9])), name: "ada", displayName: "Ada" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: toBase64Url(new Uint8Array([7, 7])), type: "public-key" }],
    });
    expect([...new Uint8Array(create.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(create.user.id as ArrayBuffer)]).toEqual([9]);
    expect([...new Uint8Array(create.excludeCredentials?.[0]?.id as ArrayBuffer)]).toEqual([7, 7]);
    const get = requestOptions({ challenge: toBase64Url(new Uint8Array([4])), rpId: "localhost" });
    expect([...new Uint8Array(get.challenge as ArrayBuffer)]).toEqual([4]);
    expect(get.allowCredentials).toBeUndefined();
  });

  it("encodes the credential for the API", () => {
    const buf = (n: number) => new Uint8Array([n]).buffer;
    const base = {
      id: "cred",
      rawId: buf(1),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
    };
    const reg = registrationJson({
      ...base,
      response: { clientDataJSON: buf(2), attestationObject: buf(3), getTransports: () => ["internal"] },
    } as unknown as PublicKeyCredential);
    expect(reg).toMatchObject({
      id: "cred",
      rawId: toBase64Url(buf(1)),
      response: {
        clientDataJSON: toBase64Url(buf(2)),
        attestationObject: toBase64Url(buf(3)),
        transports: ["internal"],
      },
    });
    const auth = authenticationJson({
      ...base,
      response: { clientDataJSON: buf(2), authenticatorData: buf(4), signature: buf(5), userHandle: null },
    } as unknown as PublicKeyCredential);
    expect(auth).toMatchObject({
      response: { authenticatorData: toBase64Url(buf(4)), signature: toBase64Url(buf(5)) },
    });
    expect((auth.response as Record<string, unknown>).userHandle).toBeUndefined();
  });

  it("feature-detects and treats a dismissed prompt as cancelled", () => {
    expect(passkeysSupported(undefined)).toBe(false);
    expect(passkeysSupported({ isSecureContext: false } as unknown as Window & typeof globalThis)).toBe(false);
    const win = {
      isSecureContext: true,
      PublicKeyCredential: function PublicKeyCredential() {},
      navigator: { credentials: { create: () => null, get: () => null } },
    } as unknown as Window & typeof globalThis;
    expect(passkeysSupported(win)).toBe(true);
    expect(isCancelled(new DOMException("x", "NotAllowedError"))).toBe(true);
    expect(isCancelled(new DOMException("x", "InvalidStateError"))).toBe(false);
    expect(isCancelled(new Error("x"))).toBe(false);
  });
});

const URI = "otpauth://totp/CommonAir:ada?secret=JBSWY3DPEHPK3PXP&issuer=CommonAir";
const CODES = Array.from({ length: 10 }, (_, i) => `code${i}-abcde`);

describe("the two-step set-up dialog", () => {
  it("password → QR and key → code → backup codes; on only after the code", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async (url, init) => {
        const u = hrefOf(url);
        calls.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : null });
        if (u === AUTH_ROUTES.twoFactorEnable) return json({ totpURI: URI, backupCodes: CODES });
        if (u === AUTH_ROUTES.twoFactorVerifyTotp) {
          const code = (JSON.parse(init?.body as string) as { code: string }).code;
          return code === "123456" ? json({ status: true }) : json({ code: "INVALID_CODE" }, 401);
        }
        return json({});
      }),
    );
    const onEnabled = vi.fn<() => void>();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    wrap(<TwoFactorSetup open onOpenChange={onOpenChange} onEnabled={onEnabled} username="ada" />);
    const dialog = () => screen.getByTestId("security-2fa-dialog");
    expect(dialog().getAttribute("data-step")).toBe("password");
    expect(dialog().textContent).toContain("Step 1 of 4");

    fireEvent.change(screen.getByTestId("security-2fa-password"), { target: { value: "hunter2hunter2" } });
    fireEvent.click(screen.getByTestId("security-2fa-continue"));
    await waitFor(() => expect(dialog().getAttribute("data-step")).toBe("scan"));
    expect(calls[0]).toEqual({ url: AUTH_ROUTES.twoFactorEnable, body: { password: "hunter2hunter2" } });
    expect(screen.getByTestId("security-2fa-qr").querySelector("title")?.textContent).toBe(
      t("d7Security.setup.qrLabel"),
    );
    const key = screen.getByTestId("security-2fa-key") as HTMLInputElement;
    expect(key.value).not.toContain("JBSW");
    fireEvent.click(screen.getByTestId("security-2fa-key-reveal"));
    expect((screen.getByTestId("security-2fa-key") as HTMLInputElement).value).toBe("JBSW Y3DP EHPK 3PXP");

    fireEvent.click(screen.getByTestId("security-2fa-next"));
    expect(dialog().getAttribute("data-step")).toBe("code");
    // A malformed code never reaches the API.
    fireEvent.change(screen.getByTestId("security-2fa-code"), { target: { value: "12ab" } });
    fireEvent.click(screen.getByTestId("security-2fa-verify"));
    await screen.findByText(t("d7Security.error.code"));
    expect(calls.filter((c) => c.url === AUTH_ROUTES.twoFactorVerifyTotp)).toHaveLength(0);
    fireEvent.change(screen.getByTestId("security-2fa-code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByTestId("security-2fa-verify"));
    await waitFor(() => expect(calls.filter((c) => c.url === AUTH_ROUTES.twoFactorVerifyTotp)).toHaveLength(1));
    expect(onEnabled).not.toHaveBeenCalled();
    expect(dialog().getAttribute("data-step")).toBe("code");

    fireEvent.change(screen.getByTestId("security-2fa-code"), { target: { value: "123 456" } });
    fireEvent.click(screen.getByTestId("security-2fa-verify"));
    await waitFor(() => expect(dialog().getAttribute("data-step")).toBe("codes"));
    expect(onEnabled).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({ url: AUTH_ROUTES.twoFactorVerifyTotp, body: { code: "123456" } });
    expect(calls).toContainEqual({
      url: "/api/metrics/ui",
      body: { surface: "settings.security", action: "submit", step: "totp" },
    });
    expect(screen.getByTestId("security-backup-codes").querySelectorAll("li")).toHaveLength(10);
    // No close button on the codes: only "I saved these" leaves them.
    expect(dialog().querySelector('[data-slot="dialog-close"]')).toBeNull();
    fireEvent.click(screen.getByTestId("security-2fa-saved"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("a wrong password keeps the first step with the reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => json({ code: "INVALID_PASSWORD", message: "Invalid password" }, 400)),
    );
    wrap(<TwoFactorSetup open onOpenChange={() => {}} onEnabled={() => {}} username="ada" />);
    fireEvent.change(screen.getByTestId("security-2fa-password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByTestId("security-2fa-continue"));
    await screen.findByText(t("d7Security.error.password"));
    expect(screen.getByTestId("security-2fa-dialog").getAttribute("data-step")).toBe("password");
  });
});

describe("/settings/security", () => {
  const SESSIONS = [
    {
      id: "s1",
      token: "t1",
      userAgent: UA.firefoxMac,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-11T00:00:00Z",
    },
    {
      id: "s2",
      token: "t2",
      userAgent: UA.safariIphone,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-11-09T00:00:00Z",
    },
  ];

  function stubAuth() {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async (url, init) => {
        const u = hrefOf(url);
        if (init?.method === "POST") posts.push({ url: u, body: JSON.parse((init.body as string) ?? "{}") });
        if (u === AUTH_ROUTES.listSessions) return json(SESSIONS);
        if (u === GET_SESSION_PATH) return json({ session: { id: "s1" }, user: {} });
        if (u === AUTH_ROUTES.passkeyList)
          return json([{ id: "p1", name: "Laptop", createdAt: "2026-10-10T00:00:00Z" }]);
        return json({ status: true });
      }),
    );
    return posts;
  }

  const account = (twoFactorEnabled: boolean) => () =>
    Promise.resolve({ email: "ada@example.test", username: "ada", twoFactorEnabled });

  it("renders every section, the sessions with this device first and no address", async () => {
    stubAuth();
    wrap(<SecurityPage loadAccount={account(false)} />);
    await screen.findByTestId("security-account");
    expect(screen.getByTestId("security-account").textContent).toContain("ada@example.test");
    expect(screen.getByTestId("security-2fa-row").getAttribute("data-state")).toBe("off");
    expect(screen.getByTestId("security-2fa-setup")).toBeTruthy();
    await screen.findAllByTestId("security-session-row");
    const rows = screen.getAllByTestId("security-session-row");
    expect(rows.map((r) => r.getAttribute("data-current"))).toEqual(["true", "false"]);
    expect(rows[0]?.textContent).toContain("Firefox on macOS");
    expect(rows[0]?.textContent).toContain(t("d7Security.sessions.thisDevice"));
    expect(rows[1]?.textContent).toContain("Safari on iPhone");
    expect(rows[0]?.querySelector('[data-testid="security-session-revoke"]')).toBeNull();
    expect(screen.getByTestId("security-sessions").id).toBe("sessions");
    expect(screen.getByTestId("security-sessions").textContent).not.toContain("Mozilla");
    await screen.findByTestId("security-passkey-row");
    expect(screen.getByTestId("security-passkey-row").textContent).toContain("Laptop");
    // happy-dom has no WebAuthn: no "Add a passkey".
    expect(screen.queryByTestId("security-passkey-add")).toBeNull();
    expect(screen.getByTestId("security-email-link")).toBeTruthy();
    // No brand fill on a settings page.
    expect(document.querySelector('[data-variant="brand"], [data-filled-cta]')).toBeNull();
  });

  it("signs one other session out by its token", async () => {
    const posts = stubAuth();
    wrap(<SecurityPage loadAccount={account(false)} />);
    const revoke = await screen.findByTestId("security-session-revoke");
    fireEvent.click(revoke);
    await waitFor(() => expect(posts).toContainEqual({ url: AUTH_ROUTES.revokeSession, body: { token: "t2" } }));
  });

  it("turns two-step sign-in off with the password", async () => {
    const posts = stubAuth();
    wrap(<SecurityPage loadAccount={account(true)} />);
    expect((await screen.findByTestId("security-2fa-row")).getAttribute("data-state")).toBe("on");
    fireEvent.click(screen.getByTestId("security-2fa-off"));
    const password = await screen.findByTestId("security-confirm-password");
    fireEvent.change(password, { target: { value: "hunter2hunter2" } });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(screen.getByTestId("security-2fa-row").getAttribute("data-state")).toBe("off"));
    expect(posts).toContainEqual({ url: AUTH_ROUTES.twoFactorDisable, body: { password: "hunter2hunter2" } });
  });

  it("changes the password with other sessions signed out by default", async () => {
    const posts = stubAuth();
    wrap(<SecurityPage loadAccount={account(false)} />);
    fireEvent.click(await screen.findByTestId("security-password-change"));
    fireEvent.change(screen.getByTestId("security-password-current"), { target: { value: "old password 1" } });
    fireEvent.change(screen.getByTestId("security-password-new"), { target: { value: "new password 12" } });
    const form = screen.getByTestId("security-password-new").closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: AUTH_ROUTES.changePassword,
        body: { currentPassword: "old password 1", newPassword: "new password 12", revokeOtherSessions: true },
      }),
    );
  });

  it("asks for an email change back to this page, and refuses the same address", async () => {
    const posts = stubAuth();
    wrap(<SecurityPage loadAccount={account(false)} />);
    fireEvent.click(await screen.findByTestId("security-email-change"));
    const input = screen.getByTestId("security-email-new");
    const form = input.closest("form");
    if (!form) throw new Error("no form");
    fireEvent.change(input, { target: { value: "ADA@example.test" } });
    fireEvent.submit(form);
    await screen.findByText(t("d7Security.email.same"));
    expect(posts.filter((p) => p.url === AUTH_ROUTES.changeEmail)).toHaveLength(0);
    fireEvent.change(input, { target: { value: "new@example.test" } });
    fireEvent.submit(form);
    await screen.findByTestId("security-email-sent");
    expect(posts).toContainEqual({
      url: AUTH_ROUTES.changeEmail,
      body: { newEmail: "new@example.test", callbackURL: "/settings/security" },
    });
  });
});

describe("the sign-in code step", () => {
  function stubSignIn(verify: (url: string, code: string) => Response) {
    const assign = vi.fn<(url: string) => void>();
    vi.stubGlobal("location", { href: window.location.href, origin: window.location.origin, hash: "", assign });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async (url, init) => {
        const u = hrefOf(url);
        calls.push(u);
        if (u === AUTH_ROUTES.signIn) return json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
        const code = (JSON.parse((init?.body as string) ?? "{}") as { code?: string }).code ?? "";
        return verify(u, code);
      }),
    );
    return { assign, calls };
  }

  async function passwordStep() {
    const { container } = wrap(<SignIn />, "/signin?redirect=%2Ffollowing");
    fireEvent.change(screen.getByTestId("signin-email"), { target: { value: "a@example.test" } });
    fireEvent.change(screen.getByTestId("signin-password"), { target: { value: "correct horse" } });
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    return screen.findByTestId("signin-2fa-step");
  }

  const submitCode = (value: string) => {
    fireEvent.change(screen.getByTestId("signin-2fa-code"), { target: { value } });
    const form = screen.getByTestId("signin-2fa-step") as HTMLFormElement;
    fireEvent.submit(form);
  };

  it("asks for the code after the password and lands on the redirect", async () => {
    const { assign, calls } = stubSignIn((u, code) =>
      u === AUTH_ROUTES.twoFactorVerifyTotp && code === "123456"
        ? json({ token: "x" })
        : json({ code: "INVALID_CODE" }, 401),
    );
    const step = await passwordStep();
    expect(step.getAttribute("data-mode")).toBe("totp");
    expect(assign).not.toHaveBeenCalled();
    submitCode("000000");
    await screen.findByText(t("d7Security.error.code"));
    expect(assign).not.toHaveBeenCalled();
    submitCode("123 456");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/following"));
    expect(calls.filter((c) => c === AUTH_ROUTES.twoFactorVerifyTotp)).toHaveLength(2);
  });

  it("takes a backup code instead", async () => {
    const { assign } = stubSignIn((u, code) =>
      u === AUTH_ROUTES.twoFactorVerifyBackupCode && code === "abcde-12345" ? json({ token: "x" }) : json({}, 400),
    );
    await passwordStep();
    fireEvent.click(screen.getByTestId("signin-2fa-mode"));
    expect(screen.getByTestId("signin-2fa-step").getAttribute("data-mode")).toBe("backup");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t("d7Security.signin.backupTitle"));
    submitCode(" abcde-12345 ");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/following"));
  });

  it("goes back to the password when the pending sign-in expired", async () => {
    stubSignIn(() => json({ code: "INVALID_TWO_FACTOR_COOKIE" }, 401));
    await passwordStep();
    submitCode("123456");
    await screen.findByTestId("signin-email");
    expect(screen.getByText(t("d7Security.error.expiredStep"))).toBeTruthy();
  });

  it("a member without two-step sign-in lands right away", async () => {
    const assign = vi.fn<(url: string) => void>();
    vi.stubGlobal("location", { href: window.location.href, origin: window.location.origin, assign });
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => json({ token: "x", user: {} })),
    );
    const { container } = wrap(<SignIn />, "/signin?redirect=%2Fcoop");
    fireEvent.change(screen.getByTestId("signin-email"), { target: { value: "a@example.test" } });
    fireEvent.change(screen.getByTestId("signin-password"), { target: { value: "correct horse" } });
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/coop"));
    expect(screen.queryByTestId("signin-2fa-step")).toBeNull();
  });
});
