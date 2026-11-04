// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D3-watch (F11, F15): the VOD and clip routes' document titles come from loader data,
 * "<title> · <channel> · <site>", in the visitor's language. A missing or private item reads
 * "Video not available"; a failed lookup falls back to "Video · <slug>". Plus the not-available
 * page (D4's `NotFoundState`) with "Back to <channel>".
 */
import { SITE } from "@commonair/config/site";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WatchHead } from "../src/components/vod-watch/watch-head.ts";
import { ClipWatchPage, VodWatchPage, type WatchClient } from "../src/components/vod-watch/watch-page.tsx";
import { loadLocale, locale, setClientTranslator, t, uiMessages } from "../src/i18n/index.ts";
import { TITLE_SEPARATOR } from "../src/lib/page-title.ts";

vi.mock("../src/lib/bootstrap.ts", () => ({
  getBootstrap: async () => null,
  getSessionUser: async () => null,
  useBootstrap: () => ({ me: null, instance: { name: "Test Air" }, config: { publicUrl: "https://a.example" } }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

const { Route: VodRoute } = await import("../src/routes/_app/$channel_.vods.$vodId.tsx");
const { Route: ClipRoute } = await import("../src/routes/_app/$channel_.clips.$clipId.tsx");

afterEach(async () => {
  cleanup();
  setClientTranslator(await loadLocale("en"));
});

type Head = (ctx: unknown) => { meta?: { title?: string }[] };
const titleOf = (route: { options: object }, loaderData: WatchHead | undefined, channel = "rivertide") =>
  ((route.options as { head?: Head }).head?.({ loaderData, params: { channel } }).meta ?? []).find(
    (m) => m.title !== undefined,
  )?.title;
const T = (...parts: string[]) => [...parts, SITE.name].join(TITLE_SEPARATOR);

describe("watch route titles", () => {
  it("a VOD: <title> · <channel> · <site>", () => {
    expect(titleOf(VodRoute, { kind: "ok", title: "Tuesday build stream", channelName: "Rivertide" })).toBe(
      T("Tuesday build stream", "Rivertide"),
    );
    expect(TITLE_SEPARATOR).toBe(" · ");
  });

  it("a clip: <title> · <channel> · <site>", () => {
    expect(titleOf(ClipRoute, { kind: "ok", title: "The jump", channelName: "Rivertide" })).toBe(
      T("The jump", "Rivertide"),
    );
  });

  it("an untitled item says so", () => {
    expect(titleOf(VodRoute, { kind: "ok", title: "  ", channelName: "Rivertide" })).toBe(
      T(t("channel.tabs.untitledVideo"), "Rivertide"),
    );
    expect(titleOf(ClipRoute, { kind: "ok", title: "", channelName: "Rivertide" })).toBe(
      T(t("channel.tabs.untitledClip"), "Rivertide"),
    );
  });

  it("missing or private: not available, and never the title", () => {
    expect(titleOf(VodRoute, { kind: "missing" })).toBe(T("Video not available"));
    expect(titleOf(ClipRoute, { kind: "missing" })).toBe(T("Video not available"));
  });

  it("a failed lookup or no loader data yet: the kind and the slug", () => {
    expect(titleOf(VodRoute, { kind: "error" })).toBe(T("Video", "rivertide"));
    expect(titleOf(ClipRoute, undefined)).toBe(T("Clip", "rivertide"));
  });

  it("follows the language", async () => {
    setClientTranslator(await loadLocale("es"));
    expect(titleOf(VodRoute, { kind: "missing" })).toBe(T("Vídeo no disponible"));
    expect(titleOf(ClipRoute, { kind: "error" })).toBe(T("Clip", "rivertide"));
  });

  it("both routes have a loader and a head (PENDING_HEAD no longer lists them)", () => {
    for (const route of [VodRoute, ClipRoute]) {
      const options = route.options as { loader?: unknown; head?: unknown };
      expect(typeof options.loader).toBe("function");
      expect(typeof options.head).toBe("function");
    }
  });

  it("the VOD route keeps only a valid ?t=", () => {
    const validate = (VodRoute.options as { validateSearch?: (s: Record<string, unknown>) => unknown }).validateSearch;
    expect(validate?.({ t: "1m30s" })).toEqual({ t: 90 });
    expect(validate?.({ t: "soon" })).toEqual({});
  });
});

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);
const notFound = () => Object.assign(new Error("not found"), { code: "NOT_FOUND" });

const client = (channel: WatchClient["channel"]): WatchClient => ({
  vod: () => Promise.reject(notFound()),
  clip: () => Promise.reject(notFound()),
  channel,
  vodChat: async () => ({ items: [], nextCursor: null, retained: true }),
  clipChat: async () => ({ items: [], nextCursor: null, retained: true }),
});

describe("not available", () => {
  it("a missing VOD: NotFoundState with Back to <channel>", async () => {
    const { container } = wrap(
      <VodWatchPage
        channel="rivertide"
        vodId="01900000-0000-7000-8000-0000000000d1"
        viewer={null}
        client={client(async () => ({ displayName: "Rivertide", avatarUrl: null, accent: null }))}
      />,
    );
    await waitFor(() => expect(byId(container, "watch-not-found")).not.toBeNull());
    expect(container.textContent).toContain(t("replay.watch.notFound"));
    await waitFor(() =>
      expect(byId(container, "empty-state-action")?.textContent).toBe(
        t("watch.notAvailable.back", { name: "Rivertide" }),
      ),
    );
    expect(byId(container, "empty-state-action")?.getAttribute("href")).toBe("/rivertide");
  });

  it("a missing clip reads the same", async () => {
    const { container } = wrap(
      <ClipWatchPage
        channel="rivertide"
        clipId="01900000-0000-7000-8000-0000000000c1"
        viewer={null}
        client={client(async () => ({ displayName: "Rivertide", avatarUrl: null, accent: null }))}
      />,
    );
    await waitFor(() => expect(byId(container, "empty-state-action")?.getAttribute("href")).toBe("/rivertide"));
  });

  it("the channel failed to load: Back to the slug", async () => {
    const { container } = wrap(
      <VodWatchPage
        channel="rivertide"
        vodId="01900000-0000-7000-8000-0000000000d1"
        viewer={null}
        client={client(() => Promise.reject(new Error("network")))}
      />,
    );
    await waitFor(() =>
      expect(byId(container, "empty-state-action")?.textContent).toBe(
        t("watch.notAvailable.back", { name: "rivertide" }),
      ),
    );
  });

  it("the channel does not exist either: Browse live channels instead", async () => {
    const { container } = wrap(
      <VodWatchPage
        channel="nobody"
        vodId="01900000-0000-7000-8000-0000000000d1"
        viewer={null}
        client={client(() => Promise.reject(notFound()))}
      />,
    );
    await waitFor(() => expect(byId(container, "empty-state-action")?.textContent).toBe(t("polish.browseLive")));
  });
});
