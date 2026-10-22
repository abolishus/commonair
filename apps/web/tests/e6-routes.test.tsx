// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E6 pages with the session and the API stubbed: the spec's test ids, the API calls and their
 * inputs, load errors with a retry, and the OBS overlay page's states with a fake `EventSource`.
 */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";
import type { EventSourceLike, OverlayConnectionDeps } from "../src/lib/overlay-connection.ts";

const session = vi.hoisted(() => ({ me: null as SessionUser | null }));
const fns = vi.hoisted(() => ({
  simulcastList: vi.fn<(input: unknown) => Promise<unknown>>(),
  simulcastCreate: vi.fn<(input: unknown) => Promise<unknown>>(),
  simulcastUpdate: vi.fn<(input: unknown) => Promise<unknown>>(),
  simulcastRemove: vi.fn<(input: unknown) => Promise<unknown>>(),
  alertsList: vi.fn<(input: unknown) => Promise<unknown>>(),
  alertsSet: vi.fn<(input: unknown) => Promise<unknown>>(),
  alertsTest: vi.fn<(input: unknown) => Promise<unknown>>(),
  overlayToken: vi.fn<(input: unknown) => Promise<unknown>>(),
  overlayStatus: vi.fn<(input: unknown) => Promise<unknown>>(),
  overlayRevoke: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsList: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsUpdate: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsRemove: vi.fn<(input: unknown) => Promise<unknown>>(),
  clipsList: vi.fn<(input: unknown) => Promise<unknown>>(),
  clipsRemove: vi.fn<(input: unknown) => Promise<unknown>>(),
  exportsList: vi.fn<() => Promise<unknown>>(),
  exportsCreate: vi.fn<(input: unknown) => Promise<unknown>>(),
  deletionGet: vi.fn<() => Promise<unknown>>(),
  deletionRequest: vi.fn<(input: unknown) => Promise<unknown>>(),
  deletionCancel: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => ({
    me: session.me,
    config: { currency: "usd", publicUrl: "https://air.example" },
    instance: { name: "Test Air", sourceUrl: null },
    theme: "dark",
    now: 0,
  }),
  getSessionUser: async () => session.me,
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    stream: {
      simulcast: {
        list: (i: unknown) => fns.simulcastList(i),
        create: (i: unknown) => fns.simulcastCreate(i),
        update: (i: unknown) => fns.simulcastUpdate(i),
        remove: (i: unknown) => fns.simulcastRemove(i),
      },
    },
    interact: {
      alerts: {
        list: (i: unknown) => fns.alertsList(i),
        set: (i: unknown) => fns.alertsSet(i),
        test: (i: unknown) => fns.alertsTest(i),
      },
      overlays: {
        token: (i: unknown) => fns.overlayToken(i),
        status: (i: unknown) => fns.overlayStatus(i),
        revoke: (i: unknown) => fns.overlayRevoke(i),
      },
    },
    vods: {
      list: (i: unknown) => fns.vodsList(i),
      update: (i: unknown) => fns.vodsUpdate(i),
      remove: (i: unknown) => fns.vodsRemove(i),
    },
    clips: { list: (i: unknown) => fns.clipsList(i), remove: (i: unknown) => fns.clipsRemove(i) },
    me: {
      exports: { list: () => fns.exportsList(), create: (i: unknown) => fns.exportsCreate(i) },
      deletion: {
        get: () => fns.deletionGet(),
        request: (i: unknown) => fns.deletionRequest(i),
        cancel: () => fns.deletionCancel(),
      },
    },
  };
  return { ...actual, api: () => client };
});

const { SimulcastSection } = await import("../src/components/simulcast-section.tsx");
const { OverlayAlertsPage } = await import("../src/components/overlay-alerts-page.tsx");
const { Route: OverlaysRoute } = await import("../src/routes/_studio/overlays.tsx");
const { Route: ContentRoute } = await import("../src/routes/_studio/content.tsx");
const { Route: PrivacyRoute } = await import("../src/routes/_app/settings.privacy.tsx");

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function wrap(node: React.ReactNode) {
  return render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <NowProvider now={NOW}>
          <TooltipProvider>
            <React.Suspense fallback={null}>{node}</React.Suspense>
          </TooltipProvider>
        </NowProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
}

function component(route: { options: { component?: unknown } }): React.ComponentType {
  const c = route.options.component;
  if (typeof c !== "function") throw new Error("route has no component");
  return c as React.ComponentType;
}

const owner: SessionUser = {
  id: "0192f000-0000-7000-8000-000000000001",
  username: "rivertide",
  displayName: "Rivertide",
  channelSlug: "rivertide",
  role: "user",
};

const ids = (testId: string) => screen.queryAllByTestId(testId);
const attrs = (el: Element | undefined, ...names: string[]) => names.map((n) => el?.getAttribute(n) ?? null);
const reject = (code: string) => Promise.reject(Object.assign(new Error("refused"), { code }));

beforeAll(async () => {
  for (const route of [OverlaysRoute, ContentRoute, PrivacyRoute]) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
  session.me = owner;
});
afterEach(cleanup);

const target = (over: Record<string, unknown> = {}) => ({
  id: "0192f000-0000-7000-8000-0000000000a1",
  platform: "custom",
  name: "Mock",
  rtmpUrl: "rtmp://mock-rtmp:1936/live",
  enabled: true,
  status: "live",
  lastError: null,
  ...over,
});

describe("/dashboard simulcast", () => {
  it("lists targets with their status and enabled state", async () => {
    fns.simulcastList.mockResolvedValue([target(), target({ id: "t2", enabled: false, status: "idle" })]);
    wrap(<SimulcastSection channel="rivertide" />);
    await waitFor(() => expect(ids("simulcast-target")).toHaveLength(2));
    expect(fns.simulcastList).toHaveBeenCalledWith({ channel: "rivertide" });
    expect(attrs(ids("simulcast-target")[0], "data-target-id", "data-status", "data-enabled")).toEqual([
      "0192f000-0000-7000-8000-0000000000a1",
      "live",
      "true",
    ]);
    expect(attrs(ids("simulcast-target")[1], "data-status", "data-enabled")).toEqual(["idle", "false"]);
  });

  it("empty: the EmptyState and the add form", async () => {
    fns.simulcastList.mockResolvedValue([]);
    wrap(<SimulcastSection channel="rivertide" />);
    expect(await screen.findByTestId("simulcast-empty")).toBeTruthy();
    expect(screen.getByTestId("simulcast-add")).toBeTruthy();
  });

  it("adds a target with the typed values; the key never shows again", async () => {
    fns.simulcastList.mockResolvedValue([]);
    fns.simulcastCreate.mockResolvedValue(target({ status: "idle" }));
    wrap(<SimulcastSection channel="rivertide" />);
    await screen.findByTestId("simulcast-empty");
    fireEvent.change(screen.getByTestId("simulcast-name"), { target: { value: "Mock" } });
    fireEvent.change(screen.getByTestId("simulcast-url"), { target: { value: "rtmp://mock-rtmp:1936/live" } });
    fireEvent.change(screen.getByTestId("simulcast-key"), { target: { value: "harness-secret-key" } });
    fireEvent.click(screen.getByTestId("simulcast-add"));
    await waitFor(() =>
      expect(fns.simulcastCreate).toHaveBeenCalledWith({
        channel: "rivertide",
        name: "Mock",
        platform: "twitch",
        rtmpUrl: "rtmp://mock-rtmp:1936/live",
        streamKey: "harness-secret-key",
        enabled: true,
      }),
    );
    await waitFor(() => expect(ids("simulcast-target")).toHaveLength(1));
    expect(document.body.innerHTML).not.toContain("harness-secret-key");
    expect((screen.getByTestId("simulcast-key") as HTMLInputElement).value).toBe("");
  });

  it("refuses a URL with credentials before asking the API", async () => {
    fns.simulcastList.mockResolvedValue([]);
    wrap(<SimulcastSection channel="rivertide" />);
    await screen.findByTestId("simulcast-empty");
    fireEvent.change(screen.getByTestId("simulcast-name"), { target: { value: "Mock" } });
    fireEvent.change(screen.getByTestId("simulcast-url"), { target: { value: "rtmp://u:p@example.org/live" } });
    fireEvent.change(screen.getByTestId("simulcast-key"), { target: { value: "k" } });
    fireEvent.click(screen.getByTestId("simulcast-add"));
    const error = await screen.findByTestId("simulcast-error");
    expect(error.getAttribute("data-reason")).toBe("credentials");
    expect(fns.simulcastCreate).not.toHaveBeenCalled();
    // What was typed stays, so it can be fixed.
    expect((screen.getByTestId("simulcast-url") as HTMLInputElement).value).toBe("rtmp://u:p@example.org/live");
  });

  it("shows the API's refusal inline with its reason", async () => {
    fns.simulcastList.mockResolvedValue([]);
    fns.simulcastCreate.mockImplementation(() => reject("BAD_REQUEST"));
    wrap(<SimulcastSection channel="rivertide" />);
    await screen.findByTestId("simulcast-empty");
    fireEvent.change(screen.getByTestId("simulcast-name"), { target: { value: "Mock" } });
    fireEvent.change(screen.getByTestId("simulcast-url"), { target: { value: "rtmp://10.0.0.1/live" } });
    fireEvent.change(screen.getByTestId("simulcast-key"), { target: { value: "k" } });
    fireEvent.click(screen.getByTestId("simulcast-add"));
    const error = await screen.findByTestId("simulcast-error");
    expect(error.getAttribute("data-reason")).toBe("url");
    expect(error.textContent).toBe(en["simulcast.error.url"]);
  });

  it("toggles and removes (after confirming)", async () => {
    fns.simulcastList.mockResolvedValue([target()]);
    fns.simulcastUpdate.mockResolvedValue(target({ enabled: false, status: "idle" }));
    fns.simulcastRemove.mockResolvedValue({ ok: true });
    wrap(<SimulcastSection channel="rivertide" />);
    const row = await screen.findByTestId("simulcast-target");
    fireEvent.click(within(row).getByTestId("simulcast-enabled"));
    await waitFor(() =>
      expect(fns.simulcastUpdate).toHaveBeenCalledWith({
        channel: "rivertide",
        id: "0192f000-0000-7000-8000-0000000000a1",
        enabled: false,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("simulcast-target").getAttribute("data-enabled")).toBe("false"));
    fireEvent.click(within(screen.getByTestId("simulcast-target")).getByTestId("simulcast-remove"));
    fireEvent.click(await waitFor(() => screen.getByTestId("confirm-dialog-confirm")));
    await waitFor(() =>
      expect(fns.simulcastRemove).toHaveBeenCalledWith({
        channel: "rivertide",
        id: "0192f000-0000-7000-8000-0000000000a1",
      }),
    );
    await waitFor(() => expect(ids("simulcast-target")).toHaveLength(0));
  });

  it("a failed load shows an error with a retry, not a skeleton forever", async () => {
    fns.simulcastList.mockImplementationOnce(() => reject("INTERNAL_SERVER_ERROR")).mockResolvedValue([]);
    wrap(<SimulcastSection channel="rivertide" />);
    const error = await screen.findByTestId("simulcast-load-error");
    fireEvent.click(within(error).getByRole("button"));
    expect(await screen.findByTestId("simulcast-empty")).toBeTruthy();
  });
});

const alertConfig = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  enabled: false,
  template: { message: `\${user} ${type}`, animation: "fade", showMessage: true },
  minAmountCents: 0,
  durationMs: 6000,
  ...over,
});

describe("/overlays", () => {
  const configs = () => [alertConfig("follow"), alertConfig("raid"), alertConfig("tip"), alertConfig("subscription")];

  it("one alert-config per type, tip first, and the token panel", async () => {
    fns.alertsList.mockResolvedValue(configs());
    fns.overlayStatus.mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    wrap(React.createElement(component(OverlaysRoute)));
    await waitFor(() => expect(ids("alert-config")).toHaveLength(4));
    expect(ids("alert-config").map((el) => el.getAttribute("data-type"))).toEqual([
      "tip",
      "follow",
      "subscription",
      "raid",
    ]);
    expect(fns.alertsList).toHaveBeenCalledWith({ channel: "rivertide" });
    expect(fns.overlayStatus).toHaveBeenCalledWith({ channel: "rivertide" });
    const panel = await screen.findByTestId("overlay-token");
    expect(attrs(panel, "data-active", "data-expires-at")).toEqual(["false", ""]);
    expect(screen.queryByTestId("overlay-url")).toBeNull();
  });

  it("saves an alert with alerts.set and fires a test alert", async () => {
    fns.alertsList.mockResolvedValue(configs());
    fns.overlayStatus.mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    fns.alertsSet.mockImplementation(async (input) => {
      const i = input as {
        type: string;
        enabled: boolean;
        template: unknown;
        minAmountCents: number;
        durationMs: number;
      };
      return alertConfig(i.type, i);
    });
    fns.alertsTest.mockResolvedValue({ ok: true });
    wrap(React.createElement(component(OverlaysRoute)));
    await waitFor(() => expect(ids("alert-config")).toHaveLength(4));
    const tip = ids("alert-config")[0] as HTMLElement;
    fireEvent.click(within(tip).getByTestId("alert-enabled"));
    fireEvent.change(within(tip).getByTestId("alert-message"), { target: { value: "${user} tipped ${amount}" } });
    fireEvent.change(within(tip).getByTestId("alert-duration"), { target: { value: "5" } });
    fireEvent.click(within(tip).getByTestId("alert-save"));
    await waitFor(() =>
      expect(fns.alertsSet).toHaveBeenCalledWith({
        channel: "rivertide",
        type: "tip",
        enabled: true,
        template: { message: "${user} tipped ${amount}", animation: "fade", showMessage: true },
        minAmountCents: 0,
        durationMs: 5000,
      }),
    );
    await waitFor(() => expect(ids("alert-config")[0]?.getAttribute("data-enabled")).toBe("true"));
    fireEvent.click(within(ids("alert-config")[0] as HTMLElement).getByTestId("alert-test"));
    await waitFor(() => expect(fns.alertsTest).toHaveBeenCalledWith({ channel: "rivertide", type: "tip" }));
  });

  it("creates a never-expiring token by default, shows the URL once, and revoke drops it", async () => {
    fns.alertsList.mockResolvedValue(configs());
    fns.overlayStatus.mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    const alertsUrl = "https://air.example/overlay/alerts?token=one-time-value";
    fns.overlayToken.mockResolvedValue({
      token: "one-time-value",
      alertsUrl,
      goalsUrl: "https://air.example/overlay/goals?token=one-time-value",
      chatUrl: "https://air.example/overlay/chat?token=one-time-value",
      expiresAt: null,
    });
    fns.overlayRevoke.mockResolvedValue({ ok: true });
    wrap(React.createElement(component(OverlaysRoute)));
    await screen.findByTestId("overlay-token");
    expect(screen.getByTestId("overlay-expiry").getAttribute("data-value")).toBe("none");
    fireEvent.click(screen.getByTestId("overlay-token-create"));
    await waitFor(() => expect(fns.overlayToken).toHaveBeenCalledWith({ channel: "rivertide", expiresAt: null }));
    const url = await screen.findByTestId("overlay-url");
    expect(url.getAttribute("data-url")).toBe(alertsUrl);
    expect(attrs(screen.getByTestId("overlay-token"), "data-active", "data-expires-at")).toEqual(["true", ""]);
    fireEvent.click(screen.getByTestId("overlay-token-revoke"));
    fireEvent.click(await waitFor(() => screen.getByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(fns.overlayRevoke).toHaveBeenCalledWith({ channel: "rivertide" }));
    await waitFor(() => expect(screen.queryByTestId("overlay-url")).toBeNull());
    expect(screen.getByTestId("overlay-token").getAttribute("data-active")).toBe("false");
    expect(document.body.innerHTML).not.toContain("one-time-value");
  });

  it("an expiring token's instant reaches data-expires-at", async () => {
    fns.alertsList.mockResolvedValue(configs());
    const expiresAt = iso(NOW + 7 * 24 * HOUR);
    fns.overlayStatus.mockResolvedValue({ active: true, createdAt: iso(NOW - HOUR), expiresAt });
    wrap(React.createElement(component(OverlaysRoute)));
    const panel = await screen.findByTestId("overlay-token");
    await waitFor(() => expect(panel.getAttribute("data-expires-at")).toBe(expiresAt));
    expect(panel.getAttribute("data-active")).toBe("true");
    // Rotating asks first.
    fireEvent.click(screen.getByTestId("overlay-token-create"));
    expect(await waitFor(() => screen.getByTestId("confirm-dialog-confirm"))).toBeTruthy();
    expect(fns.overlayToken).not.toHaveBeenCalled();
  });

  it("failed loads show errors with a retry", async () => {
    fns.alertsList.mockImplementationOnce(() => reject("INTERNAL_SERVER_ERROR")).mockResolvedValue(configs());
    fns.overlayStatus
      .mockImplementationOnce(() => reject("INTERNAL_SERVER_ERROR"))
      .mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    wrap(React.createElement(component(OverlaysRoute)));
    fireEvent.click(within(await screen.findByTestId("alerts-load-error")).getByRole("button"));
    fireEvent.click(within(await screen.findByTestId("overlay-token-load-error")).getByRole("button"));
    await waitFor(() => expect(ids("alert-config")).toHaveLength(4));
    expect(await screen.findByTestId("overlay-token")).toBeTruthy();
  });
});

const vod = (over: Record<string, unknown> = {}) => ({
  id: "0192f000-0000-7000-8000-0000000000b1",
  channelSlug: "rivertide",
  title: "Glaze night",
  status: "ready",
  visibility: "public",
  durationSeconds: 40,
  thumbnailUrl: null,
  playlistUrl: null,
  createdAt: iso(NOW - HOUR),
  expiresAt: null,
  failedReason: null,
  ...over,
});
const clip = (over: Record<string, unknown> = {}) => ({
  id: "0192f000-0000-7000-8000-0000000000c1",
  channelSlug: "rivertide",
  title: "Handle",
  creator: { id: "u2", username: "viewer", displayName: "Viewer" },
  status: "ready",
  durationSeconds: 10,
  url: null,
  thumbnailUrl: null,
  views: 3,
  createdAt: iso(NOW - HOUR),
  ...over,
});

describe("/content", () => {
  it("lists the channel's VODs and clips", async () => {
    fns.vodsList.mockResolvedValue({ items: [vod(), vod({ id: "gone", status: "deleted" })], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [clip()], nextCursor: null });
    wrap(React.createElement(component(ContentRoute)));
    await waitFor(() => expect(ids("vod-row")).toHaveLength(1));
    expect(fns.vodsList).toHaveBeenCalledWith({ channel: "rivertide", cursor: undefined, limit: 100 });
    expect(fns.clipsList).toHaveBeenCalledWith({ channel: "rivertide", cursor: undefined, limit: 100, sort: "recent" });
    expect(attrs(ids("vod-row")[0], "data-vod-id", "data-visibility", "data-status")).toEqual([
      "0192f000-0000-7000-8000-0000000000b1",
      "public",
      "ready",
    ]);
    expect(ids("clip-row")[0]?.getAttribute("data-clip-id")).toBe("0192f000-0000-7000-8000-0000000000c1");
    expect(screen.getByTestId("content-vods")).toBeTruthy();
    expect(screen.getByTestId("content-clips")).toBeTruthy();
  });

  it("empty lists show content-empty", async () => {
    fns.vodsList.mockResolvedValue({ items: [], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [], nextCursor: null });
    wrap(React.createElement(component(ContentRoute)));
    await waitFor(() => expect(ids("content-empty")).toHaveLength(2));
  });

  it("renames a VOD with vods.update", async () => {
    fns.vodsList.mockResolvedValue({ items: [vod()], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [], nextCursor: null });
    fns.vodsUpdate.mockImplementation(async (input) => vod(input as Record<string, unknown>));
    wrap(React.createElement(component(ContentRoute)));
    const row = await screen.findByTestId("vod-row");
    fireEvent.change(within(row).getByTestId("vod-title"), { target: { value: "Renamed" } });
    fireEvent.click(within(row).getByTestId("vod-save"));
    await waitFor(() =>
      expect(fns.vodsUpdate).toHaveBeenCalledWith({
        id: "0192f000-0000-7000-8000-0000000000b1",
        title: "Renamed",
        visibility: "public",
      }),
    );
  });

  it("deleting a VOD removes it and reloads the clips (they went with it)", async () => {
    fns.vodsList.mockResolvedValue({ items: [vod()], nextCursor: null });
    fns.clipsList
      .mockResolvedValueOnce({ items: [clip()], nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    fns.vodsRemove.mockResolvedValue({ ok: true });
    wrap(React.createElement(component(ContentRoute)));
    fireEvent.click(within(await screen.findByTestId("vod-row")).getByTestId("vod-delete"));
    fireEvent.click(await waitFor(() => screen.getByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(fns.vodsRemove).toHaveBeenCalledWith({ id: "0192f000-0000-7000-8000-0000000000b1" }));
    await waitFor(() => expect(ids("vod-row")).toHaveLength(0));
    await waitFor(() => expect(ids("clip-row")).toHaveLength(0));
    expect(fns.clipsList).toHaveBeenCalledTimes(2);
  });

  it("deletes a clip with clips.remove", async () => {
    fns.vodsList.mockResolvedValue({ items: [], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [clip()], nextCursor: null });
    fns.clipsRemove.mockResolvedValue({ ok: true });
    wrap(React.createElement(component(ContentRoute)));
    fireEvent.click(within(await screen.findByTestId("clip-row")).getByTestId("clip-delete"));
    fireEvent.click(await waitFor(() => screen.getByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(fns.clipsRemove).toHaveBeenCalledWith({ id: "0192f000-0000-7000-8000-0000000000c1" }));
    await waitFor(() => expect(ids("clip-row")).toHaveLength(0));
  });

  it("a failed load shows an error with a retry", async () => {
    fns.vodsList
      .mockImplementationOnce(() => reject("INTERNAL_SERVER_ERROR"))
      .mockResolvedValue({ items: [], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [], nextCursor: null });
    wrap(React.createElement(component(ContentRoute)));
    fireEvent.click(within(await screen.findByTestId("content-load-error")).getByRole("button"));
    await waitFor(() => expect(ids("content-empty")).toHaveLength(2));
  });
});

const exportJob = (over: Record<string, unknown> = {}) => ({
  id: "0192f000-0000-7000-8000-0000000000e1",
  kind: "account",
  status: "ready",
  downloadUrl: "https://s3.example/exports/x.zip?X-Amz-Signature=sig",
  sizeBytes: 2048,
  expiresAt: iso(Date.now() + 7 * 24 * HOUR),
  createdAt: iso(Date.now() - 30 * HOUR),
  completedAt: iso(Date.now() - 30 * HOUR),
  ...over,
});

describe("/settings/privacy", () => {
  it("export buttons per kind (channel only for owners) and rows with a download while ready", async () => {
    fns.exportsList.mockResolvedValue([
      exportJob(),
      exportJob({
        id: "q",
        kind: "channel",
        status: "queued",
        downloadUrl: null,
        expiresAt: null,
        createdAt: iso(Date.now() - HOUR),
      }),
    ]);
    fns.deletionGet.mockResolvedValue(null);
    wrap(React.createElement(component(PrivacyRoute)));
    await waitFor(() => expect(ids("export-row")).toHaveLength(2));
    expect(ids("export-request").map((el) => el.getAttribute("data-kind"))).toEqual(["account", "channel"]);
    const [queued, ready] = ids("export-row");
    expect(attrs(ready, "data-kind", "data-status")).toEqual(["account", "ready"]);
    expect(ready?.querySelector('[data-testid="export-download"]')?.getAttribute("href")).toContain("X-Amz-Signature");
    expect(attrs(queued, "data-kind", "data-status")).toEqual(["channel", "queued"]);
    expect(queued?.querySelector('[data-testid="export-download"]')).toBeNull();
    // The queued channel export holds that kind's cooldown.
    expect((ids("export-request")[1] as HTMLButtonElement).disabled).toBe(true);
    expect((ids("export-request")[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("no channel: only the account export", async () => {
    session.me = { ...owner, channelSlug: null };
    fns.exportsList.mockResolvedValue([]);
    fns.deletionGet.mockResolvedValue(null);
    wrap(React.createElement(component(PrivacyRoute)));
    expect(await screen.findByTestId("export-empty")).toBeTruthy();
    expect(ids("export-request").map((el) => el.getAttribute("data-kind"))).toEqual(["account"]);
  });

  it("requests an export with its kind and lists it at once", async () => {
    fns.exportsList.mockResolvedValue([]);
    fns.deletionGet.mockResolvedValue(null);
    fns.exportsCreate.mockResolvedValue(
      exportJob({ status: "queued", downloadUrl: null, expiresAt: null, createdAt: iso(Date.now()) }),
    );
    wrap(React.createElement(component(PrivacyRoute)));
    await screen.findByTestId("export-empty");
    fireEvent.click(ids("export-request")[0] as HTMLElement);
    await waitFor(() => expect(fns.exportsCreate).toHaveBeenCalledWith({ kind: "account" }));
    await waitFor(() => expect(ids("export-row")[0]?.getAttribute("data-status")).toBe("queued"));
    expect((ids("export-request")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("a RATE_LIMITED refusal reloads the list", async () => {
    fns.exportsList.mockResolvedValue([]);
    fns.deletionGet.mockResolvedValue(null);
    fns.exportsCreate.mockImplementation(() => reject("RATE_LIMITED"));
    wrap(React.createElement(component(PrivacyRoute)));
    await screen.findByTestId("export-empty");
    fireEvent.click(ids("export-request")[1] as HTMLElement);
    await waitFor(() => expect(fns.exportsCreate).toHaveBeenCalledWith({ kind: "channel" }));
    await waitFor(() => expect(fns.exportsList).toHaveBeenCalledTimes(2));
  });

  it("deletion: request with the typed username, then the scheduled status and cancel", async () => {
    fns.exportsList.mockResolvedValue([]);
    fns.deletionGet.mockResolvedValue(null);
    const scheduledFor = iso(NOW + 30 * 24 * HOUR);
    fns.deletionRequest.mockResolvedValue({ id: "d", status: "scheduled", scheduledFor, retained: [] });
    fns.deletionCancel.mockResolvedValue({ ok: true });
    wrap(React.createElement(component(PrivacyRoute)));
    fireEvent.click(await screen.findByTestId("deletion-request"));
    const input = await waitFor(() => screen.getByTestId("deletion-confirm-username"));
    // Focusable while disabled, so the state is `aria-disabled`.
    const confirmDisabled = () => screen.getByTestId("confirm-dialog-confirm").getAttribute("aria-disabled") === "true";
    expect(confirmDisabled()).toBe(true);
    fireEvent.change(input, { target: { value: "rivertide" } });
    await waitFor(() => expect(confirmDisabled()).toBe(false));
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(fns.deletionRequest).toHaveBeenCalledWith({ confirmUsername: "rivertide" }));
    const status = await screen.findByTestId("deletion-status");
    expect(attrs(status, "data-status", "data-scheduled-for")).toEqual(["scheduled", scheduledFor]);
    expect(screen.queryByTestId("deletion-request")).toBeNull();
    fireEvent.click(within(status).getByTestId("deletion-cancel"));
    await waitFor(() => expect(fns.deletionCancel).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("deletion-status").getAttribute("data-status")).toBe("canceled"));
    expect(screen.getByTestId("deletion-request")).toBeTruthy();
  });

  it("an existing scheduled deletion shows its status", async () => {
    fns.exportsList.mockResolvedValue([]);
    const scheduledFor = iso(NOW + 29 * 24 * HOUR);
    fns.deletionGet.mockResolvedValue({ id: "d", status: "scheduled", scheduledFor, retained: [] });
    wrap(React.createElement(component(PrivacyRoute)));
    const status = await screen.findByTestId("deletion-status");
    expect(attrs(status, "data-status", "data-scheduled-for")).toEqual(["scheduled", scheduledFor]);
    expect(within(status).getByTestId("deletion-cancel")).toBeTruthy();
  });

  it("failed loads show errors with a retry", async () => {
    fns.exportsList.mockImplementationOnce(() => reject("INTERNAL_SERVER_ERROR")).mockResolvedValue([]);
    fns.deletionGet.mockImplementationOnce(() => reject("INTERNAL_SERVER_ERROR")).mockResolvedValue(null);
    wrap(React.createElement(component(PrivacyRoute)));
    fireEvent.click(within(await screen.findByTestId("export-load-error")).getByRole("button"));
    fireEvent.click(within(await screen.findByTestId("deletion-load-error")).getByRole("button"));
    expect(await screen.findByTestId("export-empty")).toBeTruthy();
    expect(await screen.findByTestId("deletion-request")).toBeTruthy();
  });
});

type Listener = (event: { data?: unknown }) => void;
class FakeEventSource implements EventSourceLike {
  closed = false;
  readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("/overlay/alerts", () => {
  const frame = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "0192f000-0000-7000-8000-0000000000f1",
      type: "tip",
      text: "Viewer tipped $2.50",
      message: null,
      amountCents: 250,
      currency: "usd",
      durationMs: 5000,
      animation: "fade",
      test: false,
      occurredAt: "2026-10-22T12:00:00.000Z",
      ...over,
    });

  function overlay(loadState: () => Promise<{ eventsUrl: string }>) {
    const sources: FakeEventSource[] = [];
    const tokens: string[] = [];
    const deps = (token: string): OverlayConnectionDeps => {
      tokens.push(token);
      return {
        loadState,
        openEvents: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        random: () => 0,
      };
    };
    const view = wrap(<OverlayAlertsPage deps={deps} />);
    return { sources, tokens, view };
  }

  const root = () => screen.getByTestId("overlay-alerts");

  it("connecting, then live; alerts show with their data attributes", async () => {
    window.history.replaceState(null, "", "/overlay/alerts?token=tok-1");
    const { sources, tokens } = overlay(async () => ({ eventsUrl: "https://api.example/overlay/events?token=tok-1" }));
    expect(root().getAttribute("data-state")).toBe("connecting");
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(tokens).toEqual(["tok-1"]);
    expect(sources[0]?.url).toBe("https://api.example/overlay/events?token=tok-1");
    act(() => sources[0]?.emit("open"));
    expect(root().getAttribute("data-state")).toBe("live");
    act(() => sources[0]?.emit("alert", frame()));
    const alert = await screen.findByTestId("overlay-alert");
    expect(attrs(alert, "data-alert-id", "data-type", "data-test", "data-amount-cents")).toEqual([
      "0192f000-0000-7000-8000-0000000000f1",
      "tip",
      "false",
      "250",
    ]);
    expect(screen.getByTestId("overlay-alert-text").textContent).toBe("Viewer tipped $2.50");
    // The same id again is not shown twice.
    act(() => sources[0]?.emit("alert", frame()));
    expect(ids("overlay-alert")).toHaveLength(1);
  });

  it("revoked: refused and nothing visible", async () => {
    window.history.replaceState(null, "", "/overlay/alerts?token=tok-2");
    const { sources } = overlay(async () => ({ eventsUrl: "https://api.example/overlay/events?token=tok-2" }));
    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]?.emit("open");
      sources[0]?.emit("alert", frame({ test: true, amountCents: null }));
    });
    expect(screen.getByTestId("overlay-alert").getAttribute("data-test")).toBe("true");
    act(() => sources[0]?.emit("revoked", "{}"));
    expect(root().getAttribute("data-state")).toBe("refused");
    expect(ids("overlay-alert")).toHaveLength(0);
    expect(sources[0]?.closed).toBe(true);
  });

  it("a 401 from the state call: refused, no stream", async () => {
    window.history.replaceState(null, "", "/overlay/alerts?token=bad");
    const { sources } = overlay(() => reject("UNAUTHORIZED") as Promise<{ eventsUrl: string }>);
    await waitFor(() => expect(root().getAttribute("data-state")).toBe("refused"));
    expect(sources).toHaveLength(0);
  });

  it("no token: refused without calling anything", async () => {
    window.history.replaceState(null, "", "/overlay/alerts");
    const { tokens } = overlay(async () => ({ eventsUrl: "x" }));
    await waitFor(() => expect(root().getAttribute("data-state")).toBe("refused"));
    expect(tokens).toEqual([]);
  });
});
