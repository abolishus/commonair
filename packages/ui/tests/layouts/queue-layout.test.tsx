// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * QueueLayout (overhaul wave 4, D7.5): the list beside the open item at lg and up, the list or
 * the item below lg with Back, the bulk bar, and the keyboard (j/k, e, ?) that never fires while
 * a text field or dialog has focus. Also the AdminPage width rule and the admin nav's Overview.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { AdminPage, AdminShell, QueueLayout, nextRowIndex, ownsKeys } from "../../src/layouts/index.ts";

afterEach(cleanup);

const SHORTCUTS = {
  title: "Keyboard shortcuts",
  items: [
    { keys: ["j"], label: "Next" },
    { keys: ["?"], label: "Help" },
  ],
};

function Queue({ open = false, bulk }: { open?: boolean; bulk?: React.ReactNode }) {
  const [opened, setOpened] = React.useState<string | null>(open ? "b" : null);
  return (
    <QueueLayout
      listLabel="Cases"
      detailLabel="Case detail"
      backLabel="Back to the queue"
      detailEmpty="Pick a case"
      count={<span>3 results</span>}
      filters={<input aria-label="Search" />}
      list={["a", "b", "c"].map((id) => (
        <button key={id} type="button" data-queue-row="" onClick={() => setOpened(id)}>
          {`Open ${id}`}
        </button>
      ))}
      detail={
        opened ? (
          <div>
            <p>{`Case ${opened}`}</p>
            <div data-queue-decision="">
              <button type="button">Clear</button>
            </div>
            <textarea aria-label="Note" />
          </div>
        ) : null
      }
      onBack={() => setOpened(null)}
      bulk={bulk}
      bulkLabel="Bulk actions"
      shortcuts={SHORTCUTS}
    />
  );
}

const key = (k: string, target: Element | Document = document) => fireEvent.keyDown(target, { key: k });

describe("nextRowIndex", () => {
  test("starts at an end, then moves and stops at the edges", () => {
    expect(nextRowIndex(0, -1, 1)).toBe(-1);
    expect(nextRowIndex(3, -1, 1)).toBe(0);
    expect(nextRowIndex(3, -1, -1)).toBe(2);
    expect(nextRowIndex(3, 0, 1)).toBe(1);
    expect(nextRowIndex(3, 2, 1)).toBe(2);
    expect(nextRowIndex(3, 0, -1)).toBe(0);
  });
});

describe("ownsKeys", () => {
  test("text fields, selects and dialogs keep their keys; buttons do not", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    expect(ownsKeys(input)).toBe(true);
    expect(ownsKeys(document.createElement("textarea"))).toBe(true);
    expect(ownsKeys(inside)).toBe(true);
    expect(ownsKeys(button)).toBe(false);
    expect(ownsKeys(null)).toBe(false);
  });
});

describe("QueueLayout", () => {
  test("names its regions; the list is sunken and 384 px at lg", () => {
    render(<Queue />);
    const list = screen.getByRole("region", { name: "Cases" });
    expect(list.className).toContain("lg:w-96");
    expect(list.className).toContain("bg-surface-sunken");
    expect(screen.getByRole("region", { name: "Case detail" }).textContent).toContain("Pick a case");
  });

  test("below lg an open item replaces the list, and Back returns to it", () => {
    render(<Queue />);
    const list = screen.getByRole("region", { name: "Cases" });
    expect(list.className).toMatch(/(^|\s)flex(\s|$)/);
    fireEvent.click(screen.getByText("Open b"));
    expect(list.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(list.className).toContain("lg:flex");
    fireEvent.click(screen.getByRole("button", { name: "Back to the queue" }));
    expect(screen.getByRole("region", { name: "Case detail" }).textContent).toContain("Pick a case");
  });

  test("j and k move focus between rows; Enter on a row opens it natively", () => {
    render(<Queue />);
    key("j");
    expect(document.activeElement?.textContent).toBe("Open a");
    key("j", document.activeElement ?? document);
    expect(document.activeElement?.textContent).toBe("Open b");
    key("k", document.activeElement ?? document);
    expect(document.activeElement?.textContent).toBe("Open a");
  });

  test("e focuses the decision; no shortcut fires inside a text field", () => {
    render(<Queue open />);
    key("e");
    expect(document.activeElement?.textContent).toBe("Clear");
    const note = screen.getByRole("textbox", { name: "Note" });
    note.focus();
    key("j", note);
    key("e", note);
    expect(document.activeElement).toBe(note);
    const search = screen.getByRole("textbox", { name: "Search" });
    search.focus();
    key("?", search);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("? lists the shortcuts in a dialog", async () => {
    render(<Queue />);
    key("?");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Keyboard shortcuts");
    expect(dialog.textContent).toContain("Next");
  });

  test("modifier keys and keyboard={false} leave the page alone", () => {
    const { rerender } = render(<Queue />);
    fireEvent.keyDown(document, { key: "j", ctrlKey: true });
    expect(document.activeElement).toBe(document.body);
    rerender(
      <QueueLayout
        keyboard={false}
        listLabel="Cases"
        detailLabel="Detail"
        backLabel="Back"
        list={
          <button type="button" data-queue-row="">
            Row
          </button>
        }
        detail={null}
      />,
    );
    key("j");
    expect(document.activeElement).toBe(document.body);
  });

  test("the bulk bar shows only with content, as a named region", () => {
    const { rerender } = render(<Queue />);
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
    rerender(<Queue bulk={<span>2 selected</span>} />);
    expect(screen.getByRole("region", { name: "Bulk actions" }).textContent).toBe("2 selected");
  });
});

describe("AdminPage and AdminShell", () => {
  test("the width rule: queues 1120, forms 768, boards full", () => {
    render(
      <>
        <AdminPage width="queue">q</AdminPage>
        <AdminPage width="form">f</AdminPage>
        <AdminPage width="full">b</AdminPage>
      </>,
    );
    expect(screen.getByText("q").className).toContain("max-w-form-page");
    expect(screen.getByText("f").className).toContain("max-w-form");
    expect(screen.getByText("f").className).not.toContain("max-w-form-page");
    expect(screen.getByText("b").className).toContain("max-w-page");
    expect(screen.getByText("q").getAttribute("data-width")).toBe("queue");
  });

  test("Overview sits above every group", () => {
    const onClick = vi.fn<() => void>();
    render(
      <AdminShell
        header={<header>h</header>}
        overview={{ id: "overview", label: "Overview", href: "/admin", current: true }}
        groups={[{ id: "safety", label: "Safety", items: [{ id: "moderation", label: "Moderation", href: "/m" }] }]}
        sidebarLabel="Admin"
        skipLabel="Skip"
      >
        <button type="button" onClick={onClick}>
          content
        </button>
      </AdminShell>,
    );
    const links = screen.getAllByRole("link").map((a) => a.textContent);
    expect(links.indexOf("Overview")).toBeLessThan(links.indexOf("Moderation"));
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  });
});
