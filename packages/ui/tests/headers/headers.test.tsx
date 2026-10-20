// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, test, vi } from "vite-plus/test";
import { Breadcrumbs, PageHeader, PageTabs, Section } from "../../src/blocks/headers/index.ts";
test("PageHeader renders title, description, meta, actions, and slots", () => {
  render(
    <PageHeader
      title="Settings"
      description="Preferences"
      meta="Updated"
      actions={<button>Save</button>}
      breadcrumbs={<span>Home</span>}
      tabs={<span>Tabs</span>}
      data-testid="page-header"
    />,
  );
  expect(screen.getByTestId("page-header").textContent).toContain("Settings");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});
test("Section associates its landmark to the heading and forwards data attributes", () => {
  render(
    <Section heading="Recent activity" data-testid="activity">
      <p>Updates</p>
    </Section>,
  );
  const section = screen.getByTestId("activity");
  expect(section.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { name: "Recent activity" }).id);
});
test("Breadcrumbs collapse long trails behind an accessible menu", () => {
  render(
    <Breadcrumbs
      label="Breadcrumbs"
      items={["Home", "A", "B", "C", "Current"].map((label) => ({ label, href: `/${label}` }))}
    />,
  );
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Home" })).toBeTruthy();
  expect(screen.getByText("Current")).toBeTruthy();
  expect(screen.queryByText("B")).toBeNull();
});
test("PageTabs route links expose current state", () => {
  render(
    <PageTabs
      items={[
        { id: "overview", label: "Overview", href: "/overview", current: true },
        { id: "activity", label: "Activity", href: "/activity", count: 4 },
      ]}
    />,
  );
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("tab", { name: "Activity 4" })).toBeTruthy();
});
test("PageTabs panel mode renders panel content", () => {
  render(
    <PageTabs
      value="account"
      onValueChange={() => undefined}
      items={[
        { id: "account", label: "Account", content: <p>Account panel</p> },
        { id: "security", label: "Security", content: <p>Security panel</p> },
      ]}
    />,
  );
  expect(screen.getByText("Account panel")).toBeTruthy();
  expect(screen.queryByText("Security panel")).toBeNull();
});

test("PageTabs forwards per-tab disabled, test ids and descriptions to the triggers", () => {
  const change = vi.fn<(value: string) => void>();
  render(
    <PageTabs
      aria-label="Support options"
      variant="default"
      fullWidth
      value="tip"
      onValueChange={change}
      afterList={<p id="why">Add a tier first.</p>}
      items={[
        { id: "sub", label: "Subscribe", disabled: true, "data-testid": "tab-sub", "aria-describedby": "why" },
        { id: "tip", label: "Tip", "data-testid": "tab-tip", content: <p>Tip panel</p> },
      ]}
    />,
  );
  const list = screen.getByRole("tablist", { name: "Support options" });
  expect(list.className).toContain("w-full");
  const sub = screen.getByTestId("tab-sub");
  expect(sub).toBe(screen.getByRole("tab", { name: "Subscribe" }));
  expect(sub.getAttribute("aria-describedby")).toBe("why");
  expect(sub.hasAttribute("disabled") || sub.getAttribute("aria-disabled") === "true").toBe(true);
  expect(screen.getByTestId("tab-tip").getAttribute("aria-describedby")).toBeNull();
  fireEvent.click(sub);
  expect(change).not.toHaveBeenCalled();
  // The note sits between the list and the panels, outside any panel.
  const note = screen.getByText("Add a tier first.");
  expect(note.closest('[role="tabpanel"]')).toBeNull();
  expect(list.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("Tip panel")).toBeTruthy();
});
test("PageTabs keeps the tab list in its own horizontal scroller", () => {
  render(<PageTabs items={[{ id: "a", label: "A", href: "/a", current: true }]} />);
  const scroller = screen.getByRole("tablist").parentElement;
  expect(scroller?.className).toContain("overflow-x-auto");
  expect(screen.getByRole("tablist").className).not.toContain("w-full");
});
test("PageTabs line variant pads its scroller so the active underline is not clipped", () => {
  const { rerender } = render(<PageTabs items={[{ id: "a", label: "A", href: "/a", current: true }]} />);
  expect(screen.getByRole("tablist").parentElement?.className).toContain("pb-1.5");
  rerender(<PageTabs variant="default" items={[{ id: "a", label: "A", href: "/a", current: true }]} />);
  expect(screen.getByRole("tablist").parentElement?.className).not.toContain("pb-1.5");
});
test("PageTabs arrow keys never select a disabled tab", async () => {
  const user = userEvent.setup();
  const change = vi.fn<(value: string) => void>();
  render(
    <PageTabs
      value="a"
      onValueChange={change}
      items={[
        { id: "a", label: "A", content: <p>A panel</p> },
        { id: "b", label: "B", disabled: true, content: <p>B panel</p> },
        { id: "c", label: "C", content: <p>C panel</p> },
      ]}
    />,
  );
  const tab = (name: string) => screen.getByRole("tab", { name });
  await user.click(tab("A"));
  await user.keyboard("{ArrowRight}");
  // Base UI keeps disabled tabs focusable (screen readers can reach them and hear the reason).
  expect(document.activeElement).toBe(tab("B"));
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  // Focus is on B, but B is never selected or shown.
  expect(tab("B").getAttribute("aria-selected")).toBe("false");
  expect(tab("A").getAttribute("aria-selected")).toBe("true");
  expect(change.mock.calls.map(([value]) => value)).not.toContain("b");
  expect(screen.queryByText("B panel")).toBeNull();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(tab("C"));
});
