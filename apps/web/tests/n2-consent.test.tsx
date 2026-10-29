// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The consent banner, the cookie settings dialog and the footer entry: the server and the first
 * client render agree, the banner asks exactly when it should (never on overlays or embeds), it
 * works from the keyboard, the dialog dismisses without saving and returns focus, and every id in
 * `docs/testing/n2-selectors.md` renders with its attributes.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

const fake = vi.hoisted(() => ({
  version: "v2",
  get: vi.fn<(input: { kind: string }) => Promise<unknown>>(),
  consent: vi.fn<(input: unknown) => Promise<{ ok: true }>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
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

vi.mock("@commonair/ui/toast", () => ({
  toast: { success: (m: string) => fake.toastSuccess(m), error: () => {} },
  Toaster: () => null,
}));

const { ConsentRoot } = await import("../src/components/consent/consent-root.tsx");
const { InstanceFooter } = await import("../src/components/site-chrome.tsx");
const { CONSENT_COOKIE, parseConsent, resetConsentForTests, serializeConsent } = await import("../src/lib/consent.ts");
type StoredConsent = import("../src/lib/consent.ts").StoredConsent;

class RpcError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const policy = () => ({
  id: "doc-cookies",
  kind: "cookies" as const,
  version: fake.version,
  title: "Cookie policy",
  body: "The cookie policy text.",
  isDraft: true,
  requiresAcceptance: false,
  publishedAt: "2026-10-29T00:00:00.000Z",
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function Page({ consent, pathname = "/" }: { consent: StoredConsent | null; pathname?: string }) {
  return (
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <ConsentRoot consent={consent} signedIn={false} pathname={pathname} />
          <main>
            <a href="/somewhere">Page content</a>
          </main>
          <InstanceFooter instance={{ name: "Test Air", sourceUrl: null, p2pDefault: "off" }} />
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>
  );
}

function clearCookies(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

function storeConsent(value: StoredConsent): void {
  document.cookie = `${CONSENT_COOKIE}=${serializeConsent(value)}; path=/`;
}

/** Focusable elements in tab order (nothing here sets a positive tabindex). */
function tabbables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0,
  );
}

/** Focus, then what a browser does for Enter or Space on a native button (happy-dom does not). */
function activate(el: HTMLElement): void {
  el.focus();
  expect(document.activeElement).toBe(el);
  fireEvent.click(el);
}

const current: StoredConsent = { version: "v2", preferences: true, recorded: "anonymous" };

beforeEach(() => {
  fake.version = "v2";
  fake.get.mockReset().mockImplementation(async () => policy());
  fake.consent.mockReset().mockResolvedValue({ ok: true });
  fake.toastSuccess.mockReset();
  resetConsentForTests();
  clearCookies();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("when the banner shows", () => {
  it("renders from Bootstrap.consent: null on the server and stays after hydration (no flash)", async () => {
    const html = renderToString(<Page consent={null} />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const server = container.querySelector('[data-testid="consent-banner"]');
    expect(server?.getAttribute("data-reason")).toBe("none");

    const errors: unknown[] = [];
    const seen: (string | null | undefined)[] = [];
    const observer = new MutationObserver(() =>
      seen.push(container.querySelector('[data-testid="consent-banner"]')?.getAttribute("data-reason")),
    );
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Page consent={null} />, { onRecoverableError: (e) => errors.push(e) });
    });
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    observer.disconnect();
    expect(errors).toEqual([]);
    expect(seen.every((reason) => reason === "none")).toBe(true);
    expect(container.querySelector('[data-testid="consent-banner"]')?.getAttribute("data-reason")).toBe("none");
    act(() => root?.unmount());
  });

  it("is absent on the server and the client with a current consent", async () => {
    storeConsent(current);
    expect(renderToString(<Page consent={current} />)).not.toContain("consent-banner");
    render(<Page consent={current} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("consent-banner")).toBeNull();
  });

  it("asks again for a choice made under an older policy", async () => {
    const old: StoredConsent = { version: "v1", preferences: true, recorded: "user" };
    storeConsent(old);
    render(<Page consent={old} />);
    const banner = await screen.findByTestId("consent-banner");
    expect(banner.getAttribute("data-reason")).toBe("policy-changed");
  });

  it.each(["/overlay/alerts", "/embed/somechannel"])("never shows on %s", async (pathname) => {
    expect(renderToString(<Page consent={null} pathname={pathname} />)).not.toContain("consent-");
    render(<Page consent={null} pathname={pathname} />);
    await act(async () => {});
    expect(screen.queryByTestId("consent-banner")).toBeNull();
    expect(screen.queryByTestId("consent-dialog")).toBeNull();
    expect(fake.get).not.toHaveBeenCalled();
  });
});

describe("the banner", () => {
  it("is a labelled region in the page flow, never fixed, sticky or animated outside motion-safe", () => {
    render(<Page consent={null} />);
    const banner = screen.getByTestId("consent-banner");
    expect(screen.getByRole("region", { name: "Cookies and storage" })).toBe(banner);
    const classes = banner.className.split(/\s+/);
    for (const forbidden of ["fixed", "sticky", "absolute"]) expect(classes).not.toContain(forbidden);
    const motion = classes.filter((cls) => /animate|fade-|slide-|zoom-|transition/.test(cls));
    expect(motion.length).toBeGreaterThan(0);
    expect(motion.filter((cls) => !cls.startsWith("motion-safe:"))).toEqual([]);
    // It sits before the page's content and takes no focus on load.
    expect(banner.compareDocumentPosition(screen.getByRole("main")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.contains(document.activeElement)).toBe(false);
  });

  it("is keyboard complete: the first tab stops are the three native buttons, in order", async () => {
    render(<Page consent={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    const ids = tabbables()
      .slice(0, 3)
      .map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["consent-accept-all", "consent-reject", "consent-customize"]);
    for (const id of ids) {
      const button = screen.getByTestId(id ?? "");
      // Native buttons: Enter and Space activate them in every browser, with no script of ours.
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.hasAttribute("disabled")).toBe(false);
    }
  });

  it("Enter on 'Essential only' declines", async () => {
    render(<Page consent={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    activate(screen.getByTestId("consent-reject"));
    await waitFor(() => expect(fake.consent).toHaveBeenCalledTimes(1));
    expect(fake.consent.mock.calls[0]?.[0]).toMatchObject({ choices: { essential: true, preferences: false } });
    expect(screen.queryByTestId("consent-banner")).toBeNull();
    await waitFor(() => expect(fake.toastSuccess).toHaveBeenCalledWith("Cookie choices saved"));
    expect(parseConsent(document.cookie)?.preferences).toBe(false);
  });

  it("Space on 'Allow preferences' allows them", async () => {
    render(<Page consent={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    activate(screen.getByTestId("consent-accept-all"));
    await waitFor(() => expect(fake.consent).toHaveBeenCalledTimes(1));
    expect(fake.consent.mock.calls[0]?.[0]).toMatchObject({ choices: { essential: true, preferences: true } });
    expect(screen.queryByTestId("consent-banner")).toBeNull();
  });

  it("'Settings' opens the dialog", async () => {
    render(<Page consent={null} />);
    fireEvent.click(screen.getByTestId("consent-customize"));
    expect(await screen.findByTestId("consent-dialog")).toBeTruthy();
  });

  it("shows the notice when the record fails, and the choice still applies", async () => {
    fake.consent.mockRejectedValueOnce(new RpcError("RATE_LIMITED"));
    render(<Page consent={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("consent-accept-all"));
    const notice = await screen.findByTestId("consent-error");
    expect(notice.getAttribute("data-code")).toBe("rate_limited");
    expect(fake.toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId("consent-banner")).toBeNull();
    expect(parseConsent(document.cookie)).toMatchObject({ preferences: true, recorded: "pending" });
  });

  it("asks again when the policy changed under the visitor", async () => {
    render(<Page consent={null} />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    fake.version = "v3";
    fake.consent.mockRejectedValueOnce(new RpcError("BAD_REQUEST"));
    fireEvent.click(screen.getByTestId("consent-reject"));
    const notice = await screen.findByTestId("consent-error");
    expect(notice.getAttribute("data-code")).toBe("policy_changed");
    expect(screen.getByTestId("consent-banner").getAttribute("data-reason")).toBe("policy-changed");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(fake.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("the cookie settings dialog", () => {
  it("opens from the footer, locks essential, and Escape closes without saving, back to the footer button", async () => {
    storeConsent(current);
    render(<Page consent={current} />);
    const footer = screen.getByTestId("footer-cookie-settings");
    expect(footer.tagName).toBe("BUTTON");
    expect(footer.getAttribute("type")).toBe("button");
    expect(footer.textContent).toBe("Cookie settings");
    activate(footer);
    const dialog = await screen.findByTestId("consent-dialog");
    await waitFor(() => expect(dialog.getAttribute("data-policy-version")).toBe("v2"));

    const rows = screen.getAllByTestId("consent-category");
    expect(rows.map((r) => r.getAttribute("data-category"))).toEqual(["essential", "preferences"]);
    const [essential, preferences] = rows;
    expect(essential?.getAttribute("data-locked")).toBe("true");
    expect(essential?.getAttribute("data-checked")).toBe("true");
    expect(preferences?.getAttribute("data-locked")).toBe("false");
    // The stored choice: preferences allowed.
    expect(preferences?.getAttribute("data-checked")).toBe("true");
    // Essential cannot be switched off: no control, just "Always on".
    expect(essential?.querySelector('[role="switch"]')).toBeNull();
    expect(essential?.textContent).toContain("Always on");

    fireEvent.click(screen.getByTestId("consent-toggle-preferences"));
    expect(preferences?.getAttribute("data-checked")).toBe("false");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("consent-dialog")).toBeNull());
    expect(fake.consent).not.toHaveBeenCalled();
    expect(parseConsent(document.cookie)).toEqual(current);
    await waitFor(() => expect(document.activeElement).toBe(footer));

    // Reopened, the switch shows the stored choice again, not the abandoned draft.
    fireEvent.click(footer);
    await screen.findByTestId("consent-dialog");
    const again = screen.getAllByTestId("consent-category")[1];
    expect(again?.getAttribute("data-checked")).toBe("true");
  });

  it("is off with no stored choice, and Save records what it shows", async () => {
    render(<Page consent={null} />);
    fireEvent.click(screen.getByTestId("footer-cookie-settings"));
    await screen.findByTestId("consent-dialog");
    expect(screen.getAllByTestId("consent-category")[1]?.getAttribute("data-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("consent-toggle-preferences"));
    fireEvent.click(screen.getByTestId("consent-save"));
    await waitFor(() => expect(fake.consent).toHaveBeenCalledTimes(1));
    expect(fake.consent.mock.calls[0]?.[0]).toMatchObject({
      choices: { essential: true, preferences: true },
      policyVersion: "v2",
    });
    await waitFor(() => expect(screen.queryByTestId("consent-dialog")).toBeNull());
    expect(screen.queryByTestId("consent-banner")).toBeNull();
  });

  it("links the cookie policy text", async () => {
    render(<Page consent={null} />);
    fireEvent.click(screen.getByTestId("footer-cookie-settings"));
    const wrapper = await screen.findByTestId("consent-policy-link");
    await waitFor(() => expect(wrapper.querySelector('[data-legal-kind="cookies"]')).not.toBeNull());
    expect(wrapper.textContent).toContain("Cookie policy");
  });
});

describe("the selector contract (docs/testing/n2-selectors.md)", () => {
  const doc = readFileSync(join(import.meta.dirname, "../../../docs/testing/n2-selectors.md"), "utf8");
  const ids = [...doc.slice(doc.indexOf("## Test ids")).matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]);

  it("lists the ids this unit renders", () => {
    expect(ids).toHaveLength(11);
  });

  it("renders every id with its attributes", async () => {
    fake.consent.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<Page consent={null} />);
    const seen = new Set<string>();
    const collect = () => {
      for (const el of document.querySelectorAll("[data-testid]")) {
        const id = el.getAttribute("data-testid");
        if (id) seen.add(id);
      }
    };
    const banner = screen.getByTestId("consent-banner");
    expect(banner.getAttribute("data-reason")).toBe("none");
    collect();
    fireEvent.click(screen.getByTestId("consent-customize"));
    const dialog = await screen.findByTestId("consent-dialog");
    await waitFor(() => expect(dialog.getAttribute("data-policy-version")).toBe("v2"));
    for (const row of screen.getAllByTestId("consent-category"))
      for (const attr of ["data-category", "data-checked", "data-locked"]) expect(row.hasAttribute(attr)).toBe(true);
    collect();
    fireEvent.click(screen.getByTestId("consent-save"));
    const error = await screen.findByTestId("consent-error");
    expect(error.getAttribute("data-code")).toBe("network");
    collect();
    for (const id of ids) expect(seen.has(id ?? ""), id).toBe(true);
  });
});
