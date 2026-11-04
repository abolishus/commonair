// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-studio F23: the mod view (`/mod/$channel`). The gate is the server's answer: a refusal of the
 * held queue (not a moderator, or no such channel) renders the not-found page and nothing of the
 * channel; anything else that fails offers a retry. A moderator gets chat, the held queue inline
 * (allow and deny, put back on failure) and the recent mod actions.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatMessageFrame } from "../src/chat/connection.ts";
import type { HeldClient } from "../src/components/mod/held-queue.tsx";
import {
  ModView,
  deniesAccess,
  modActionLine,
  type ModActionDto,
  type ModViewClient,
} from "../src/components/mod/mod-view.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

const coded = (code: string) => Object.assign(new Error(code), { code });

const held = (id: string, body: string): ChatMessageFrame =>
  ({
    id,
    body,
    createdAt: `2026-11-04T10:00:0${id.slice(-1)}.000Z`,
    isAction: false,
    user: { id: `u-${id}`, username: `user${id}`, displayName: `User ${id}` },
  }) as unknown as ChatMessageFrame;

const action: ModActionDto = {
  id: "01900000-0000-7000-8000-0000000000a1",
  scope: "channel",
  channelSlug: "aurora",
  moderator: { id: "01900000-0000-7000-8000-000000000001", username: "aurora_mod" },
  target: { id: "01900000-0000-7000-8000-000000000002", username: "spammer" },
  action: "timeout",
  reason: "links",
  durationSeconds: 600,
  createdAt: "2026-11-04T10:00:00.000Z",
};

function client(
  over: { list?: () => Promise<ChatMessageFrame[]>; resolve?: () => Promise<void>; log?: ModActionDto[] } = {},
) {
  return {
    held: {
      list: vi.fn<HeldClient["list"]>(
        over.list ?? (async () => [held("m1", "buy followers"), held("m2", "spam link")]),
      ),
      resolve: vi.fn<HeldClient["resolve"]>(over.resolve ?? (async () => undefined)),
    },
    modLog: vi.fn<ModViewClient["modLog"]>(async () => over.log ?? [action]),
  } satisfies ModViewClient;
}

const view = (c: ModViewClient) => (
  <ModView
    channel="aurora"
    client={c}
    refreshMs={0}
    header={<h1 data-testid="mod-header">Mod view</h1>}
    chat={<div data-testid="fake-chat" />}
  />
);

describe("the gate", () => {
  it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"])(
    "a %s answer is the not-found page, with no channel tools",
    async (code) => {
      const c = client({ list: async () => Promise.reject(coded(code)) });
      wrap(view(c));
      await waitFor(() => expect(screen.getByTestId("mod-view-denied")).toBeTruthy());
      expect(screen.queryByTestId("mod-view")).toBeNull();
      expect(screen.queryByTestId("fake-chat")).toBeNull();
      expect(screen.queryByTestId("mod-header")).toBeNull();
      expect(c.modLog).not.toHaveBeenCalled();
      expect(screen.getByTestId("empty-state-action")).toBeTruthy();
    },
  );

  it("shows nothing of the channel while the server is asked", () => {
    wrap(view(client({ list: () => new Promise(() => undefined) })));
    expect(screen.getByTestId("mod-view-checking").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("fake-chat")).toBeNull();
  });

  it("any other failure offers a retry, which asks again", async () => {
    let calls = 0;
    const c = client({
      list: async () => {
        calls++;
        if (calls === 1) throw coded("INTERNAL_SERVER_ERROR");
        return [];
      },
    });
    wrap(view(c));
    fireEvent.click(await screen.findByTestId("empty-state-action"));
    await waitFor(() => expect(screen.getByTestId("mod-view")).toBeTruthy());
    expect(deniesAccess(coded("INTERNAL_SERVER_ERROR"))).toBe(false);
    expect(deniesAccess(coded("FORBIDDEN"))).toBe(true);
  });

  it("the route guards the session and leaves the decision to ModView", () => {
    const route = readFileSync(join(import.meta.dirname, "../src/routes/_studio/mod.$channel.tsx"), "utf8");
    expect(route).toContain("requireSession");
    expect(route).toContain("<ModView");
    expect(route).toContain("<ChatPanel");
  });
});

describe("a moderator's view", () => {
  it("has the header, chat, the held queue and the recent mod actions", async () => {
    wrap(view(client()));
    await waitFor(() => expect(screen.getByTestId("mod-view")).toBeTruthy());
    expect(screen.getByTestId("mod-header")).toBeTruthy();
    expect(screen.getByTestId("fake-chat")).toBeTruthy();
    expect(screen.getByTestId("mod-held-panel").getAttribute("data-count")).toBe("2");
    expect(screen.getAllByTestId("held-message").map((m) => m.getAttribute("data-id"))).toEqual(["m1", "m2"]);
    const entry = await screen.findByTestId("mod-log-entry");
    expect(entry.getAttribute("data-action")).toBe("timeout");
    expect(entry.textContent).toContain("Timeout");
    expect(entry.textContent).toContain("aurora_mod on spammer");
    expect(entry.textContent).toContain("links");
  });

  it("allowing a held message removes it and tells the server", async () => {
    const c = client();
    wrap(view(c));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("held-allow")[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(1));
    expect(c.held.resolve).toHaveBeenCalledWith("aurora", "m1", true);
  });

  it("a deny that fails puts the message back", async () => {
    let fail: (e: unknown) => void = () => undefined;
    const c = client({
      resolve: () =>
        new Promise<void>((_r, j) => {
          fail = j;
        }),
    });
    wrap(view(c));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("held-deny")[1] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(1));
    await act(async () => fail(coded("INTERNAL_SERVER_ERROR")));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(2));
    expect(c.held.resolve).toHaveBeenCalledWith("aurora", "m2", false);
  });

  it("refresh picks up newly held messages", async () => {
    const c = client();
    wrap(view(c));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(2));
    c.held.list.mockResolvedValueOnce([held("m1", "a"), held("m2", "b"), held("m3", "c")]);
    fireEvent.click(screen.getByTestId("mod-held-refresh"));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(3));
  });

  it("empty queue and empty log say so", async () => {
    wrap(view(client({ list: async () => [], log: [] })));
    await waitFor(() => expect(screen.getByTestId("held-queue-empty")).toBeTruthy());
    expect(await screen.findByTestId("mod-log-empty")).toBeTruthy();
  });

  it("names every mod action the API can return", () => {
    for (const a of ["ban", "unban", "clear_chat", "emote_only", "add_vip", "end_stream", "warn"] as const)
      expect(t("studio.mod.action", { action: a })).not.toBe("Mod action");
  });
});

describe("review follow-ups", () => {
  const framed = (c: ModViewClient) => (
    <ModView
      channel="aurora"
      client={c}
      refreshMs={0}
      frame={(children) => <div data-testid="route-frame">{children}</div>}
      header={<h1 data-testid="mod-header">Mod view</h1>}
      chat={<div data-testid="fake-chat" />}
    />
  );

  it("renders the denied state outside the route's container, every other state inside it", async () => {
    wrap(framed(client({ list: async () => Promise.reject(coded("FORBIDDEN")) })));
    await waitFor(() => expect(screen.getByTestId("mod-view-denied")).toBeTruthy());
    expect(screen.queryByTestId("route-frame")).toBeNull();
    cleanup();
    wrap(framed(client()));
    await waitFor(() => expect(screen.getByTestId("mod-view")).toBeTruthy());
    expect(screen.getByTestId("route-frame").contains(screen.getByTestId("mod-view"))).toBe(true);
  });

  it("names an action without a moderator as automatic, never an empty name", () => {
    expect(modActionLine(action)).toBe("aurora_mod on spammer");
    expect(modActionLine({ ...action, target: null })).toBe("By aurora_mod");
    expect(modActionLine({ ...action, moderator: null })).toBe("Automatic, on spammer");
    expect(modActionLine({ moderator: null, target: null })).toBe("Automatic action");
  });

  it("announces the held count, not the replaced list", async () => {
    wrap(view(client()));
    await waitFor(() => expect(screen.getByTestId("mod-held-panel")).toBeTruthy());
    // An <output>: an implicit polite status region.
    expect(screen.getByTestId("mod-held-status").tagName).toBe("OUTPUT");
    expect(screen.getByTestId("mod-held-status").textContent).toBe("2 held messages");
    expect(screen.getByTestId("mod-held-panel").querySelector("[aria-live]")).toBeNull();
  });
});
