// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E9-console with a fake API: `/developer` (register, the secret once), `/developer/apps/$appId`
 * (edit, rotate, delete, subscriptions from the catalog, test events, the delivery log),
 * `/developer/bots` (bots, a token once, revocation) and `/admin/apps` (search, suspend with a
 * reason, unsuspend). The last test checks every id of docs/testing/e9-selectors.md's
 * "Developer console", "Bots and tokens" and "Apps" sections rendered at least once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { APP_SUSPENSION_REASONS } from "@commonair/contracts/enums";
import { SCOPE_NAMES } from "@commonair/contracts/scopes";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AdminAppsPage, SEARCH_DEBOUNCE_MS } from "../src/components/developer/admin-apps.tsx";
import { DeveloperAppPage } from "../src/components/developer/app-page.tsx";
import { DeveloperAppsPage } from "../src/components/developer/apps-page.tsx";
import { DeveloperBotsPage } from "../src/components/developer/bots-page.tsx";
import type {
  AccessTokenDto,
  AdminAppsClient,
  AdminOAuthAppDto,
  BotDto,
  CatalogEntry,
  DeliveryDto,
  DeveloperClient,
  OAuthAppDto,
  Page,
  SubscriptionDto,
  SuspensionReason,
} from "../src/components/developer/client.ts";
import {
  appInput,
  canRedeliver,
  canSendTest,
  developerError,
  generateWebhookSecret,
  ircPass,
  mergeFirstPage,
  parseRedirectLines,
  subscriptionInput,
  tokenInput,
  webhookTypes,
} from "../src/components/developer/model.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

const T0 = "2026-10-29T10:00:00.000Z";
const APP_ID = "0192f000-0000-7000-8000-0000000000a1";
const STREAMER = "0192f000-0000-7000-8000-0000000000f1";

const oauthApp = (over: Partial<OAuthAppDto> = {}): OAuthAppDto => ({
  id: APP_ID,
  name: "Overlay",
  description: "Shows alerts",
  clientId: "ca_client_1",
  redirectUris: ["https://overlay.example.org/cb"],
  confidential: true,
  createdAt: T0,
  secretRotatedAt: null,
  suspended: null,
  ...over,
});

const CATALOG: CatalogEntry[] = [
  {
    type: "channel.follow",
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    transports: ["webhook", "websocket"],
    description: "Someone followed",
  },
  {
    type: "channel.raid",
    version: "1",
    condition: ["to_broadcaster_user_id", "from_broadcaster_user_id"],
    scopes: [],
    transports: ["webhook", "websocket"],
    description: "A raid arrived",
  },
  {
    type: "channel.chat.message",
    version: "1",
    condition: ["broadcaster_user_id", "user_id"],
    scopes: ["chat:read"],
    transports: ["websocket"],
    description: "A chat message",
  },
  {
    type: "channel.subscribe",
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:read:subscriptions"],
    transports: ["webhook", "websocket"],
    description: "A new subscriber",
  },
] as unknown as CatalogEntry[];

const subscription = (over: Partial<SubscriptionDto> = {}): SubscriptionDto => ({
  id: "0192f000-0000-7000-8000-0000000000b1",
  appId: APP_ID,
  userId: STREAMER,
  type: "channel.follow",
  version: "1",
  condition: { broadcaster_user_id: STREAMER },
  transport: { method: "webhook", callback: "https://hooks.example.org/hook" },
  status: "enabled",
  failureCount: 0,
  createdAt: T0,
  ...over,
});

const delivery = (n: number, over: Partial<DeliveryDto> = {}): DeliveryDto => ({
  id: `0192f000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`,
  subscriptionId: "0192f000-0000-7000-8000-0000000000b1",
  eventId: `0192f000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
  messageId: `m${n}`,
  messageType: "notification",
  attempt: 1,
  status: "succeeded",
  responseStatus: 204,
  error: null,
  latencyMs: 12,
  createdAt: T0,
  ...over,
});

const bot = (over: Partial<BotDto> = {}): BotDto => ({
  id: "0192f000-0000-7000-8000-0000000000c1",
  username: "annbot",
  displayName: "Ann Bot",
  avatarUrl: null,
  accountType: "bot",
  botOwner: { id: "0192f000-0000-7000-8000-000000000001", username: "ann" },
  createdAt: T0,
  ...over,
});

const accessToken = (over: Partial<AccessTokenDto> = {}): AccessTokenDto => ({
  id: "0192f000-0000-7000-8000-0000000000d1",
  appId: null,
  appName: null,
  kind: "personal",
  scopes: ["chat:read", "chat:edit"],
  createdAt: T0,
  expiresAt: "2099-01-01T00:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

const adminApp = (over: Partial<AdminOAuthAppDto> = {}): AdminOAuthAppDto => ({
  ...oauthApp(),
  owner: { id: "0192f000-0000-7000-8000-000000000001", username: "ann" },
  grants: 3,
  subscriptions: 2,
  ...over,
});

const SECRET = "cas_supersecretvalue_1234567890";
const TOKEN = "ca_tokenvalue_abcdefghijklmnop";

const apiError = (code: string, data?: Record<string, unknown>) => Object.assign(new Error(code), { code, data });
const page = <T,>(items: T[], nextCursor: string | null = null): Page<T> => ({ items, nextCursor });

function fn<A extends unknown[], R>(impl: (...args: A) => R) {
  return vi.fn<(...args: A) => R>(impl);
}

function fakeDeveloper() {
  const m = {
    apps: {
      list: fn(async (): Promise<OAuthAppDto[]> => [oauthApp()]),
      create: fn(async (input: { name: string; confidential?: boolean; redirectUris: string[] }) => ({
        app: oauthApp({
          id: "new-app",
          name: input.name,
          confidential: input.confidential ?? true,
          clientId: "ca_new",
        }),
        secret: input.confidential === false ? null : { clientId: "ca_new", clientSecret: SECRET },
      })),
      update: fn(async (input: { id: string; name?: string; description?: string; redirectUris?: string[] }) =>
        oauthApp({ name: input.name ?? "Overlay", description: input.description ?? "" }),
      ),
      rotateSecret: fn(async (_i: { id: string }) => ({ clientId: "ca_client_1", clientSecret: SECRET })),
      remove: fn(async (_i: { id: string }) => ({ ok: true as const })),
    },
    events: {
      catalog: fn(async (): Promise<CatalogEntry[]> => CATALOG),
      list: fn(async (_i: { appId: string; cursor?: string; limit: number }) => page([subscription()])),
      subscribe: fn(async (input: { type: string }) =>
        subscription({ id: "new-sub", type: input.type, status: "verification_pending" }),
      ),
      unsubscribe: fn(async (_i: { id: string }) => ({ ok: true as const })),
      deliveries: fn(async (_i: { id: string; cursor?: string; limit: number }) =>
        page([delivery(1), delivery(2, { messageType: "webhook_callback_verification" })], "c2"),
      ),
      sendTest: fn(async (_i: { id: string }) => ({ eventId: "e" })),
      redeliver: fn(async (_i: { id: string }) => ({ ok: true as const })),
    },
    tokens: {
      list: fn(async (): Promise<AccessTokenDto[]> => [accessToken()]),
      revoke: fn(async (_i: { id: string }) => ({ ok: true as const })),
    },
    bots: {
      list: fn(async (): Promise<BotDto[]> => [bot()]),
      create: fn(async (input: { username: string; displayName: string }) =>
        bot({ id: "0192f000-0000-7000-8000-0000000000c2", ...input }),
      ),
      createToken: fn(async (input: { botId: string; scopes: string[]; expiresInDays: number }) => ({
        token: accessToken({ scopes: input.scopes as AccessTokenDto["scopes"] }),
        accessToken: TOKEN,
      })),
    },
  };
  return { m, client: m as unknown as DeveloperClient };
}

function fakeAdmin() {
  const m = {
    list: fn(async (_i: { q?: string; suspended?: boolean; cursor?: string; limit: number }) =>
      page([adminApp(), adminApp({ id: "a2", name: "Spammy", suspended: { at: T0, reason: "spam" } })]),
    ),
    suspend: fn(async (input: { id: string; reason: SuspensionReason }) =>
      adminApp({ id: input.id, suspended: { at: T0, reason: input.reason } }),
    ),
    unsuspend: fn(async (input: { id: string }) => adminApp({ id: input.id, name: "Spammy", suspended: null })),
  };
  return { m, client: m as unknown as AdminAppsClient };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const seen = new Set<string>();
/** Every element with a test id now in the document counts as rendered. */
function record(): void {
  for (const el of document.querySelectorAll("[data-testid]")) {
    const v = el.getAttribute("data-testid");
    if (v) seen.add(v);
  }
}
const id = (testId: string) => {
  const el = screen.getByTestId(testId);
  record();
  return el;
};
const find = async (testId: string) => {
  const el = await screen.findByTestId(testId);
  record();
  return el;
};
const type = (testId: string, value: string) => fireEvent.change(id(testId), { target: { value } });
const click = (testId: string) => fireEvent.click(id(testId));

async function confirm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
}

async function pick(triggerId: string, optionId: string): Promise<void> {
  const trigger = id(triggerId);
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const option = await find(optionId);
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseUp(option, { button: 0 });
  fireEvent.click(option);
}

// ── Pure logic ───────────────────────────────────────────────────────────────────────────────

describe("developer model", () => {
  it("checks redirect URIs one per line with the API's rule", () => {
    expect(parseRedirectLines("https://a.example/cb\n\n  http://127.0.0.1:8080/cb \nhttps://a.example/cb")).toEqual({
      uris: ["https://a.example/cb", "http://127.0.0.1:8080/cb"],
      problem: null,
    });
    expect(parseRedirectLines("com.example.app:/cb").problem).toBeNull();
    expect(parseRedirectLines("").problem).toBe(en["developer.app.redirect.none"]);
    expect(parseRedirectLines("http://evil.example/cb").problem).toContain(en["developer.app.redirect.httpLoopback"]);
    expect(parseRedirectLines("https://a.example/cb#x").problem).toContain(en["developer.app.redirect.fragment"]);
    expect(parseRedirectLines("myapp:/cb").problem).toContain(en["developer.app.redirect.privateScheme"]);
    expect(parseRedirectLines("not a uri").problem).toContain(en["developer.app.redirect.notAbsolute"]);
    expect(parseRedirectLines("https://u:p@a.example/cb").problem).toContain(en["developer.app.redirect.userinfo"]);
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`).join("\n");
    expect(parseRedirectLines(eleven).problem).toContain("10");
    expect(parseRedirectLines(`https://a.example/${"x".repeat(2000)}`).problem).toContain("2000");
  });

  it("validates the app form", () => {
    const ok = appInput({ name: "  Bot  ", description: "", redirects: "https://a.example/cb", confidential: false });
    expect(ok).toEqual({
      ok: true,
      input: { name: "Bot", description: "", redirectUris: ["https://a.example/cb"], confidential: false },
    });
    const bad = appInput({ name: "", description: "x".repeat(501), redirects: "", confidential: true });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.ok ? {} : bad.errors).sort()).toEqual(["description", "name", "redirects"]);
    expect(
      appInput({ name: "x".repeat(51), description: "", redirects: "https://a.example", confidential: true }).ok,
    ).toBe(false);
  });

  it("builds a webhook subscription from the catalog", () => {
    expect(webhookTypes(CATALOG).map((e) => e.type)).toEqual(["channel.follow", "channel.raid", "channel.subscribe"]);
    const draft = {
      type: "channel.follow",
      condition: { broadcaster_user_id: STREAMER },
      callback: "https://h.example/x",
      secret: "s".repeat(10),
    };
    expect(subscriptionInput(APP_ID, draft, CATALOG)).toEqual({
      ok: true,
      input: {
        type: "channel.follow",
        version: "1",
        condition: { broadcaster_user_id: STREAMER },
        transport: { method: "webhook", callback: "https://h.example/x", secret: "s".repeat(10) },
        appId: APP_ID,
      },
    });
    const ws = subscriptionInput(APP_ID, { ...draft, type: "channel.chat.message" }, CATALOG);
    expect(ws.ok).toBe(false);
    const bad = subscriptionInput(
      APP_ID,
      { ...draft, condition: { broadcaster_user_id: "ann" }, callback: "ftp://x", secret: "short" },
      CATALOG,
    );
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.ok ? {} : bad.errors).sort()).toEqual([
      "callback",
      "condition.broadcaster_user_id",
      "secret",
    ]);
    const missing = subscriptionInput(APP_ID, { ...draft, condition: {} }, CATALOG);
    expect(!missing.ok && missing.errors["condition.broadcaster_user_id"]).toBe(
      en["developer.sub.error.conditionMissing"],
    );
    expect(subscriptionInput(APP_ID, { ...draft, secret: "s".repeat(101) }, CATALOG).ok).toBe(false);
  });

  it("generates 43-character url-safe secrets", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
    expect(generateWebhookSecret((b) => b.fill(255))).toBe("_".repeat(42) + "8");
  });

  it("offers test events and redelivery only where the API accepts them", () => {
    expect(canSendTest(subscription())).toBe(true);
    expect(canSendTest(subscription({ status: "verification_pending" }))).toBe(false);
    expect(canSendTest(subscription({ transport: { method: "websocket", sessionId: "s" } }))).toBe(false);
    expect(canRedeliver(delivery(1, { status: "failed" }))).toBe(true);
    expect(canRedeliver(delivery(1))).toBe(true);
    expect(canRedeliver(delivery(1, { messageType: "webhook_callback_verification" }))).toBe(false);
    expect(canRedeliver(delivery(1, { messageType: "revocation" }))).toBe(false);
  });

  it("merges a fresh first page over the rows shown", () => {
    const a = { id: "a", v: 1 };
    const b = { id: "b", v: 1 };
    const c = { id: "c", v: 1 };
    expect(
      mergeFirstPage(
        [
          { id: "n", v: 0 },
          { id: "a", v: 2 },
        ],
        [a, b, c],
      ),
    ).toEqual([{ id: "n", v: 0 }, { id: "a", v: 2 }, b, c]);
    expect(mergeFirstPage([], [a])).toEqual([a]);
  });

  it("validates bot tokens", () => {
    expect(tokenInput("b", { scopes: ["chat:edit", "chat:read"], days: "30" })).toEqual({
      ok: true,
      input: { botId: "b", scopes: ["chat:read", "chat:edit"], expiresInDays: 30 },
    });
    const bad = tokenInput("b", { scopes: [], days: "0" });
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(["days", "scopes"]);
    expect(tokenInput("b", { scopes: ["chat:read"], days: "366" }).ok).toBe(false);
    expect(tokenInput("b", { scopes: ["chat:read"], days: "1.5" }).ok).toBe(false);
    expect(ircPass("abc")).toBe("oauth:abc");
  });

  it("maps the API's refusals to messages", () => {
    const pre = (requirement: string) => apiError("PRECONDITION_FAILED", { requirement });
    expect(developerError(pre("app_limit"), "developer.app.createFailed")).toBe(
      en["developer.error.appLimit"].replace("{appsMax}", "25"),
    );
    for (const [req, key] of [
      ["app_suspended", "developer.error.appSuspended"],
      ["public_client", "developer.error.publicClient"],
      ["subscription_limit", "developer.error.subscriptionLimit"],
      ["websocket_only", "developer.error.websocketOnly"],
      ["condition_keys", "developer.error.conditionKeys"],
      ["webhook_only", "developer.error.webhookOnly"],
      ["not_enabled", "developer.error.notEnabled"],
      ["bot_limit", "developer.error.botLimit"],
      ["channel_bot", "developer.error.channelBot"],
    ] as const)
      expect(developerError(pre(req), "developer.app.createFailed")).toBe(en[key]);
    expect(developerError(pre("unknown"), "developer.app.createFailed")).toBe(en["developer.app.createFailed"]);
    expect(
      developerError(apiError("CONFLICT"), "developer.bots.createFailed", { CONFLICT: "developer.bots.taken" }),
    ).toBe(en["developer.bots.taken"]);
    expect(developerError(apiError("UNAUTHORIZED"), "developer.app.createFailed")).toBe(en["developer.error.session"]);
    expect(developerError(apiError("RATE_LIMITED"), "developer.app.createFailed")).toBe(
      en["developer.error.rateLimited"],
    );
    expect(developerError(new Error("x"), "developer.app.createFailed")).toBe(en["developer.app.createFailed"]);
  });
});

// ── /developer ───────────────────────────────────────────────────────────────────────────────

describe("/developer", () => {
  it("lists apps with their ids and the suspended flag", async () => {
    const { client, m } = fakeDeveloper();
    m.apps.list.mockResolvedValueOnce([
      oauthApp(),
      oauthApp({ id: "x2", clientId: "c2", suspended: { at: T0, reason: "spam" } }),
    ]);
    wrap(<DeveloperAppsPage client={client} />);
    await find("devapps");
    await waitFor(() => expect(screen.getAllByTestId("devapp-row")).toHaveLength(2));
    record();
    const rows = screen.getAllByTestId("devapp-row");
    expect(rows.map((r) => [r.dataset.appId, r.dataset.clientId, r.dataset.suspended])).toEqual([
      [APP_ID, "ca_client_1", "false"],
      ["x2", "c2", "true"],
    ]);
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe(`/developer/apps/${APP_ID}`);
  });

  it("shows the empty state", async () => {
    const { client, m } = fakeDeveloper();
    m.apps.list.mockResolvedValueOnce([]);
    wrap(<DeveloperAppsPage client={client} />);
    expect((await find("devapps-empty")).textContent).toContain(en["developer.apps.empty"]);
  });

  it("registers a confidential app and shows its secret once", async () => {
    const { client, m } = fakeDeveloper();
    wrap(<DeveloperAppsPage client={client} />);
    await find("devapp-row");
    click("devapp-new");
    await find("devapp-form");
    expect(id("devapp-confidential").getAttribute("aria-checked")).toBe("true");
    type("devapp-name", "Alerts");
    type("devapp-description", "My overlay");
    type("devapp-redirects", "https://a.example/cb\nhttp://127.0.0.1/cb");
    click("devapp-submit");
    const dialog = await find("devapp-secret");
    expect(m.apps.create).toHaveBeenCalledWith({
      name: "Alerts",
      description: "My overlay",
      redirectUris: ["https://a.example/cb", "http://127.0.0.1/cb"],
      confidential: true,
    });
    expect(dialog.dataset.clientId).toBe("ca_new");
    expect(id("devapp-secret-value").textContent).toBe(SECRET);
    id("devapp-secret-copy");
    click("devapp-secret-done");
    await waitFor(() => expect(screen.queryByTestId("devapp-secret")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getAllByTestId("devapp-row").map((r) => r.dataset.appId)).toEqual(["new-app", APP_ID]);
  });

  it("registers a public app with no secret", async () => {
    const { client, m } = fakeDeveloper();
    wrap(<DeveloperAppsPage client={client} />);
    await find("devapp-row");
    click("devapp-new");
    await find("devapp-form");
    fireEvent.click(id("devapp-confidential"));
    type("devapp-name", "Desktop");
    type("devapp-redirects", "http://localhost/cb");
    click("devapp-submit");
    await waitFor(() => expect(m.apps.create).toHaveBeenCalledTimes(1));
    expect(m.apps.create.mock.calls[0]?.[0]).toMatchObject({ confidential: false });
    await waitFor(() => expect(screen.queryByTestId("devapp-form")).toBeNull());
    expect(screen.queryByTestId("devapp-secret")).toBeNull();
  });

  it("checks redirect URIs before calling the API, and shows refusals inline", async () => {
    const { client, m } = fakeDeveloper();
    wrap(<DeveloperAppsPage client={client} />);
    await find("devapp-row");
    click("devapp-new");
    await find("devapp-form");
    type("devapp-name", "Bad");
    type("devapp-redirects", "http://example.org/cb");
    click("devapp-submit");
    expect(await screen.findByText(/loopback|127\.0\.0\.1/)).toBeTruthy();
    expect(m.apps.create).not.toHaveBeenCalled();
    m.apps.create.mockRejectedValueOnce(apiError("PRECONDITION_FAILED", { requirement: "app_limit" }));
    type("devapp-redirects", "https://example.org/cb");
    click("devapp-submit");
    const error = await find("devapp-form-error");
    expect(error.textContent).toContain("25");
    expect(screen.queryByTestId("devapp-secret")).toBeNull();
  });
});

// ── /developer/apps/$appId ───────────────────────────────────────────────────────────────────

function renderApp(client: DeveloperClient, onDeleted = vi.fn<() => void>()) {
  wrap(<DeveloperAppPage appId={APP_ID} client={client} onDeleted={onDeleted} />);
  return onDeleted;
}

describe("/developer/apps/$appId", () => {
  it("shows the app's credentials", async () => {
    const { client } = fakeDeveloper();
    renderApp(client);
    const page = await find("devapp");
    expect([page.dataset.appId, page.dataset.clientId, page.dataset.confidential, page.dataset.suspended]).toEqual([
      APP_ID,
      "ca_client_1",
      "true",
      "false",
    ]);
    expect(id("devapp-client-id").textContent).toBe("ca_client_1");
    expect(screen.getByText("https://overlay.example.org/cb")).toBeTruthy();
  });

  it("is not found for an app that is not yours", async () => {
    const { client, m } = fakeDeveloper();
    m.apps.list.mockResolvedValueOnce([]);
    renderApp(client);
    expect(await screen.findByText(en["page.notFound"])).toBeTruthy();
    expect(screen.queryByTestId("devapp")).toBeNull();
  });

  it("edits the app in the filled form", async () => {
    const { client, m } = fakeDeveloper();
    renderApp(client);
    await find("devapp");
    click("devapp-edit");
    await find("devapp-form");
    expect((id("devapp-name") as HTMLInputElement).value).toBe("Overlay");
    expect((id("devapp-redirects") as HTMLTextAreaElement).value).toBe("https://overlay.example.org/cb");
    expect(
      id("devapp-confidential").hasAttribute("data-disabled") ||
        id("devapp-confidential").getAttribute("aria-disabled") === "true",
    ).toBe(true);
    type("devapp-description", "New words");
    click("devapp-submit");
    await waitFor(() =>
      expect(m.apps.update).toHaveBeenCalledWith({
        id: APP_ID,
        name: "Overlay",
        description: "New words",
        redirectUris: ["https://overlay.example.org/cb"],
      }),
    );
    await waitFor(() => expect(screen.getByText("New words")).toBeTruthy());
  });

  it("rotates the secret after a confirmation and shows it once", async () => {
    const { client, m } = fakeDeveloper();
    renderApp(client);
    await find("devapp");
    expect(document.body.textContent).toContain("Issued");
    click("devapp-rotate");
    expect(m.apps.rotateSecret).not.toHaveBeenCalled();
    await confirm();
    await find("devapp-secret");
    expect(m.apps.rotateSecret).toHaveBeenCalledWith({ id: APP_ID });
    expect(id("devapp-secret-value").textContent).toBe(SECRET);
    click("devapp-secret-done");
    await waitFor(() => expect(document.body.textContent).not.toContain(SECRET));
    // The rotation date shows without a reload.
    expect(document.body.textContent).toContain("Last rotated");
  });

  it("has no rotation for a public app", async () => {
    const { client, m } = fakeDeveloper();
    m.apps.list.mockResolvedValueOnce([oauthApp({ confidential: false })]);
    renderApp(client);
    await find("devapp");
    expect(screen.queryByTestId("devapp-rotate")).toBeNull();
  });

  it("deletes after a confirmation", async () => {
    const { client, m } = fakeDeveloper();
    const onDeleted = renderApp(client);
    await find("devapp");
    click("devapp-delete");
    expect(await screen.findByText(en["developer.app.deleteBody"])).toBeTruthy();
    expect(m.apps.remove).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(m.apps.remove).toHaveBeenCalledWith({ id: APP_ID });
  });

  it("disables edit and rotate on a suspended app and says why", async () => {
    const { client, m } = fakeDeveloper();
    m.apps.list.mockResolvedValueOnce([oauthApp({ suspended: { at: T0, reason: "spam" } })]);
    renderApp(client);
    const page = await find("devapp");
    expect(page.dataset.suspended).toBe("true");
    expect((id("devapp-edit") as HTMLButtonElement).disabled).toBe(true);
    expect((id("devapp-rotate") as HTMLButtonElement).disabled).toBe(true);
    expect((id("devapp-delete") as HTMLButtonElement).disabled).toBe(false);
    expect((id("devsub-new") as HTMLButtonElement).disabled).toBe(true);
    expect(page.textContent).toContain(en["developer.reason.spam"]);
  });

  it("lists subscriptions, sends a test event and deletes one", async () => {
    const { client, m } = fakeDeveloper();
    m.events.list.mockResolvedValue(
      page([subscription(), subscription({ id: "ws", transport: { method: "websocket", sessionId: "s1" } })]),
    );
    renderApp(client);
    await find("devsubs");
    await waitFor(() => expect(screen.getAllByTestId("devsub")).toHaveLength(2));
    expect(m.events.list).toHaveBeenCalledWith({ appId: APP_ID, limit: 25 });
    const [hook, ws] = screen.getAllByTestId("devsub") as HTMLElement[];
    expect([hook?.dataset.subscriptionId, hook?.dataset.type, hook?.dataset.transport, hook?.dataset.status]).toEqual([
      "0192f000-0000-7000-8000-0000000000b1",
      "channel.follow",
      "webhook",
      "enabled",
    ]);
    // A WebSocket subscription has no test events and no delivery log.
    expect(within(ws as HTMLElement).queryByTestId("devsub-test")).toBeNull();
    expect(within(ws as HTMLElement).queryByTestId("devsub-deliveries")).toBeNull();
    fireEvent.click(within(hook as HTMLElement).getByTestId("devsub-test"));
    await waitFor(() => expect(m.events.sendTest).toHaveBeenCalledWith({ id: "0192f000-0000-7000-8000-0000000000b1" }));
    record();
    // The server no longer lists it; the merge alone would keep the row that was shown.
    m.events.list.mockResolvedValue(
      page([subscription({ id: "ws", transport: { method: "websocket", sessionId: "s1" } })]),
    );
    fireEvent.click(within(hook as HTMLElement).getByTestId("devsub-delete"));
    await confirm();
    await waitFor(() =>
      expect(m.events.unsubscribe).toHaveBeenCalledWith({ id: "0192f000-0000-7000-8000-0000000000b1" }),
    );
    await waitFor(() =>
      expect((screen.getAllByTestId("devsub") as HTMLElement[]).map((r) => r.dataset.subscriptionId)).toEqual(["ws"]),
    );
  });

  it("shows a refused test event inline", async () => {
    const { client, m } = fakeDeveloper();
    m.events.sendTest.mockRejectedValueOnce(apiError("PRECONDITION_FAILED", { requirement: "not_enabled" }));
    renderApp(client);
    await find("devsub");
    click("devsub-test");
    expect(await screen.findByText(en["developer.error.notEnabled"])).toBeTruthy();
  });

  it("shows the empty subscriptions state", async () => {
    const { client, m } = fakeDeveloper();
    m.events.list.mockResolvedValue(page([]));
    renderApp(client);
    expect((await find("devsubs-empty")).textContent).toContain(en["developer.subs.empty"]);
  });

  it("builds the subscription form from the catalog", async () => {
    const { client, m } = fakeDeveloper();
    renderApp(client);
    await find("devsub");
    click("devsub-new");
    await find("devsub-form");
    await waitFor(() => expect(screen.getByTestId("devsub-type")).toBeTruthy());
    expect(screen.queryByTestId("devsub-condition-broadcaster_user_id")).toBeNull();
    await pick("devsub-type", "devsub-type-channel.raid");
    // WebSocket-only types are not offered.
    expect(screen.getByTestId("devsub-type-channel.follow")).toBeTruthy();
    expect(screen.queryByTestId("devsub-type-channel.chat.message")).toBeNull();
    await find("devsub-condition-to_broadcaster_user_id");
    expect(screen.getByTestId("devsub-condition-from_broadcaster_user_id")).toBeTruthy();
    expect(screen.queryByTestId("devsub-condition-broadcaster_user_id")).toBeNull();

    await pick("devsub-type", "devsub-type-channel.follow");
    await find("devsub-condition-broadcaster_user_id");
    expect(screen.queryByTestId("devsub-condition-to_broadcaster_user_id")).toBeNull();
    type("devsub-condition-broadcaster_user_id", STREAMER);
    type("devsub-callback", "https://hooks.example.org/hook");
    expect((id("devsub-secret") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByText(en["developer.sub.generate"]));
    const secret = (id("devsub-secret") as HTMLInputElement).value;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    click("devsub-submit");
    await waitFor(() =>
      expect(m.events.subscribe).toHaveBeenCalledWith({
        type: "channel.follow",
        version: "1",
        condition: { broadcaster_user_id: STREAMER },
        transport: { method: "webhook", callback: "https://hooks.example.org/hook", secret },
        appId: APP_ID,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("devsub-form")).toBeNull());
  });

  it("shows the API's subscription refusals inline", async () => {
    const { client, m } = fakeDeveloper();
    m.events.subscribe.mockRejectedValueOnce(apiError("FORBIDDEN"));
    renderApp(client);
    await find("devsub");
    click("devsub-new");
    await find("devsub-form");
    await waitFor(() => expect(screen.getByTestId("devsub-type")).toBeTruthy());
    await pick("devsub-type", "devsub-type-channel.subscribe");
    await find("devsub-condition-broadcaster_user_id");
    expect(screen.getByText("channel:read:subscriptions")).toBeTruthy();
    type("devsub-condition-broadcaster_user_id", STREAMER);
    type("devsub-callback", "https://hooks.example.org/hook");
    type("devsub-secret", "0123456789");
    click("devsub-submit");
    expect(await screen.findByText(en["developer.sub.error.notAuthorized"])).toBeTruthy();
    expect(screen.getByTestId("devsub-form")).toBeTruthy();
  });

  it("pages the delivery log, offers redelivery on notifications and refreshes", async () => {
    const { client, m } = fakeDeveloper();
    m.events.deliveries.mockImplementation(async (input) =>
      input.cursor === "c2"
        ? page([delivery(3, { status: "failed", responseStatus: null, error: "timeout" })])
        : page([delivery(1), delivery(2, { messageType: "webhook_callback_verification" })], "c2"),
    );
    renderApp(client);
    await find("devsub");
    click("devsub-deliveries");
    await waitFor(() => expect(screen.getAllByTestId("devdelivery")).toHaveLength(2));
    record();
    expect(m.events.deliveries).toHaveBeenCalledWith({ id: "0192f000-0000-7000-8000-0000000000b1", limit: 25 });
    const [first, verification] = screen.getAllByTestId("devdelivery") as HTMLElement[];
    expect([
      first?.dataset.deliveryId,
      first?.dataset.messageType,
      first?.dataset.status,
      first?.dataset.responseStatus,
      first?.dataset.attempt,
    ]).toEqual([delivery(1).id, "notification", "succeeded", "204", "1"]);
    expect(within(verification as HTMLElement).queryByTestId("devdelivery-redeliver")).toBeNull();
    fireEvent.click(screen.getByText(en["developer.loadMore"]));
    await waitFor(() => expect(screen.getAllByTestId("devdelivery")).toHaveLength(3));
    const failed = screen.getAllByTestId("devdelivery")[2] as HTMLElement;
    expect([failed.dataset.status, failed.dataset.responseStatus]).toEqual(["failed", ""]);

    // The redelivery adds an attempt; the refresh merges it on top and keeps the paged-in rows.
    m.events.deliveries.mockImplementation(async (input) =>
      input.cursor === "c2"
        ? page([delivery(3, { status: "failed", responseStatus: null })])
        : page(
            [
              delivery(4, { messageId: "m3", attempt: 2 }),
              delivery(1),
              delivery(2, { messageType: "webhook_callback_verification" }),
            ],
            "c2",
          ),
    );
    fireEvent.click(within(failed).getByTestId("devdelivery-redeliver"));
    await waitFor(() => expect(m.events.redeliver).toHaveBeenCalledWith({ id: delivery(3).id }));
    await waitFor(() => expect(screen.getAllByTestId("devdelivery")).toHaveLength(4));
    expect(screen.getAllByTestId("devdelivery").map((r) => r.dataset.attempt)).toEqual(["2", "1", "1", "1"]);
  });

  it("shows a refused redelivery inline", async () => {
    const { client, m } = fakeDeveloper();
    m.events.redeliver.mockRejectedValueOnce(apiError("PRECONDITION_FAILED", { requirement: "not_replayable" }));
    renderApp(client);
    await find("devsub");
    click("devsub-deliveries");
    await find("devdelivery-redeliver");
    click("devdelivery-redeliver");
    expect(await screen.findByText(en["developer.error.notReplayable"])).toBeTruthy();
  });
});

// ── /developer/bots ──────────────────────────────────────────────────────────────────────────

describe("/developer/bots", () => {
  it("lists bots and tokens", async () => {
    const { client } = fakeDeveloper();
    wrap(<DeveloperBotsPage client={client} />);
    const row = await find("devbot");
    expect([row.dataset.botId, row.dataset.username]).toEqual(["0192f000-0000-7000-8000-0000000000c1", "annbot"]);
    const token = await find("devtoken");
    expect([token.dataset.tokenId, token.dataset.appId, token.dataset.kind]).toEqual([
      "0192f000-0000-7000-8000-0000000000d1",
      "",
      "personal",
    ]);
    id("devbots");
  });

  it("shows the empty state and creates a bot", async () => {
    const { client, m } = fakeDeveloper();
    m.bots.list.mockResolvedValueOnce([]);
    wrap(<DeveloperBotsPage client={client} />);
    await find("devbots-empty");
    click("devbot-new");
    await find("devbot-form");
    type("devbot-username", "Bad Name");
    type("devbot-display-name", "My Bot");
    click("devbot-submit");
    expect(await screen.findByText(/lowercase letters/)).toBeTruthy();
    expect(m.bots.create).not.toHaveBeenCalled();
    m.bots.create.mockRejectedValueOnce(apiError("PRECONDITION_FAILED", { requirement: "bot_limit" }));
    type("devbot-username", "mybot");
    click("devbot-submit");
    expect(await screen.findByText(en["developer.error.botLimit"])).toBeTruthy();
    click("devbot-submit");
    await waitFor(() => expect(m.bots.create).toHaveBeenLastCalledWith({ username: "mybot", displayName: "My Bot" }));
    await waitFor(() => expect(screen.getAllByTestId("devbot")).toHaveLength(1));
  });

  it("mints a token once, with scope identifiers and the IRC hint", async () => {
    const { client, m } = fakeDeveloper();
    wrap(<DeveloperBotsPage client={client} />);
    await find("devbot");
    click("devbot-token-new");
    const form = await find("devbot-token-form");
    for (const scope of SCOPE_NAMES) {
      const box = id(`devbot-scope-${scope}`);
      expect(form.contains(box)).toBe(true);
    }
    expect(within(form).getByText("chat:edit").tagName).toBe("CODE");
    click("devbot-token-submit");
    expect(await screen.findByText(en["developer.token.error.scopes"])).toBeTruthy();
    fireEvent.click(id("devbot-scope-chat:read"));
    fireEvent.click(id("devbot-scope-chat:edit"));
    type("devbot-token-days", "30");
    click("devbot-token-submit");
    const value = await find("devbot-token-value");
    expect(m.bots.createToken).toHaveBeenCalledWith({
      botId: "0192f000-0000-7000-8000-0000000000c1",
      scopes: ["chat:read", "chat:edit"],
      expiresInDays: 30,
    });
    expect(value.textContent).toBe(TOKEN);
    expect(screen.getByText("oauth:<token>")).toBeTruthy();
    // The token list reloads with the new token.
    await waitFor(() => expect(m.tokens.list).toHaveBeenCalledTimes(2));
    click("devbot-token-done");
    await waitFor(() => expect(screen.queryByTestId("devbot-token-value")).toBeNull());
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("explains that the channel bot cannot have tokens", async () => {
    const { client, m } = fakeDeveloper();
    m.bots.createToken.mockRejectedValueOnce(apiError("PRECONDITION_FAILED", { requirement: "channel_bot" }));
    wrap(<DeveloperBotsPage client={client} />);
    await find("devbot");
    click("devbot-token-new");
    await find("devbot-token-form");
    fireEvent.click(id("devbot-scope-chat:read"));
    click("devbot-token-submit");
    const form = id("devbot-token-form");
    expect(await within(form).findByText(en["developer.error.channelBot"])).toBeTruthy();
    expect(screen.queryByTestId("devbot-token-value")).toBeNull();
  });

  it("revokes a token after a confirmation", async () => {
    const { client, m } = fakeDeveloper();
    m.tokens.list.mockResolvedValueOnce([
      accessToken(),
      accessToken({ id: "t2", appId: APP_ID, appName: "Overlay", kind: "authorization_code" }),
    ]);
    wrap(<DeveloperBotsPage client={client} />);
    await waitFor(() => expect(screen.getAllByTestId("devtoken")).toHaveLength(2));
    const second = screen.getAllByTestId("devtoken")[1] as HTMLElement;
    expect([second.dataset.appId, second.dataset.kind]).toEqual([APP_ID, "authorization_code"]);
    fireEvent.click(within(second).getByTestId("devtoken-revoke"));
    expect(m.tokens.revoke).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(m.tokens.revoke).toHaveBeenCalledWith({ id: "t2" }));
    await waitFor(() => expect(screen.getAllByTestId("devtoken")).toHaveLength(1));
  });
});

// ── /admin/apps ──────────────────────────────────────────────────────────────────────────────

describe("/admin/apps", () => {
  it("lists apps with owner and counts", async () => {
    const { client, m } = fakeAdmin();
    wrap(<AdminAppsPage client={client} />);
    await find("adminapps");
    await waitFor(() => expect(screen.getAllByTestId("adminapp")).toHaveLength(2));
    record();
    expect(m.list).toHaveBeenCalledWith({ limit: 25 });
    const [a, b] = screen.getAllByTestId("adminapp") as HTMLElement[];
    expect([
      a?.dataset.appId,
      a?.dataset.clientId,
      a?.dataset.suspended,
      a?.dataset.grants,
      a?.dataset.subscriptions,
    ]).toEqual([APP_ID, "ca_client_1", "false", "3", "2"]);
    expect(a?.textContent).toContain("@ann");
    expect(a?.textContent).toContain("3 users authorized");
    expect(b?.dataset.suspended).toBe("true");
    expect(within(a as HTMLElement).queryByTestId("adminapp-unsuspend")).toBeNull();
    expect(within(b as HTMLElement).queryByTestId("adminapp-suspend")).toBeNull();
  });

  it("searches and filters", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { client, m } = fakeAdmin();
      wrap(<AdminAppsPage client={client} />);
      await screen.findAllByTestId("adminapp");
      type("adminapps-search", "  spam ");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
      });
      await waitFor(() => expect(m.list).toHaveBeenLastCalledWith({ limit: 25, q: "spam" }));
      m.list.mockResolvedValueOnce(page([]));
      fireEvent.click(id("adminapps-filter-suspended"));
      await waitFor(() => expect(m.list).toHaveBeenLastCalledWith({ limit: 25, q: "spam", suspended: true }));
      await find("adminapps-empty");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends with a reason after a confirmation", async () => {
    const { client, m } = fakeAdmin();
    wrap(<AdminAppsPage client={client} />);
    await find("adminapp-suspend");
    click("adminapp-suspend");
    const form = await find("adminapp-suspend-form");
    id("adminapp-reason");
    for (const r of APP_SUSPENSION_REASONS) expect(form.contains(id(`adminapp-reason-${r}`))).toBe(true);
    click("adminapp-suspend-submit");
    expect(await screen.findByText(en["developer.admin.reasonMissing"])).toBeTruthy();
    fireEvent.click(id("adminapp-reason-spam"));
    click("adminapp-suspend-submit");
    expect(await screen.findByText(/tokens stay|Every token of the app is revoked/)).toBeTruthy();
    expect(m.suspend).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(m.suspend).toHaveBeenCalledWith({ id: APP_ID, reason: "spam" }));
    await waitFor(() => expect((screen.getAllByTestId("adminapp")[0] as HTMLElement).dataset.suspended).toBe("true"));
  });

  it("unsuspends after a confirmation that says tokens stay revoked", async () => {
    const { client, m } = fakeAdmin();
    wrap(<AdminAppsPage client={client} />);
    await find("adminapp-unsuspend");
    click("adminapp-unsuspend");
    expect(await screen.findByText(en["developer.admin.unsuspendBody"])).toBeTruthy();
    await confirm();
    await waitFor(() => expect(m.unsuspend).toHaveBeenCalledWith({ id: "a2" }));
    await waitFor(() => expect((screen.getAllByTestId("adminapp")[1] as HTMLElement).dataset.suspended).toBe("false"));
  });

  it("drops local changes when the search or filter changes", async () => {
    const { client, m } = fakeAdmin();
    wrap(<AdminAppsPage client={client} />);
    await find("adminapp-unsuspend");
    click("adminapp-unsuspend");
    await confirm();
    await waitFor(() => expect((screen.getAllByTestId("adminapp")[1] as HTMLElement).dataset.suspended).toBe("false"));
    // Another admin suspended it again; the filtered list must show the server's copy.
    m.list.mockResolvedValueOnce(page([adminApp({ id: "a2", name: "Spammy", suspended: { at: T0, reason: "spam" } })]));
    fireEvent.click(id("adminapps-filter-suspended"));
    await waitFor(() => expect(m.list).toHaveBeenLastCalledWith({ limit: 25, suspended: true }));
    await waitFor(() => expect((screen.getAllByTestId("adminapp")[0] as HTMLElement).dataset.suspended).toBe("true"));
  });
});

// ── Selectors ────────────────────────────────────────────────────────────────────────────────

/** Ids in the three E9-console sections of the selectors document (patterns become prefixes). */
function documentedIds(): { ids: string[]; prefixes: string[] } {
  const doc = readFileSync(join(import.meta.dirname, "../../../docs/testing/e9-selectors.md"), "utf8");
  const sections = ["### Developer console", "### Bots and tokens", "### Apps"];
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const heading of sections) {
    const start = doc.indexOf(heading);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start + heading.length);
    const end = rest.search(/\n##/);
    const body = end === -1 ? rest : rest.slice(0, end);
    for (const m of body.matchAll(/`([a-z][a-z0-9-]*(?:-<[a-z]+>)?)`/g)) {
      const v = m[1] ?? "";
      if (v.endsWith(">")) prefixes.add(v.replace(/<[a-z]+>$/, ""));
      else if (/^(dev|admin)/.test(v)) ids.add(v);
    }
  }
  return { ids: [...ids], prefixes: [...prefixes] };
}

describe("selectors", () => {
  it("rendered every id of the Developer console, Bots and tokens and Apps sections", () => {
    const { ids, prefixes } = documentedIds();
    // Sidebar links belong to the contract step's layouts.
    const own = ids.filter((i) => i !== "admin-apps-link");
    expect(own.length).toBeGreaterThan(50);
    expect(own.filter((i) => !seen.has(i))).toEqual([]);
    for (const prefix of prefixes)
      expect(
        [...seen].some((s) => s.startsWith(prefix)),
        prefix,
      ).toBe(true);
  });
});
