// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D7.2, D7.4 and P7: `/settings/account` (name with an explicit Save, the picture through the
 * channel avatar upload, email verification, what channels see, the 18+ withdrawal), Preferences
 * (theme, data saver, P2P) and the three-step delete dialog built from
 * `me.deletion.preview`. Each runs on fake clients; the pure helpers are tested exhaustively.
 */
import type { DeletionPreview, Me } from "@commonair/contracts/dto";
import { LocaleProvider, NowProvider, TooltipProvider, type Theme } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

configure({ asyncUtilTimeout: 5_000 });

const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: unknown) => void>(),
  error: vi.fn<(message: unknown) => void>(),
  warning: vi.fn<(message: unknown) => void>(),
  info: vi.fn<(message: unknown) => void>(),
}));
vi.mock("@commonair/ui/toast", () => ({ toast: toasts }));
const metrics = vi.hoisted(() => ({ trackUi: vi.fn<(...args: unknown[]) => void>() }));
vi.mock("../src/lib/ui-metrics.ts", () => metrics);
vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, instance: { p2pDefault: "off" }, now: Date.now() }),
}));

const { maskEmail, displayNameProblem, DISPLAY_NAME_MAX } = await import("../src/components/settings/account-model.ts");
const { impactLines, canConfirm } = await import("../src/components/settings/delete-model.ts");
const { AccountSettings } = await import("../src/components/settings/account-page.tsx");
const { DeleteAccountSection } = await import("../src/components/settings/delete-account.tsx");
const { ThemeSection, PlaybackSection } = await import("../src/components/settings/preferences-sections.tsx");
const { ThemeContext } = await import("../src/lib/theme-context.ts");
type AccountClient = import("../src/components/settings/account-client.ts").AccountClient;
type ExportsState = import("../src/components/privacy-panels.tsx").ExportsState;
type DeletionClient = import("../src/components/settings/deletion-state.tsx").DeletionClient;

afterEach(() => {
  cleanup();
  for (const f of Object.values(toasts)) f.mockReset();
  metrics.trackUi.mockReset();
  try {
    localStorage.clear();
  } catch {
    // happy-dom always has it; the guard mirrors the code under test.
  }
});

function wrap(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{node}</> });
  const other = createRoute({ getParentRoute: () => root, path: "$", component: () => <p>elsewhere</p> });
  const router = createRouter({
    routeTree: root.addChildren([page, other]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <NowProvider now={Date.parse("2026-11-11T12:00:00.000Z")}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </NowProvider>
    </LocaleProvider>,
  );
  return router;
}

// ── pure helpers ───────────────────────────────────────────────────────────────────────────────

describe("maskEmail", () => {
  it("keeps the first and last character of the local part and the whole domain", () => {
    expect(maskEmail("stream1@example.org")).toBe("s•••••1@example.org");
  });
  it("hides at least three and at most eight characters", () => {
    expect(maskEmail("abc@x.io")).toBe("a•••c@x.io");
    expect(maskEmail("averyveryverylongname@x.io")).toBe("a••••••••e@x.io");
  });
  it("short local parts keep only the first character", () => {
    expect(maskEmail("ab@x.io")).toBe("a•••@x.io");
    expect(maskEmail("a@x.io")).toBe("a•••@x.io");
  });
  it("uses the last @, and something that is not an address is hidden whole", () => {
    expect(maskEmail("we@ird@x.io")).toBe("w••••d@x.io");
    expect(maskEmail("nope")).toBe("•••");
    expect(maskEmail("@x.io")).toBe("•••");
  });
});

describe("displayNameProblem", () => {
  it("refuses empty and blank names", () => {
    expect(displayNameProblem("")).toBe("empty");
    expect(displayNameProblem("   ")).toBe("empty");
  });
  it("refuses more than the contract's maximum, after trimming", () => {
    expect(displayNameProblem("x".repeat(DISPLAY_NAME_MAX))).toBeNull();
    expect(displayNameProblem(` ${"x".repeat(DISPLAY_NAME_MAX)} `)).toBeNull();
    expect(displayNameProblem("x".repeat(DISPLAY_NAME_MAX + 1))).toBe("tooLong");
  });
});

const preview = (over: Partial<DeletionPreview> = {}): DeletionPreview => ({
  graceDays: 30,
  activeSubscriptions: 0,
  channelSubscriptions: 0,
  pendingPayout: null,
  memberships: [],
  legalHold: false,
  scheduled: null,
  ...over,
});

describe("impactLines", () => {
  it("always says what is removed and what is kept, also without a preview", () => {
    expect(impactLines(null).map((l) => l.kind)).toEqual(["removed", "kept"]);
    expect(impactLines(preview()).map((l) => l.kind)).toEqual(["removed", "kept"]);
  });
  it("adds each line the preview calls for, in order", () => {
    const lines = impactLines(
      preview({
        activeSubscriptions: 2,
        channelSubscriptions: 1,
        pendingPayout: { cents: 1800, currency: "usd" },
        memberships: [
          { class: "streamer", shareRefund: null },
          { class: "viewer", shareRefund: { cents: 500, currency: "usd" } },
        ],
        legalHold: true,
      }),
    );
    expect(lines).toEqual([
      { kind: "removed" },
      { kind: "kept" },
      { kind: "subscriptions", count: 2 },
      { kind: "channelSubscriptions", count: 1 },
      { kind: "payout", amount: { cents: 1800, currency: "usd" } },
      { kind: "membership", share: { cents: 500, currency: "usd" } },
      { kind: "legalHold" },
    ]);
  });
  it("a membership without a refundable share still ends; a zero payout is no line", () => {
    const lines = impactLines(
      preview({ memberships: [{ class: "viewer", shareRefund: null }], pendingPayout: { cents: 0, currency: "usd" } }),
    );
    expect(lines.slice(2)).toEqual([{ kind: "membership", share: null }]);
  });
});

describe("canConfirm", () => {
  it("needs the download step ticked and the username typed (any case, trimmed)", () => {
    expect(canConfirm({ downloaded: false, typed: "viewer1", username: "viewer1" })).toBe(false);
    expect(canConfirm({ downloaded: true, typed: "", username: "viewer1" })).toBe(false);
    expect(canConfirm({ downloaded: true, typed: "viewer", username: "viewer1" })).toBe(false);
    expect(canConfirm({ downloaded: true, typed: " Viewer1 ", username: "viewer1" })).toBe(true);
  });
});

// ── /settings/account ──────────────────────────────────────────────────────────────────────────

const ME: Me = {
  id: "0192f000-0000-7000-8000-000000000001",
  username: "viewer1",
  displayName: "Viewer One",
  avatarUrl: null,
  accountType: "human",
  botOwner: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  email: "viewer1@example.org",
  emailVerified: true,
  twoFactorEnabled: false,
  role: "user",
  isAdult: true,
  matureConfirmed: false,
  matureConfirmedAt: null,
  shareEmailWithFollowedChannels: false,
  locale: null,
  memberships: [],
  pendingLegal: [],
  channelSlug: "viewer1",
  settingsSummary: { deletionScheduledFor: null, openAppeals: 0, openCopyright: 0 },
};

function accountFake(me: Me = ME) {
  let current = { ...me };
  const calls = {
    update: [] as unknown[],
    resend: [] as string[],
    images: [] as (string | null)[],
    uploads: [] as unknown[],
  };
  const client: AccountClient = {
    me: async () => current,
    update: async (input) => {
      calls.update.push(input);
      current = {
        ...current,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.shareEmailWithFollowedChannels !== undefined
          ? { shareEmailWithFollowedChannels: input.shareEmailWithFollowedChannels }
          : {}),
        ...(input.matureConfirmed === false ? { matureConfirmed: false, matureConfirmedAt: null } : {}),
      };
      return current;
    },
    resendVerification: async (email) => void calls.resend.push(email),
    setImage: async (key) => {
      calls.images.push(key);
      current = { ...current, avatarUrl: key ? `https://media.example/${key}` : null };
    },
    upload: {
      uploadUrl: async (input) => {
        calls.uploads.push(input);
        return { uploadUrl: "https://s3.example/put", key: "incoming/x", headers: {} };
      },
      put: async () => ({ ok: true }),
      commit: async () => ({ key: "channels/c1/avatar/a.png", url: "https://media.example/a.png" }),
    },
  };
  return { client, calls };
}

describe("AccountSettings", () => {
  it("profile, email and visibility sections, then the danger zone pointing at Privacy & data", async () => {
    const { client } = accountFake();
    wrap(<AccountSettings client={client} />);
    expect((await screen.findByTestId("account-username")).textContent).toBe("@viewer1");
    expect(screen.getByText(en["d7Settings.account.username.hint"])).toBeTruthy();
    expect(screen.getByTestId("account-email-address").textContent).toBe("v•••••1@example.org");
    expect(screen.getByTestId("account-email-status").textContent).toBe(en["d7Settings.account.email.verified"]);
    expect(screen.queryByTestId("account-email-resend")).toBeNull();
    expect(screen.getByTestId("account-email-change").getAttribute("href")).toBe("/settings/security#email");
    expect(screen.getByTestId("account-delete-link").getAttribute("href")).toBe("/settings/privacy#delete-account");
    const order = ["account-profile", "account-email", "account-visibility", "account-danger"].map((id) =>
      screen.getByTestId(id),
    );
    for (let i = 1; i < order.length; i++)
      expect((order[i - 1] as HTMLElement).compareDocumentPosition(order[i] as HTMLElement) & 4).toBeTruthy();
  });

  it("the display name saves only on Save, with its error after blur", async () => {
    const { client, calls } = accountFake();
    const router = wrap(<AccountSettings client={client} />);
    const invalidate = vi.spyOn(router, "invalidate");
    const input = (await screen.findByTestId("account-display-name")) as HTMLInputElement;
    const save = screen.getByTestId("account-display-name-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.queryByTestId("account-display-name-error")).toBeNull();
    fireEvent.blur(input);
    expect(screen.getByTestId("account-display-name-error").textContent).toBe(en["d7Settings.account.name.empty"]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(calls.update).toEqual([]);
    fireEvent.change(input, { target: { value: " Aurora " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(calls.update).toEqual([{ displayName: "Aurora" }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(en["d7Settings.saved"]));
    expect(invalidate).toHaveBeenCalled();
    expect(input.value).toBe("Aurora");
  });

  it("an unverified address offers Resend link", async () => {
    const { client, calls } = accountFake({ ...ME, emailVerified: false });
    wrap(<AccountSettings client={client} />);
    expect((await screen.findByTestId("account-email-status")).dataset.verified).toBe("false");
    fireEvent.click(screen.getByTestId("account-email-resend"));
    await waitFor(() => expect(calls.resend).toEqual(["viewer1@example.org"]));
    expect(toasts.success).toHaveBeenCalledWith(en["d7Settings.account.email.sent"]);
  });

  it("sharing the email autosaves", async () => {
    const { client, calls } = accountFake();
    wrap(<AccountSettings client={client} />);
    const sw = await screen.findByTestId("account-share-email");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.update).toEqual([{ shareEmailWithFollowedChannels: true }]));
    await waitFor(() => expect(screen.getByTestId("account-share-email").getAttribute("aria-checked")).toBe("true"));
    expect(toasts.success).toHaveBeenCalledWith(en["d7Settings.saved"]);
  });

  it("a confirmed 18+ shows its date and withdraws behind a confirmation", async () => {
    const { client, calls } = accountFake({
      ...ME,
      matureConfirmed: true,
      matureConfirmedAt: "2026-10-02T09:00:00.000Z",
    });
    wrap(<AccountSettings client={client} />);
    const row = await screen.findByTestId("account-mature");
    expect(row.dataset.confirmed).toBe("true");
    expect(row.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-02T09:00:00.000Z");
    fireEvent.click(within(row).getByTestId("account-mature-withdraw"));
    const dialog = await screen.findByTestId("account-mature-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(calls.update).toEqual([{ matureConfirmed: false }]));
    await waitFor(() => expect(screen.getByTestId("account-mature").dataset.confirmed).toBe("false"));
    expect(screen.queryByTestId("account-mature-withdraw")).toBeNull();
  });

  it("the picture goes through the channel avatar upload, then becomes the profile image", async () => {
    const { client, calls } = accountFake();
    wrap(<AccountSettings client={client} />);
    const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
    const input = (await screen.findByTestId("account-avatar-file")) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(calls.images).toEqual(["channels/c1/avatar/a.png"]));
    expect(calls.uploads).toEqual([{ channel: "viewer1", purpose: "avatar", contentType: "image/png", sizeBytes: 3 }]);
    await waitFor(() => expect(screen.getByTestId("account-avatar-remove")).toBeTruthy());
    fireEvent.click(screen.getByTestId("account-avatar-remove"));
    await waitFor(() => expect(calls.images).toEqual(["channels/c1/avatar/a.png", null]));
  });

  it("a wrong file type is refused before any upload", async () => {
    const { client, calls } = accountFake();
    wrap(<AccountSettings client={client} />);
    const input = (await screen.findByTestId("account-avatar-file")) as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "a.txt", { type: "text/plain" })],
      configurable: true,
    });
    fireEvent.change(input);
    expect((await screen.findByTestId("account-avatar-error")).textContent).toBe(en["appearance.wrongType"]);
    expect(calls.uploads).toEqual([]);
  });

  it("a failed load offers Retry", async () => {
    const { client } = accountFake();
    let fail = true;
    const flaky: AccountClient = {
      ...client,
      me: async () => {
        if (fail) throw new Error("down");
        return client.me();
      },
    };
    wrap(<AccountSettings client={flaky} />);
    const error = await screen.findByTestId("account-load-error");
    fail = false;
    fireEvent.click(within(error).getByRole("button"));
    expect(await screen.findByTestId("account-username")).toBeTruthy();
  });
});

// ── Preferences ────────────────────────────────────────────────────────────────────────────────

describe("Preferences sections", () => {
  it("the theme radio mirrors the account menu's choice", async () => {
    const setTheme = vi.fn<(t: Theme) => void>();
    wrap(
      <ThemeContext.Provider value={{ theme: "dark", setTheme }}>
        <ThemeSection />
      </ThemeContext.Provider>,
    );
    const group = await screen.findByTestId("preferences-theme-choice");
    expect(group.dataset.value).toBe("dark");
    fireEvent.click(screen.getByTestId("preferences-theme-light"));
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("light"));
    expect(toasts.success).toHaveBeenCalledWith(en["d7Settings.saved"]);
  });

  it("data saver and P2P (with its disclosure) save on this device; there is no previews switch", async () => {
    wrap(<PlaybackSection />);
    const dataSaver = await screen.findByTestId("preferences-data-saver");
    await waitFor(() => expect((dataSaver as HTMLButtonElement).getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(dataSaver);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("commonair-data-mode") ?? "{}").on).toBe(true));
    const p2p = screen.getByTestId("privacy-p2p-toggle");
    const hint = document.getElementById(p2p.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe(en["p2p.disclosure"]);
    fireEvent.click(p2p);
    await waitFor(() => expect(localStorage.getItem("commonair:p2p")).toContain("on"));
    // No preview surface plays by itself yet, so no switch claims to control one.
    expect(screen.queryByTestId("preferences-autoplay-previews")).toBeNull();
  });
});

// ── the delete dialog ──────────────────────────────────────────────────────────────────────────

function exportsFake(over: Partial<ExportsState> = {}): ExportsState & { requested: string[] } {
  const requested: string[] = [];
  return {
    exports: [],
    failed: false,
    load: async () => {},
    request: async (kind) => void requested.push(kind),
    requested,
    ...over,
  };
}

function deletionFake(initial: Awaited<ReturnType<DeletionClient["get"]>> = null) {
  const calls = { request: [] as string[], cancel: 0 };
  const client: DeletionClient = {
    get: async () => initial,
    request: async (confirmUsername) => {
      calls.request.push(confirmUsername);
      return { id: "d", status: "scheduled", scheduledFor: "2026-12-11T12:00:00.000Z", retained: [] };
    },
    cancel: async () => {
      calls.cancel++;
      return { ok: true };
    },
  };
  return { client, calls };
}

describe("DeleteAccountSection", () => {
  const full = preview({
    activeSubscriptions: 2,
    channelSubscriptions: 1,
    pendingPayout: { cents: 1800, currency: "usd" },
    memberships: [{ class: "viewer", shareRefund: { cents: 500, currency: "usd" } }],
    legalHold: true,
  });

  it("three steps: the impact from the preview, the download tick and the typed username", async () => {
    const { client, calls } = deletionFake();
    const exports = exportsFake();
    wrap(<DeleteAccountSection username="viewer1" exports={exports} client={client} preview={async () => full} />);
    fireEvent.click(await screen.findByTestId("deletion-request"));
    const dialog = await screen.findByTestId("deletion-dialog");
    await waitFor(() => expect(within(dialog).getAllByTestId("deletion-impact-line")).toHaveLength(7));
    expect(
      within(dialog)
        .getAllByTestId("deletion-impact-line")
        .map((l) => l.dataset.kind),
    ).toEqual(["removed", "kept", "subscriptions", "channelSubscriptions", "payout", "membership", "legalHold"]);
    // Money through MoneyAmount (its raw cents in `<data value>`).
    expect(dialog.querySelector('[data-kind="payout"] data')?.getAttribute("value")).toBe("1800");
    expect(dialog.querySelector('[data-kind="membership"] data')?.getAttribute("value")).toBe("500");
    expect(metrics.trackUi).toHaveBeenCalledWith("deletion", "view");

    const confirm = within(dialog).getByTestId("confirm-dialog-confirm");
    expect(confirm.textContent).toContain("Delete in 30 days");
    const disabled = () => confirm.getAttribute("aria-disabled") === "true";
    expect(disabled()).toBe(true);
    fireEvent.change(within(dialog).getByTestId("deletion-confirm-username"), { target: { value: "VIEWER1" } });
    expect(disabled()).toBe(true);
    fireEvent.click(within(dialog).getByTestId("deletion-downloaded"));
    await waitFor(() => expect(disabled()).toBe(false));

    // Download now requests the account export, right there.
    fireEvent.click(within(dialog).getByTestId("deletion-download-now"));
    await waitFor(() => expect(exports.requested).toEqual(["account"]));

    fireEvent.click(confirm);
    await waitFor(() => expect(calls.request).toEqual(["VIEWER1"]));
    const status = await screen.findByTestId("deletion-status");
    expect(status.dataset.status).toBe("scheduled");
    expect(metrics.trackUi).toHaveBeenCalledWith("deletion", "confirm");
    fireEvent.click(within(status).getByTestId("deletion-cancel"));
    await waitFor(() => expect(calls.cancel).toBe(1));
    await waitFor(() => expect(screen.getByTestId("deletion-status").dataset.status).toBe("canceled"));
    expect(screen.getByTestId("deletion-request")).toBeTruthy();
  });

  it("without a preview the general lines and a note still show, with the default grace", async () => {
    const { client } = deletionFake();
    wrap(
      <DeleteAccountSection
        username="viewer1"
        exports={exportsFake()}
        client={client}
        preview={async () => {
          throw new Error("down");
        }}
      />,
    );
    fireEvent.click(await screen.findByTestId("deletion-request"));
    const dialog = await screen.findByTestId("deletion-dialog");
    expect(await within(dialog).findByTestId("deletion-preview-error")).toBeTruthy();
    expect(
      within(dialog)
        .getAllByTestId("deletion-impact-line")
        .map((l) => l.dataset.kind),
    ).toEqual(["removed", "kept"]);
    expect(within(dialog).getByTestId("confirm-dialog-confirm").textContent).toContain("Delete in 30 days");
  });

  it("a ready account export is downloadable from step 2", async () => {
    const { client } = deletionFake();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const exports = exportsFake({
      exports: [
        {
          id: "e",
          kind: "account",
          status: "ready",
          downloadUrl: "https://s3.example/x.zip?sig",
          sizeBytes: 10,
          expiresAt: future,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    });
    wrap(<DeleteAccountSection username="viewer1" exports={exports} client={client} preview={async () => preview()} />);
    fireEvent.click(await screen.findByTestId("deletion-request"));
    const link = await screen.findByTestId("deletion-download");
    expect(link.getAttribute("href")).toBe("https://s3.example/x.zip?sig");
    expect(screen.queryByTestId("deletion-download-now")).toBeNull();
  });

  it("an existing scheduled deletion shows its date and Cancel instead of the request", async () => {
    const { client } = deletionFake({
      id: "d",
      status: "scheduled",
      scheduledFor: "2026-12-06T12:00:00.000Z",
      retained: [],
    });
    wrap(
      <DeleteAccountSection
        username="viewer1"
        exports={exportsFake()}
        client={client}
        preview={async () => preview()}
      />,
    );
    const status = await screen.findByTestId("deletion-status");
    expect(status.dataset.scheduledFor).toBe("2026-12-06T12:00:00.000Z");
    expect(within(status).getByTestId("deletion-cancel")).toBeTruthy();
    expect(screen.queryByTestId("deletion-request")).toBeNull();
    expect(screen.getByTestId("privacy-delete").id).toBe("delete-account");
  });
});
