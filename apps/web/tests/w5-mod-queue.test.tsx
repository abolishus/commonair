// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * w5-studio: the mod view's held queue on `QueueLayout` (as the staff queues are, D7.5). Review
 * opens a message beside the list (alone below lg, with Back), the detail allows or denies it, a
 * resolved message closes on its own, j/k move between rows and e reaches the decision, and the
 * rows still allow and deny in place.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatMessageFrame } from "../src/chat/connection.ts";
import type { HeldClient } from "../src/components/mod/held-queue.tsx";
import { ModView, heldShortcuts, type ModViewClient } from "../src/components/mod/mod-view.tsx";
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

const held = (id: string, body: string): ChatMessageFrame =>
  ({
    id,
    body,
    createdAt: `2026-11-04T10:00:0${id.slice(-1)}.000Z`,
    isAction: false,
    user: { id: `u-${id}`, username: `user${id}`, displayName: `User ${id}` },
  }) as unknown as ChatMessageFrame;

function client(list: ChatMessageFrame[] = [held("m1", "buy followers"), held("m2", "spam link")]) {
  return {
    held: {
      list: vi.fn<HeldClient["list"]>(async () => list),
      resolve: vi.fn<HeldClient["resolve"]>(async () => undefined),
    },
    modLog: vi.fn<ModViewClient["modLog"]>(async () => []),
  } satisfies ModViewClient;
}

const view = (c: ModViewClient) => (
  <ModView
    channel="aurora"
    client={c}
    refreshMs={0}
    header={<h1>Mod view</h1>}
    chat={<div data-testid="fake-chat" />}
  />
);

const queue = () => screen.getByTestId("mod-held-queue");
const opens = () => screen.getAllByTestId("mod-held-open");

describe("the held queue on QueueLayout", () => {
  it("lists the held messages with nothing open, the pick hint in the detail pane", async () => {
    wrap(view(client()));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(2));
    expect(queue().getAttribute("data-slot")).toBe("queue-layout");
    expect(queue().getAttribute("data-open")).toBe("false");
    expect(screen.queryByTestId("mod-held-detail")).toBeNull();
    expect(queue().querySelector('[data-slot="queue-detail"]')?.textContent).toContain(t("w5Studio.mod.pick"));
    expect(screen.getByTestId("mod-held-status").textContent).toBe("2 held messages");
    // Chat and the mod log are still there.
    expect(screen.getByTestId("fake-chat")).toBeTruthy();
    expect(screen.getByTestId("mod-log")).toBeTruthy();
  });

  it("an empty queue says nothing is waiting, in the list and the detail pane", async () => {
    wrap(view(client([])));
    await waitFor(() => expect(screen.getByTestId("held-queue-empty")).toBeTruthy());
    expect(queue().querySelector('[data-slot="queue-detail"]')?.textContent).toContain(t("w5Studio.mod.none"));
  });

  it("Review opens the message in full; the list hides below lg and Back returns to it", async () => {
    wrap(view(client()));
    await waitFor(() => expect(opens()).toHaveLength(2));
    fireEvent.click(opens()[1] as HTMLElement);
    const detail = await screen.findByTestId("mod-held-detail");
    expect(detail.getAttribute("data-id")).toBe("m2");
    expect(detail.textContent).toContain("User m2");
    expect(detail.textContent).toContain("@userm2");
    expect(detail.textContent).toContain("spam link");
    expect(queue().getAttribute("data-open")).toBe("true");
    // Below lg the list gives way to the open message (QueueLayout's list-only view).
    expect(queue().querySelector('[data-slot="queue-list"]')?.className).toContain("hidden");
    expect(opens()[1]?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText(t("w5Studio.mod.back")));
    expect(screen.queryByTestId("mod-held-detail")).toBeNull();
    expect(queue().getAttribute("data-open")).toBe("false");
  });

  it("the detail allows and denies; the resolved message closes", async () => {
    const c = client();
    wrap(view(c));
    await waitFor(() => expect(opens()).toHaveLength(2));
    fireEvent.click(opens()[0] as HTMLElement);
    fireEvent.click(await screen.findByTestId("mod-held-detail-allow"));
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(1));
    expect(c.held.resolve).toHaveBeenCalledWith("aurora", "m1", true);
    expect(screen.queryByTestId("mod-held-detail")).toBeNull();
    fireEvent.click(opens()[0] as HTMLElement);
    fireEvent.click(await screen.findByTestId("mod-held-detail-deny"));
    await waitFor(() => expect(screen.queryAllByTestId("held-message")).toHaveLength(0));
    expect(c.held.resolve).toHaveBeenCalledWith("aurora", "m2", false);
  });

  it("allowing in place from the row still works with another message open", async () => {
    const c = client();
    wrap(view(c));
    await waitFor(() => expect(opens()).toHaveLength(2));
    fireEvent.click(opens()[0] as HTMLElement);
    fireEvent.click(screen.getAllByTestId("held-deny")[1] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(1));
    expect(c.held.resolve).toHaveBeenCalledWith("aurora", "m2", false);
    expect(screen.getByTestId("mod-held-detail").getAttribute("data-id")).toBe("m1");
  });

  it("j and k move between the Review buttons, Enter opens natively, e reaches the decision", async () => {
    wrap(view(client()));
    await waitFor(() => expect(opens()).toHaveLength(2));
    const [first, second] = opens();
    expect(first?.hasAttribute("data-queue-row")).toBe(true);
    // The buttons are native, so Enter on the focused one opens it.
    expect(first?.tagName).toBe("BUTTON");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(document.body, { key: "k" });
    expect(document.activeElement).toBe(first);
    fireEvent.click(first as HTMLElement);
    await screen.findByTestId("mod-held-detail");
    fireEvent.keyDown(document.body, { key: "e" });
    expect(document.activeElement).toBe(screen.getByTestId("mod-held-detail-allow"));
  });

  it("the ? dialog lists the queue's keys", () => {
    expect(heldShortcuts().items.map((i) => i.keys.join(" "))).toEqual(["j", "k", "Enter", "e", "?"]);
  });

  it("allowing the open message from its row closes the detail too", async () => {
    const c = client();
    wrap(view(c));
    await waitFor(() => expect(opens()).toHaveLength(2));
    fireEvent.click(opens()[1] as HTMLElement);
    await screen.findByTestId("mod-held-detail");
    fireEvent.click(screen.getAllByTestId("held-allow")[1] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId("held-message")).toHaveLength(1));
    expect(screen.queryByTestId("mod-held-detail")).toBeNull();
    expect(c.held.resolve).toHaveBeenCalledWith("aurora", "m2", true);
  });
});
