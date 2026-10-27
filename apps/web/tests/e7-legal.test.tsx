// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Legal acceptance in the web: sign-up accepts only the documents that require it (and shows no
 * box when none do); the pending banner lists what changed, accepts it and goes away.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { matchPending, type PendingLegal } from "../src/components/legal-pending.tsx";
import { splitByAcceptance, type LegalDoc } from "../src/components/legal-document-link.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";

const state = vi.hoisted(() => ({
  me: null as SessionUser | null,
  docs: [] as LegalDoc[],
  pending: [] as PendingLegal[],
}));
const calls = vi.hoisted(() => ({
  signUp: vi.fn<(input: { acceptedDocumentIds: string[] }) => Promise<void>>(),
  acceptLegal: vi.fn<(input: { documentIds: string[] }) => Promise<{ ok: true }>>(),
  meGet: vi.fn<() => Promise<{ pendingLegal: PendingLegal[] }>>(),
  legalCurrent: vi.fn<() => Promise<LegalDoc[]>>(),
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => ({
    me: state.me,
    config: { currency: "usd" },
    instance: { name: "Test Air", sourceUrl: null },
    theme: "dark",
    now: 0,
  }),
  getSessionUser: async () => state.me,
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    legal: { current: () => calls.legalCurrent() },
    me: {
      get: () => calls.meGet(),
      acceptLegal: (input: { documentIds: string[] }) => calls.acceptLegal(input),
    },
  };
  return { ...actual, api: () => client };
});

vi.mock("../src/lib/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth.ts")>();
  return { ...actual, signUp: (input: { acceptedDocumentIds: string[] }) => calls.signUp(input) };
});

// The proof of work is not under test: report it solved at once.
vi.mock("../src/components/altcha-field.tsx", async () => {
  const React = await import("react");
  return {
    AltchaField: ({ onChange }: { onChange: (v: string | null) => void }) => {
      React.useEffect(() => onChange("solved"), [onChange]);
      return null;
    },
  };
});

vi.mock("@commonair/ui/toast", () => ({ toast: { error: (m: string) => calls.toastError(m) } }));

const { LegalPending } = await import("../src/components/legal-pending.tsx");
const { Route: SignUpRoute } = await import("../src/routes/_app/signup.tsx");

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function wrap(node: React.ReactNode) {
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

const doc = (kind: LegalDoc["kind"], requiresAcceptance: boolean, version = "2026-10-01"): LegalDoc => ({
  id: `id-${kind}-${version}`,
  kind,
  title: `Title ${kind}`,
  version,
  body: `Body ${kind}`,
  isDraft: true,
  requiresAcceptance,
});
const SEEDED = [
  doc("terms", true),
  doc("privacy", true),
  doc("guidelines", true),
  doc("cookies", false),
  doc("dmca_policy", false),
];
const ALICE: SessionUser = { id: "u1", username: "alice", displayName: "Alice", channelSlug: null, role: "user" };

beforeAll(async () => {
  const c = SignUpRoute.options.component as { preload?: () => Promise<void> } | undefined;
  await c?.preload?.();
});
beforeEach(() => {
  state.me = null;
  state.docs = SEEDED;
  state.pending = [];
  calls.signUp.mockReset().mockResolvedValue(undefined);
  calls.acceptLegal.mockReset().mockImplementation(async () => {
    state.pending = [];
    return { ok: true };
  });
  calls.meGet.mockReset().mockImplementation(async () => ({ pendingLegal: state.pending }));
  calls.legalCurrent.mockReset().mockImplementation(async () => state.docs);
  calls.toastError.mockReset();
});
afterEach(cleanup);

describe("splitByAcceptance / matchPending", () => {
  it("splits required from optional, keeping order", () => {
    const { required, optional } = splitByAcceptance(SEEDED);
    expect(required.map((d) => d.kind)).toEqual(["terms", "privacy", "guidelines"]);
    expect(optional.map((d) => d.kind)).toEqual(["cookies", "dmca_policy"]);
    expect(splitByAcceptance([])).toEqual({ required: [], optional: [] });
  });

  it("matches pending entries by kind and version", () => {
    const current = [doc("terms", true, "v2"), doc("privacy", true, "v1")];
    expect(
      matchPending(
        [
          { kind: "terms", version: "v2" },
          { kind: "privacy", version: "v0" },
        ],
        current,
      ).map((d) => d.id),
    ).toEqual(["id-terms-v2"]);
    expect(matchPending([], current)).toEqual([]);
  });
});

function SignUpPage(): React.JSX.Element {
  const C = SignUpRoute.options.component as React.ComponentType;
  return <C />;
}

async function submitSignUp(check: boolean, { waitForDocs = true } = {}) {
  const { container } = wrap(<SignUpPage />);
  const loaded = () => {
    if (!container.querySelector("[data-legal-kind]")) throw new Error("documents not listed yet");
  };
  if (waitForDocs) await waitFor(loaded);
  const form = container.querySelector("form");
  if (!form) throw new Error("no form");
  for (const [name, value] of [
    ["email", "a@example.test"],
    ["username", "alice"],
    ["password", "correct horse battery staple"],
    ["birthDate", "1990-05-05"],
  ])
    fireEvent.change(form.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
  const kinds = (root: Element | null | undefined) =>
    [...(root?.querySelectorAll("[data-legal-kind]") ?? [])].map((e) => e.getAttribute("data-legal-kind"));
  const links = {
    hasBox: screen.queryByTestId("signup-legal") !== null,
    byBox: kinds(screen.queryByTestId("signup-legal")?.closest('[data-slot="field"]')),
    all: kinds(container),
  };
  if (check) fireEvent.click(screen.getByTestId("signup-legal"));
  await waitFor(() => expect((screen.getByTestId("signup-submit") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.submit(form);
  await waitFor(() => expect(calls.signUp).toHaveBeenCalledTimes(1));
  return { links, input: calls.signUp.mock.calls[0]?.[0] };
}

describe("sign-up", () => {
  it("lists the required documents by the box, links the optional ones, and sends only required ids", async () => {
    const { links, input } = await submitSignUp(true);
    expect(links.hasBox).toBe(true);
    expect(links.byBox).toEqual(["terms", "privacy", "guidelines"]);
    expect(links.all).toEqual(["terms", "privacy", "guidelines", "cookies", "dmca_policy"]);
    expect(input?.acceptedDocumentIds).toEqual([
      "id-terms-2026-10-01",
      "id-privacy-2026-10-01",
      "id-guidelines-2026-10-01",
    ]);
  });

  it("hides the box and sends no ids when no document requires acceptance", async () => {
    state.docs = [doc("cookies", false), doc("dmca_policy", false)];
    const { links, input } = await submitSignUp(false);
    expect(links.hasBox).toBe(false);
    expect(links.all).toEqual(["cookies", "dmca_policy"]);
    expect(input?.acceptedDocumentIds).toEqual([]);
  });

  it("when the list failed to load, a ticked box still sends the required ids (fetched on submit)", async () => {
    calls.legalCurrent.mockRejectedValueOnce(new Error("offline"));
    const { links, input } = await submitSignUp(true, { waitForDocs: false });
    expect(links.hasBox).toBe(true);
    expect(links.all).toEqual([]);
    expect(calls.legalCurrent).toHaveBeenCalledTimes(2);
    expect(input?.acceptedDocumentIds).toEqual([
      "id-terms-2026-10-01",
      "id-privacy-2026-10-01",
      "id-guidelines-2026-10-01",
    ]);
  });
});

describe("LegalPending", () => {
  it("renders nothing when signed out, and never asks the API", async () => {
    const { container } = wrap(<LegalPending />);
    await Promise.resolve();
    expect(container.querySelector('[data-testid="legal-pending"]')).toBeNull();
    expect(calls.meGet).not.toHaveBeenCalled();
  });

  it("renders nothing for a signed-in user with nothing pending", async () => {
    state.me = ALICE;
    const { container } = wrap(<LegalPending />);
    await waitFor(() => expect(calls.meGet).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="legal-pending"]')).toBeNull();
  });

  it("lists the pending kinds with links, accepts the matching ids, refreshes and hides", async () => {
    state.me = ALICE;
    state.pending = [
      { kind: "terms", version: "2026-10-01" },
      { kind: "privacy", version: "2026-10-01" },
    ];
    wrap(<LegalPending />);
    const banner = await screen.findByTestId("legal-pending");
    expect(banner.getAttribute("data-kinds")).toBe("terms,privacy");
    expect(banner.textContent).toContain(en["legal.pending.title"]);
    await waitFor(() =>
      expect([...banner.querySelectorAll("[data-legal-kind]")].map((e) => e.getAttribute("data-legal-kind"))).toEqual([
        "terms",
        "privacy",
      ]),
    );
    fireEvent.click(screen.getByTestId("legal-pending-accept"));
    await waitFor(() => expect(screen.queryByTestId("legal-pending")).toBeNull());
    expect(calls.acceptLegal).toHaveBeenCalledWith({ documentIds: ["id-terms-2026-10-01", "id-privacy-2026-10-01"] });
    expect(calls.meGet).toHaveBeenCalledTimes(2);
    expect(calls.toastError).not.toHaveBeenCalled();
  });

  it("on failure: a toast, and the banner stays", async () => {
    state.me = ALICE;
    state.pending = [{ kind: "guidelines", version: "2026-10-01" }];
    calls.acceptLegal.mockRejectedValue(new Error("boom"));
    wrap(<LegalPending />);
    fireEvent.click(await screen.findByTestId("legal-pending-accept"));
    await waitFor(() => expect(calls.toastError).toHaveBeenCalledWith(en["legal.pending.failed"]));
    expect(screen.getByTestId("legal-pending").getAttribute("data-kinds")).toBe("guidelines");
  });

  it("does not accept a version the user was not shown, and shows what is pending now without an error", async () => {
    state.me = ALICE;
    state.pending = [{ kind: "terms", version: "2026-09-01" }];
    wrap(<LegalPending />);
    fireEvent.click(await screen.findByTestId("legal-pending-accept"));
    // A newer terms version was published meanwhile: the refresh shows it.
    state.pending = [{ kind: "terms", version: "2026-10-01" }];
    await waitFor(() => expect(calls.meGet).toHaveBeenCalledTimes(2));
    const banner = await screen.findByTestId("legal-pending");
    await waitFor(() => expect(banner.querySelector('[data-legal-kind="terms"]')?.textContent ?? "").not.toBe(""));
    expect(calls.acceptLegal).not.toHaveBeenCalled();
    expect(calls.toastError).not.toHaveBeenCalled();
  });
});
