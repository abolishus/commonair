// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-content (README D5.4, D5.5): the content library's cards (pure model and the page), the
 * overlays page's three links and one save bar, and counting a play only once playback starts.
 */
import { LocaleProvider, NowProvider, TooltipProvider } from "@commonair/ui";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { SessionUser } from "../src/lib/bootstrap-types.ts";
import type { ClipDto, VodDto } from "../src/lib/content.ts";

const session = vi.hoisted(() => ({ me: null as SessionUser | null }));
const fns = vi.hoisted(() => ({
  alertsList: vi.fn<(input: unknown) => Promise<unknown>>(),
  alertsSet: vi.fn<(input: unknown) => Promise<unknown>>(),
  alertsTest: vi.fn<(input: unknown) => Promise<unknown>>(),
  overlayToken: vi.fn<(input: unknown) => Promise<unknown>>(),
  overlayStatus: vi.fn<(input: unknown) => Promise<unknown>>(),
  overlayRevoke: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsList: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsUpdate: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsRemove: vi.fn<(input: unknown) => Promise<unknown>>(),
  vodsRecordView: vi.fn<(input: unknown) => Promise<unknown>>(),
  clipsList: vi.fn<(input: unknown) => Promise<unknown>>(),
  clipsRemove: vi.fn<(input: unknown) => Promise<unknown>>(),
  clipsRecordView: vi.fn<(input: unknown) => Promise<unknown>>(),
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
      recordView: (i: unknown) => fns.vodsRecordView(i),
    },
    clips: {
      list: (i: unknown) => fns.clipsList(i),
      remove: (i: unknown) => fns.clipsRemove(i),
      recordView: (i: unknown) => fns.clipsRecordView(i),
    },
  };
  return { ...actual, api: () => client };
});

const { Route: OverlaysRoute } = await import("../src/routes/_studio/overlays.tsx");
const { Route: ContentRoute } = await import("../src/routes/_studio/content.tsx");
const { clipCards, clipCounts, vodCards, watchPath } = await import("../src/components/content-library/model.ts");
const { alertDraftProblems, dirtyAlertTypes, sameAlertDraft } =
  await import("../src/components/content-library/alert-drafts.ts");
const { recordViewApi, useRecordView } = await import("../src/components/vod-watch/record-view.ts");

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
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

beforeAll(async () => {
  for (const route of [OverlaysRoute, ContentRoute]) {
    const c = route.options.component as { preload?: () => Promise<void> } | undefined;
    await c?.preload?.();
  }
});
beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
  session.me = owner;
});
afterEach(cleanup);

const VOD = "0192f000-0000-7000-8000-0000000000b1";
const vod = (over: Partial<VodDto> = {}): VodDto => ({
  id: VOD,
  channelSlug: "rivertide",
  title: "Glaze night",
  status: "ready",
  visibility: "public",
  durationSeconds: 3725,
  views: 1234,
  thumbnailUrl: "https://air.example/media/vods/x/thumbnail.webp",
  playlistUrl: null,
  createdAt: iso(NOW - HOUR),
  expiresAt: null,
  failedReason: null,
  captions: [],
  category: null,
  ...over,
});
const clip = (over: Partial<ClipDto> = {}): ClipDto => ({
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
  windowStartedAt: null,
  vodId: VOD,
  vodOffsetSeconds: 12,
  category: null,
  ...over,
});

describe("content model", () => {
  it("counts clips per source video, removed ones left out", () => {
    const counts = clipCounts([
      clip(),
      clip({ id: "c2" }),
      clip({ id: "c3", status: "deleted" }),
      clip({ id: "c4", vodId: null }),
      clip({ id: "c5", vodId: "other" }),
    ]);
    expect([...counts]).toEqual([
      [VOD, 2],
      ["other", 1],
    ]);
  });

  it("video cards: views, clip count, visibility, a link only once ready, removed ones left out", () => {
    const cards = vodCards(
      [vod(), vod({ id: "p", status: "processing", views: 0 }), vod({ id: "gone", status: "deleted" })],
      [clip()],
      "en",
    );
    expect(cards.map((c) => c.id)).toEqual([VOD, "p"]);
    const [ready, processing] = cards;
    expect(ready).toMatchObject({
      views: 1234,
      viewsLabel: "1.2K views",
      clips: 1,
      clipsLabel: "1 clip",
      visibilityLabel: t("content.visibility.public"),
      href: `/rivertide/vods/${VOD}`,
      thumbnailUrl: "https://air.example/media/vods/x/thumbnail.webp",
      statusLabel: t("content.status.ready"),
    });
    expect(processing).toMatchObject({ href: null, clips: 0, clipsLabel: "No clips", viewsLabel: "0 views" });
    // Before the clip list loads, no clip count is claimed.
    expect(vodCards([vod()], null, "en")[0]?.clipsLabel).toBeUndefined();
  });

  it("clip cards: the clipper, views and the clip page", () => {
    const [card] = clipCards([clip(), clip({ id: "gone", status: "deleted" })], "en");
    expect(card).toMatchObject({ creatorName: "Viewer", viewsLabel: "3 views", href: `/rivertide/clips/${clip().id}` });
    expect(clipCards([clip({ status: "processing", creator: null })], "en")[0]).toMatchObject({
      href: null,
      creatorName: null,
    });
  });

  it("watch paths encode the slug and id", () => {
    expect(watchPath("vod", "a b", "x/y")).toBe("/a%20b/vods/x%2Fy");
    expect(watchPath("clip", "rivertide", "c1")).toBe("/rivertide/clips/c1");
  });
});

describe("alert drafts", () => {
  const draft = {
    enabled: true,
    message: "${user} tipped",
    showMessage: true,
    minAmountCents: 0,
    durationMs: 5000,
    animation: "fade" as const,
  };

  it("finds the changed types, in order", () => {
    expect(sameAlertDraft(draft, { ...draft })).toBe(true);
    expect(
      dirtyAlertTypes([
        { type: "tip", saved: draft, draft },
        { type: "follow", saved: draft, draft: { ...draft, enabled: false } },
        { type: "raid", saved: draft, draft: { ...draft, animation: "none" } },
      ]),
    ).toEqual(["follow", "raid"]);
    expect(dirtyAlertTypes([])).toEqual([]);
  });

  it("blocks a blank or long message, a duration outside 1-30 s, an unreadable or negative amount", () => {
    expect(alertDraftProblems(draft, "5").any).toBe(false);
    expect(alertDraftProblems({ ...draft, message: "  " }, "5").message).toBe(true);
    expect(alertDraftProblems({ ...draft, message: "x".repeat(201) }, "5").message).toBe(true);
    expect(alertDraftProblems({ ...draft, message: "x".repeat(200) }, "5").message).toBe(false);
    for (const bad of ["", "0.5", "31", "abc"]) expect(alertDraftProblems(draft, bad).duration, bad).toBe(true);
    for (const ok of ["1", "30", "2.5"]) expect(alertDraftProblems(draft, ok).duration, ok).toBe(false);
    expect(alertDraftProblems(draft, "5", true).amount).toBe(true);
    expect(alertDraftProblems({ ...draft, minAmountCents: -1 }, "5").any).toBe(true);
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
const configs = () => ["tip", "follow", "subscription", "raid"].map((type) => alertConfig(type));
const configOf = (type: string) =>
  screen.getAllByTestId("alert-config").find((el) => el.getAttribute("data-type") === type) as HTMLElement;

describe("/overlays", () => {
  it("one save bar saves every changed alert, and discard puts the saved ones back", async () => {
    fns.alertsList.mockResolvedValue(configs());
    fns.overlayStatus.mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    fns.alertsSet.mockImplementation(async (input) => {
      const i = input as { type: string; enabled: boolean };
      return alertConfig(i.type, { enabled: i.enabled });
    });
    wrap(React.createElement(component(OverlaysRoute)));
    await waitFor(() => expect(screen.getAllByTestId("alert-config")).toHaveLength(4));
    // One tab per type; no stale raid note.
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "alert-tab-tip",
      "alert-tab-follow",
      "alert-tab-subscription",
      "alert-tab-raid",
    ]);
    expect(document.body.textContent).not.toContain("once raids are available");
    expect(screen.getAllByTestId("alert-save")).toHaveLength(1);
    const bar = screen.getByTestId("alert-save-bar");
    expect((screen.getByTestId("alert-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(configOf("tip")).getByTestId("alert-enabled"));
    fireEvent.click(within(configOf("raid")).getByTestId("alert-enabled"));
    expect(bar.getAttribute("data-dirty")).toBe("2");
    expect(bar.textContent).toContain("2 alerts have unsaved changes");
    expect(configOf("tip").getAttribute("data-dirty")).toBe("true");

    // Discard: back to what was saved.
    fireEvent.click(screen.getByTestId("alert-discard"));
    expect(bar.getAttribute("data-dirty")).toBe("0");

    fireEvent.click(within(configOf("follow")).getByTestId("alert-enabled"));
    fireEvent.click(within(configOf("raid")).getByTestId("alert-enabled"));
    fireEvent.click(screen.getByTestId("alert-save"));
    await waitFor(() => expect(fns.alertsSet).toHaveBeenCalledTimes(2));
    expect(fns.alertsSet.mock.calls.map(([i]) => (i as { type: string }).type).sort()).toEqual(["follow", "raid"]);
    await waitFor(() => expect(bar.getAttribute("data-dirty")).toBe("0"));
    expect(configOf("raid").getAttribute("data-enabled")).toBe("true");
    expect(configOf("tip").getAttribute("data-enabled")).toBe("false");
  });

  it("an invalid draft keeps the bar from saving", async () => {
    fns.alertsList.mockResolvedValue(configs());
    fns.overlayStatus.mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    wrap(React.createElement(component(OverlaysRoute)));
    await waitFor(() => expect(screen.getAllByTestId("alert-config")).toHaveLength(4));
    fireEvent.change(within(configOf("tip")).getByTestId("alert-duration"), { target: { value: "45" } });
    expect((screen.getByTestId("alert-save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("alert-save-bar").textContent).toContain(t("d5Content.alerts.invalid"));
    expect(within(configOf("tip")).getByTestId("alert-duration").getAttribute("data-ms")).toBe("");
  });

  it("creating links shows all three, with OBS sizes; revoke drops them", async () => {
    fns.alertsList.mockResolvedValue(configs());
    fns.overlayStatus.mockResolvedValue({ active: false, createdAt: null, expiresAt: null });
    const url = (kind: string) => `https://air.example/overlay/${kind}?token=one-time-value`;
    fns.overlayToken.mockResolvedValue({
      token: "one-time-value",
      alertsUrl: url("alerts"),
      chatUrl: url("chat"),
      goalsUrl: url("goals"),
      expiresAt: null,
    });
    fns.overlayRevoke.mockResolvedValue({ ok: true });
    wrap(React.createElement(component(OverlaysRoute)));
    // Before any link: the sizes, so OBS can be set up.
    expect((await screen.findByTestId("overlay-sizes")).textContent).toContain("400 × 800 px");
    fireEvent.click(screen.getByTestId("overlay-token-create"));
    await waitFor(() => expect(screen.getByTestId("overlay-url-goals")).toBeTruthy());
    expect(
      ["overlay-url", "overlay-url-chat", "overlay-url-goals"].map((id) => {
        const el = screen.getByTestId(id);
        return [el.getAttribute("data-url"), el.getAttribute("data-width"), el.getAttribute("data-height")];
      }),
    ).toEqual([
      [url("alerts"), "800", "600"],
      [url("chat"), "400", "800"],
      [url("goals"), "800", "120"],
    ]);
    fireEvent.click(screen.getByTestId("overlay-token-revoke"));
    fireEvent.click(await waitFor(() => screen.getByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(screen.queryByTestId("overlay-url-chat")).toBeNull());
    expect(document.body.innerHTML).not.toContain("one-time-value");
  });
});

describe("/content", () => {
  it("cards with thumbnails, views and clip counts; copy link writes the public watch URL", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fns.vodsList.mockResolvedValue({ items: [vod()], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [clip(), clip({ id: "c2" })], nextCursor: null });
    wrap(React.createElement(component(ContentRoute)));
    const row = await screen.findByTestId("vod-row");
    await waitFor(() => expect(row.textContent).toContain("2 clips"));
    expect(row.textContent).toContain("1.2K views");
    expect(row.textContent).toContain("1:02:05");
    expect(row.querySelector("img")?.getAttribute("src")).toBe("https://air.example/media/vods/x/thumbnail.webp");
    fireEvent.click(within(row).getByTestId("vod-copy-link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://air.example/rivertide/vods/${VOD}`));
  });

  it("the empty library says how videos get here", async () => {
    fns.vodsList.mockResolvedValue({ items: [], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [], nextCursor: null });
    wrap(React.createElement(component(ContentRoute)));
    await waitFor(() => expect(screen.getAllByTestId("content-empty")).toHaveLength(2));
    expect(screen.getAllByTestId("content-empty")[0]?.textContent).toContain(t("d5Content.vodsEmptyBody"));
  });

  it("saving in the sheet updates the card and closes the sheet", async () => {
    fns.vodsList.mockResolvedValue({ items: [vod()], nextCursor: null });
    fns.clipsList.mockResolvedValue({ items: [], nextCursor: null });
    fns.vodsUpdate.mockImplementation(async (input) => vod(input as Partial<VodDto>));
    wrap(React.createElement(component(ContentRoute)));
    fireEvent.click(within(await screen.findByTestId("vod-row")).getByTestId("vod-edit"));
    const sheet = await screen.findByTestId("vod-edit-sheet");
    fireEvent.change(within(sheet).getByTestId("vod-title"), { target: { value: "Renamed" } });
    fireEvent.click(within(sheet).getByTestId("vod-save"));
    await waitFor(() => expect(screen.getByTestId("vod-row").textContent).toContain("Renamed"));
    await waitFor(() => expect(screen.queryByTestId("vod-edit-sheet")).toBeNull());
  });
});

describe("counting a play", () => {
  it("records once per id, on the first call, and survives a failure", async () => {
    const record = vi.fn<(kind: "vod" | "clip", id: string) => Promise<unknown>>(async () => {
      throw new Error("offline");
    });
    const { result, rerender } = renderHook(({ id }) => useRecordView(record, "vod", id), {
      initialProps: { id: "a" },
    });
    expect(record).not.toHaveBeenCalled();
    await act(async () => {
      result.current();
      result.current();
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("vod", "a");
    rerender({ id: "b" });
    await act(async () => {
      result.current();
    });
    expect(record).toHaveBeenLastCalledWith("vod", "b");
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("the API call names the kind's procedure", async () => {
    fns.vodsRecordView.mockResolvedValue({ ok: true });
    fns.clipsRecordView.mockResolvedValue({ ok: true });
    await recordViewApi("vod", "v1");
    await recordViewApi("clip", "c1");
    expect(fns.vodsRecordView).toHaveBeenCalledWith({ id: "v1" });
    expect(fns.clipsRecordView).toHaveBeenCalledWith({ id: "c1" });
  });
});
